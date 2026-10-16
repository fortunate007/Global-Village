module.exports = function applySuspensionSchema(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('suspended_at')) db.exec('ALTER TABLE users ADD COLUMN suspended_at DATETIME');
  if (!columns.includes('suspended_reason')) db.exec('ALTER TABLE users ADD COLUMN suspended_reason TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL CHECK (action IN ('suspend', 'unsuspend')),
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_username TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(suspended_at) WHERE suspended_at IS NOT NULL;
  `);
};
