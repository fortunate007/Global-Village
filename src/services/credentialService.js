const bcrypt = require('bcryptjs');
const db = require('../db');
const { isValidPassword } = require('../utils/validators');

// Errors safe to show to the user. code is 'wrong_password' or 'invalid'.
class CredentialError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const asText = (value) => (typeof value === 'string' ? value : '');
const epochOf = (userId) => db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(userId).session_epoch;

function verifyCurrent(userId, password) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!row || !bcrypt.compareSync(asText(password), row.password_hash)) {
    throw new CredentialError('Incorrect password.', 'wrong_password');
  }
}

exports.CredentialError = CredentialError;

// Changes the password and invalidates every older session. Returns the new counter, which the
// caller stamps on the session that stays logged in.
exports.changePassword = (userId, current, proposed, confirmation) => {
  verifyCurrent(userId, current);

  const next = asText(proposed);
  if (next !== asText(confirmation)) throw new CredentialError('Passwords do not match.', 'invalid');
  if (!isValidPassword(next)) throw new CredentialError('Password must be 6-72 characters.', 'invalid');
  if (next === asText(current)) throw new CredentialError('Choose a password you are not using now.', 'invalid');

  const hash = bcrypt.hashSync(next, 10);
  return db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(hash, userId);
    return epochOf(userId);
  })();
};

// Logs out every older session without changing the password. Returns the new counter.
exports.revokeOtherSessions = (userId, password) => {
  verifyCurrent(userId, password);
  db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run(userId);
  return epochOf(userId);
};
