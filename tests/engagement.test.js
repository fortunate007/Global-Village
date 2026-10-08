const db = require('../src/db');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');

let alice;
let bob;

beforeAll(() => {
  const insert = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)');
  alice = Number(insert.run('alice', 'alice@example.com', 'x', 'Alice').lastInsertRowid);
  bob = Number(insert.run('bob', 'bob@example.com', 'x', 'Bob').lastInsertRowid);
});

const likeCount = (id) => posts.getThread(id).post.like_count;

test('like toggles on and off and updates the count', () => {
  const id = posts.createPost(alice, 'hello world');
  expect(engagement.toggleLike(bob, id)).toEqual({ active: true });
  expect(likeCount(id)).toBe(1);
  expect(engagement.toggleLike(bob, id)).toEqual({ active: false });
  expect(likeCount(id)).toBe(0);
});

test('liking a repost likes the original post', () => {
  const id = posts.createPost(alice, 'original');
  posts.toggleRepost(bob, id);
  const repostId = db.prepare('SELECT id FROM posts WHERE repost_of_id = ?').get(id).id;
  expect(engagement.toggleLike(alice, repostId)).toEqual({ active: true });
  expect(likeCount(id)).toBe(1);
  expect(engagement.viewerState(alice, [id]).likedIds.has(id)).toBe(true);
});

test('bookmarks list newest first and are private to the user', () => {
  const first = posts.createPost(alice, 'first');
  const second = posts.createPost(alice, 'second');
  engagement.toggleBookmark(bob, first);
  engagement.toggleBookmark(bob, second);
  expect(engagement.listBookmarks(bob).map((p) => p.id)).toEqual([second, first]);
  expect(engagement.listBookmarks(alice)).toEqual([]);
});

test('unknown posts raise a user-facing error', () => {
  expect(() => engagement.toggleLike(bob, 999999)).toThrow(posts.PostError);
});

test('deleting a post removes its likes and bookmarks', () => {
  const id = posts.createPost(alice, 'short lived');
  engagement.toggleLike(bob, id);
  engagement.toggleBookmark(bob, id);
  posts.deletePost(alice, id);
  expect(db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(id).n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE post_id = ?').get(id).n).toBe(0);
});
