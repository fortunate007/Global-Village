const COLUMNS =
  'id, reporter_id, post_id, post_author_id, post_body, reason, details, status, created_at, resolved_at, resolved_by';

// Reports used to be deleted together with the account that filed them. This keeps them: the reporter
// is cleared instead, so the reason, details and the snapshot of the reported text survive.
// SQLite cannot change a foreign key in place, so an old table is rebuilt once, with all its rows.
module.exports = function applyReportsKeepSchema(db) {
  const reporter = db.prepare('PRAGMA table_info(reports)').all().find((c) => c.name === 'reporter_id');
  if (!reporter || !reporter.notnull) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE reports_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
        post_author_id INTEGER,
        post_body TEXT,
        reason TEXT NOT NULL CHECK (reason IN ('spam', 'abuse', 'harassment', 'misinformation', 'other')),
        details TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )`);
    db.exec(`INSERT INTO reports_new (${COLUMNS}) SELECT ${COLUMNS} FROM reports`);
    db.exec('DROP TABLE reports');
    db.exec('ALTER TABLE reports_new RENAME TO reports');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_once
        ON reports(reporter_id, post_id) WHERE post_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
    `);
  })();
};
