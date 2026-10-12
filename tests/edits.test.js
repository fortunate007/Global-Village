const db = require('../src/db');
const posts = require('../src/services/postService');
const search = require('../src/services/searchService');
const discovery = require('../src/services/discoveryService');
const notifications = require('../src/services/notificationService');

let counter = 0;
const makeUser = (name) => {
  counter += 1;
  const username = `${name}${counter}`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name).lastInsertRowid
  );
  return { id, username };
};

const bodyOf = (id) => posts.getThread(id).post.body;
const tagsOf = (id) =>
  db
    .prepare('SELECT h.tag FROM post_hashtags ph JOIN hashtags h ON h.id = ph.hashtag_id WHERE ph.post_id = ? ORDER BY h.tag')
    .all(id)
    .map((r) => r.tag);
const searchIds = (q) => search.search(q).posts.map((p) => p.id);
const age = (id, minutes) =>
  db.prepare("UPDATE posts SET created_at = datetime('now', ?) WHERE id = ?").run(`-${minutes} minutes`, id);

test('the author can edit a post; the old text goes to history and the post is marked edited', () => {
  const a = makeUser('alice');
  const id = posts.createPost(a.id, 'first draft');
  posts.editPost(a.id, id, '  second draft  ');

  const { post } = posts.getThread(id);
  expect(post.body).toBe('second draft');
  expect(post.edited_at).toBeTruthy();
  expect(posts.getHistory(id).map((e) => e.body)).toEqual(['first draft']);

  posts.editPost(a.id, id, 'third draft');
  expect(posts.getHistory(id).map((e) => e.body)).toEqual(['second draft', 'first draft']);
});

test('saving unchanged text records nothing', () => {
  const a = makeUser('alice');
  const id = posts.createPost(a.id, 'same');
  posts.editPost(a.id, id, 'same');
  expect(posts.getHistory(id)).toEqual([]);
  expect(posts.getThread(id).post.edited_at).toBeNull();
});

test('only the author can edit, reposts cannot be edited, and text is validated', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const id = posts.createPost(a.id, 'mine');
  posts.toggleRepost(b.id, id);
  const repostId = db.prepare('SELECT id FROM posts WHERE repost_of_id = ?').get(id).id;

  expect(() => posts.editPost(b.id, id, 'hijack')).toThrow(posts.PostError);
  expect(() => posts.editPost(b.id, repostId, 'x')).toThrow(posts.PostError);
  expect(() => posts.editPost(a.id, id, '   ')).toThrow(posts.PostError);
  expect(() => posts.editPost(a.id, id, 'x'.repeat(281))).toThrow(posts.PostError);
  expect(() => posts.editPost(a.id, 999999, 'x')).toThrow(posts.PostError);
  expect(bodyOf(id)).toBe('mine');
});

test('editing is only allowed during the edit window', () => {
  const a = makeUser('alice');
  const id = posts.createPost(a.id, 'old news');
  age(id, posts.EDIT_WINDOW_MINUTES + 5);

  expect(() => posts.editPost(a.id, id, 'too late')).toThrow(posts.PostError);
  expect(() => posts.getForEdit(a.id, id)).toThrow(posts.PostError);
  expect(bodyOf(id)).toBe('old news');

  const fresh = posts.createPost(a.id, 'new news');
  age(fresh, 5);
  expect(posts.getForEdit(a.id, fresh)).toMatchObject({ id: fresh, body: 'new news' });
  expect(posts.getForEdit(a.id, fresh).minutesLeft).toBeGreaterThan(0);
});

test('search follows edits automatically', () => {
  const a = makeUser('alice');
  const id = posts.createPost(a.id, 'mentioning zeppelins today');
  expect(searchIds('zeppelins')).toContain(id);

  posts.editPost(a.id, id, 'mentioning submarines today');
  expect(searchIds('zeppelins')).not.toContain(id);
  expect(searchIds('submarines')).toContain(id);
  expect(() => db.prepare("INSERT INTO posts_fts(posts_fts) VALUES ('integrity-check')").run()).not.toThrow();
});

test('hashtags are re-synced and orphaned tags disappear', () => {
  const a = makeUser('alice');
  const id = posts.createPost(a.id, 'learning #oldtopic and #keepme');
  expect(tagsOf(id)).toEqual(['keepme', 'oldtopic']);

  posts.editPost(a.id, id, 'learning #newtopic and #keepme');
  expect(tagsOf(id)).toEqual(['keepme', 'newtopic']);
  expect(db.prepare("SELECT 1 FROM hashtags WHERE tag = 'oldtopic'").get()).toBeUndefined();
  expect(discovery.postsByTag('newtopic').map((p) => p.id)).toEqual([id]);
  expect(discovery.postsByTag('oldtopic')).toEqual([]);
});

test('mentions: removed people lose their notification, kept people keep theirs (and read state), new people get one', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const c = makeUser('carol');
  const d = makeUser('dave');
  const id = posts.createPost(a.id, `hi @${b.username} and @${c.username}`);

  notifications.markAllRead(b.id);
  expect(notifications.list(b.id)).toHaveLength(1);
  expect(notifications.list(c.id)).toHaveLength(1);

  posts.editPost(a.id, id, `hi @${b.username} and @${d.username}`);

  const kept = notifications.list(b.id);
  expect(kept).toHaveLength(1);
  expect(kept[0].read_at).toBeTruthy();
  expect(notifications.list(c.id)).toEqual([]);
  expect(notifications.list(d.id).map((n) => n.type)).toEqual(['mention']);
});

test('replies and quotes can be edited too', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const root = posts.createPost(a.id, 'root');
  const reply = posts.reply(b.id, root, 'typo here');
  posts.editPost(b.id, reply, 'fixed here');
  expect(bodyOf(reply)).toBe('fixed here');
  expect(posts.getThread(root).replies[0].edited_at).toBeTruthy();
});

test('deleting a post removes its history', () => {
  const a = makeUser('alice');
  const id = posts.createPost(a.id, 'v1');
  posts.editPost(a.id, id, 'v2');
  posts.deletePost(a.id, id);
  expect(db.prepare('SELECT COUNT(*) AS n FROM post_edits WHERE post_id = ?').get(id).n).toBe(0);
});
