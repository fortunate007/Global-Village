module.exports = function applySignupSchema(db) {
  db.exec(`
    -- No account exists until the code is entered. The password is stored only as a hash.
    CREATE TABLE IF NOT EXISTS pending_signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('email', 'phone')),
      destination TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sends INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      code_expires_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL
    );

    -- One row per code sent, so no address or number can be flooded with codes
    CREATE TABLE IF NOT EXISTS signup_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      destination TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_signup_sends_destination ON signup_sends(destination, created_at);
  `);
};
