const db = require('../src/db');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');
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

const types = (userId) => notifications.list(userId).map((n) => n.type);

test('liking notifies the author, unliking removes it, self-likes are ignored', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'hello');

  engagement.toggleLike(b.id, post);
  const [n] = notifications.list(a.id);
  expect(n).toMatchObject({ type: 'like', post_id: post, username: b.username });
  expect(notifications.list(b.id)).toEqual([]);

  engagement.toggleLike(b.id, post);
  expect(notifications.list(a.id)).toEqual([]);

  engagement.toggleLike(a.id, post);
  expect(notifications.list(a.id)).toEqual([]);
});

test('replies and quotes notify the original author and link to the new post', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'original');
  const reply = posts.reply(b.id, post, 'a reply');
  const quote = posts.quote(b.id, post, 'a quote');

  const items = notifications.list(a.id);
  expect(items.find((n) => n.type === 'reply').post_id).toBe(reply);
  expect(items.find((n) => n.type === 'quote').post_id).toBe(quote);
});

test('reposting notifies the original author and undoing it removes the notification', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'original');

  posts.toggleRepost(b.id, post);
  expect(types(a.id)).toEqual(['repost']);
  posts.toggleRepost(b.id, post);
  expect(types(a.id)).toEqual([]);
});

test('mentions notify the mentioned user but not the author', () => {
  const a = makeUser('alice');
  const c = makeUser('carol');
  const post = posts.createPost(a.id, `hi @${c.username}`);

  expect(notifications.list(c.id)[0]).toMatchObject({ type: 'mention', post_id: post, username: a.username });
  expect(notifications.list(a.id)).toEqual([]);
});

test('mentioning the person you reply to gives one notification, not two', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'original');
  posts.reply(b.id, post, `thanks @${a.username}`);

  expect(types(a.id)).toEqual(['reply']);
});

test('a reply that mentions a third person notifies both', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const c = makeUser('carol');
  const post = posts.createPost(a.id, 'original');
  posts.reply(b.id, post, `cc @${c.username}`);

  expect(types(a.id)).toEqual(['reply']);
  expect(types(c.id)).toEqual(['mention']);
});

test('unread count and mark-all-read', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'original');
  engagement.toggleLike(b.id, post);
  posts.reply(b.id, post, 'reply');

  expect(notifications.unreadCount(a.id)).toBe(2);
  expect(notifications.markAllRead(a.id)).toBe(2);
  expect(notifications.unreadCount(a.id)).toBe(0);
  expect(notifications.list(a.id).every((n) => n.read_at)).toBe(true);
});

test('deleting a post removes the notifications about it', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'short lived');
  engagement.toggleLike(b.id, post);
  posts.reply(b.id, post, 'reply');
  posts.deletePost(a.id, post);

  expect(notifications.list(a.id)).toEqual([]);
});

test('notifications are listed newest first', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'original');
  engagement.toggleLike(b.id, post);
  posts.reply(b.id, post, 'later');

  expect(types(a.id)).toEqual(['reply', 'like']);
});
