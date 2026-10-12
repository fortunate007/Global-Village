const db = require('../src/db');
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

const sendRequest = (from, to) =>
  db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(from, to);

// Mirrors makeFriends() in src/routes/friends.js: friendship rows first, then the request rows are removed
const accept = (a, b) =>
  db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)');
    insert.run(a, b);
    insert.run(b, a);
    db.prepare(
      `DELETE FROM friend_requests
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`
    ).run(a, b, b, a);
  })();

const types = (userId) => notifications.list(userId).map((n) => n.type);

test('a friend request notifies the recipient and links to the requests page', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  sendRequest(a.id, b.id);

  expect(notifications.list(b.id)[0]).toMatchObject({
    type: 'friend_request',
    post_id: null,
    username: a.username,
    href: '/friends/requests',
    verb: 'sent you a friend request',
  });
  expect(notifications.list(a.id)).toEqual([]);
});

test('declining or cancelling a request removes its notification and notifies nobody', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  sendRequest(a.id, b.id);
  db.prepare('DELETE FROM friend_requests WHERE sender_id = ? AND recipient_id = ?').run(a.id, b.id);

  expect(notifications.list(b.id)).toEqual([]);
  expect(notifications.list(a.id)).toEqual([]);
});

test('accepting removes the request notification and tells the sender', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  sendRequest(a.id, b.id);
  accept(b.id, a.id); // bob accepts alice's request

  expect(types(b.id)).toEqual([]);
  expect(notifications.list(a.id)[0]).toMatchObject({
    type: 'friend_accept',
    username: b.username,
    href: '/friends',
    verb: 'accepted your friend request',
  });
});

test('deleting a user with requests and friendships does not throw', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const c = makeUser('carol');
  sendRequest(a.id, b.id);
  accept(b.id, a.id);
  sendRequest(c.id, a.id);

  expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(a.id)).not.toThrow();
  expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(c.id)).not.toThrow();
});
