module.exports = function applySessionEpochSchema(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('session_epoch')) {
    db.exec('ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0');
  }
};
