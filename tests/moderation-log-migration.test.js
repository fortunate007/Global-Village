const db = require('../src/db');
const applyModerationLog = require('../src/schema/moderation-log');

const makeUser = (name) =>
  Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(name, `${name}@example.com`, 'x', name).lastInsertRowid
  );

test('a log table that only knows suspensions is rebuilt with every row intact, and is safe to run again', () => {
  const admin = makeUser('miglogadmin');
  const target = makeUser('miglogtarget');

  // Recreate the table as the suspension patch made it
  db.exec('DROP TABLE admin_actions');
  db.exec(`
    CREATE TABLE admin_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL CHECK (action IN ('suspend', 'unsuspend')),
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_username TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_admin_actions_created ON admin_actions(created_at);
  `);
  const insertOld = db.prepare(
    "INSERT INTO admin_actions (admin_id, action, target_user_id, target_username, note) VALUES (?, 'suspend', ?, 'miglogtarget', ?)"
  );
  const first = Number(insertOld.run(admin, target, 'kept note one').lastInsertRowid);
  const second = Number(insertOld.run(admin, target, 'kept note two').lastInsertRowid);
  expect(() =>
    db.prepare("INSERT INTO admin_actions (action, target_username) VALUES ('post_remove', 'x')").run()
  ).toThrow(/CHECK/);

  applyModerationLog(db);
  applyModerationLog(db); // running it again changes nothing

  const rows = db.prepare('SELECT id, admin_id, action, target_user_id, target_username, note FROM admin_actions ORDER BY id').all();
  expect(rows).toEqual([
    { id: first, admin_id: admin, action: 'suspend', target_user_id: target, target_username: 'miglogtarget', note: 'kept note one' },
    { id: second, admin_id: admin, action: 'suspend', target_user_id: target, target_username: 'miglogtarget', note: 'kept note two' },
  ]);

  // The new kinds of entry are accepted, other values still are not
  const insert = db.prepare('INSERT INTO admin_actions (admin_id, action, target_username, note) VALUES (?, ?, ?, ?)');
  ['suspend', 'unsuspend', 'report_resolve', 'report_dismiss', 'post_remove'].forEach((action) => {
    expect(() => insert.run(admin, action, 'someone', '')).not.toThrow();
  });
  expect(() => insert.run(admin, 'nonsense', 'someone', '')).toThrow(/CHECK/);

  // Ids keep counting up from the old rows, and the index is back
  const next = Number(insert.run(admin, 'suspend', 'someone', '').lastInsertRowid);
  expect(next).toBeGreaterThan(second);
  expect(db.prepare('PRAGMA index_list(admin_actions)').all().map((i) => i.name)).toContain('idx_admin_actions_created');

  // The links to accounts still clear themselves when an account is deleted
  db.prepare('DELETE FROM users WHERE id = ?').run(target);
  expect(db.prepare('SELECT target_user_id FROM admin_actions WHERE id = ?').get(first).target_user_id).toBeNull();
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
