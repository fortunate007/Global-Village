const db = require('../src/db');
const posts = require('../src/services/postService');
const notifications = require('../src/services/notificationService');
const applyNotificationsSchema = require('../src/schema/notifications');

const makeUser = (username) =>
  Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', username).lastInsertRowid
  );

test('a table from the first version is rebuilt without losing rows, and the new features work', () => {
  const a = makeUser('upgradea');
  const b = makeUser('upgradeb');
  const post = posts.createPost(a, 'old post');

  // Recreate the first-version table (no friend types, post_id NOT NULL) holding one notification
  db.exec('DROP TABLE notifications');
  db.exec(`
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('mention', 'reply', 'quote', 'like', 'repost')),
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      CHECK (user_id != actor_id)
    )`);
  db.prepare("INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'like', ?)").run(a, b, post);

  applyNotificationsSchema(db);

  const kept = notifications.list(a);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ type: 'like', post_id: post });

  // Friend types and triggers work after the rebuild
  db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(b, a);
  expect(notifications.list(a).map((n) => n.type)).toContain('friend_request');

  const reply = posts.reply(b, post, 'new reply');
  expect(notifications.list(a).map((n) => n.type)).toContain('reply');
  expect(reply).toBeGreaterThan(0);
});
