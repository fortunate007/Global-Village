module.exports = function applyPhoneSchema(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!columns.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
  if (!columns.includes('phone_verified_at')) db.exec('ALTER TABLE users ADD COLUMN phone_verified_at DATETIME');

  db.exec(`
    -- One verified owner per number. Unverified numbers may repeat, because nobody has proven them yet.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_verified
      ON users(phone) WHERE phone IS NOT NULL AND phone_verified_at IS NOT NULL;

    -- purpose 'verify' proves a number belongs to its account; 'reset' proves it to reset a password.
    -- used_at means used, replaced or locked out.
    CREATE TABLE IF NOT EXISTS phone_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_phone_codes_user ON phone_codes(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_phone_codes_phone ON phone_codes(phone, created_at);
  `);
};
