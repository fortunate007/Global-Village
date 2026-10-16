module.exports = function applyEmailVerificationSchema(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('email_pending_verification')) {
    // 1 = registered after this feature existed and has not confirmed the address yet.
    // Accounts that existed before keep the default 0 and behave exactly as they did.
    db.exec('ALTER TABLE users ADD COLUMN email_pending_verification INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    -- Only a hash of each token is stored. email is the address the link was sent to: a link only works
    -- while it still matches the account's address. used_at means used or replaced.
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id, created_at);
  `);
};
