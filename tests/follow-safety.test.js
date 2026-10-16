require('../src/app');
const Database = require('better-sqlite3');
const db = require('../src/db');
const safety = require('../src/services/safetyService');
const applyFollowSafety = require('../src/schema/follow-safety');

let counter = 0;
function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_fs`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name).lastInsertRowid
  );
  return { id, username };
}

beforeEach(() => db.exec('DELETE FROM follows; DELETE FROM users;'));

const follow = (a, b) => db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').run(a, b);
const between = (a, b) =>
  db
    .prepare(
      'SELECT COUNT(*) AS n FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)'
    )
    .get(a, b, b, a).n;

test('the protection is installed when the app starts', () => {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('safety_block_follows_ai', 'safety_follow_bi')")
    .all()
    .map((r) => r.name)
    .sort();
  expect(names).toEqual(['safety_block_follows_ai', 'safety_follow_bi']);
});

test('blocking removes follows in both directions, and leaves other follows alone', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const c = makeUser('carol');
  follow(a.id, b.id);
  follow(b.id, a.id);
  follow(a.id, c.id);
  expect(between(a.id, b.id)).toBe(2);

  safety.block(a.id, b.id);

  expect(between(a.id, b.id)).toBe(0);
  expect(between(a.id, c.id)).toBe(1);
});

test('blocked people cannot follow each other, in either direction, until the block is lifted', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  safety.block(a.id, b.id);

  expect(follow(b.id, a.id).changes).toBe(0);
  expect(follow(a.id, b.id).changes).toBe(0);
  expect(between(a.id, b.id)).toBe(0);

  safety.unblock(a.id, b.id);
  expect(follow(b.id, a.id).changes).toBe(1);
  expect(between(a.id, b.id)).toBe(1);
});

test('follows left over from blocks made earlier are cleared when the protection is installed', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const c = makeUser('carol');

  db.exec('DROP TRIGGER safety_block_follows_ai');
  follow(a.id, b.id);
  follow(a.id, c.id);
  db.prepare('INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(b.id, a.id);
  expect(between(a.id, b.id)).toBe(1);

  expect(applyFollowSafety(db)).toBe(true);

  expect(between(a.id, b.id)).toBe(0);
  expect(between(a.id, c.id)).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'safety_block_follows_ai'").get().n).toBe(1);
});

test('a database without a follows table is left alone with a warning', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const empty = new Database(':memory:');

  expect(applyFollowSafety(empty)).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('follow-safety'));
  warn.mockRestore();
  empty.close();
});
