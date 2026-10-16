const COLUMNS = 'id, admin_id, action, target_user_id, target_username, note, created_at';

const tableSql = (name) => `
  CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('suspend', 'unsuspend', 'report_resolve', 'report_dismiss', 'post_remove')),
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_username TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`;

// SQLite cannot widen a CHECK rule in place, so a table that only knows suspensions is rebuilt once.
module.exports = function applyModerationLogSchema(db) {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_actions'").get();

  if (existing && !existing.sql.includes('post_remove')) {
    db.transaction(() => {
      db.exec(tableSql('admin_actions_new'));
      db.exec(`INSERT INTO admin_actions_new (${COLUMNS}) SELECT ${COLUMNS} FROM admin_actions`);
      db.exec('DROP TABLE admin_actions');
      db.exec('ALTER TABLE admin_actions_new RENAME TO admin_actions');
    })();
  }

  if (!existing) db.exec(tableSql('admin_actions'));
  db.exec('CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at)');
};
