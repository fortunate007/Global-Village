module.exports = function applyIdentitySchema(db) {
  const dupUsers = db
    .prepare('SELECT lower(username) AS name, COUNT(*) AS n FROM users GROUP BY lower(username) HAVING n > 1')
    .all();
  const dupEmails = db
    .prepare('SELECT lower(email) AS email, COUNT(*) AS n FROM users GROUP BY lower(email) HAVING n > 1')
    .all();

  if (dupUsers.length || dupEmails.length) {
    console.warn(
      '[identity] Accounts that differ only by letter case exist, so the case-insensitive unique ' +
        'indexes were NOT created. Usernames: ' + (dupUsers.map((d) => d.name).join(', ') || 'none') +
        '. Emails: ' + (dupEmails.map((d) => d.email).join(', ') || 'none') +
        '. Rename or remove the extra accounts, then restart.'
    );
    return;
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE);
  `);
};
