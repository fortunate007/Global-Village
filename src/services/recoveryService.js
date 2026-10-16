const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const mailer = require('./mailer');
const { validate: validatePassword } = require('../utils/passwordPolicy');

const TOKEN_MINUTES = 60;
const MAX_LINKS_PER_HOUR = 3;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes in base64url

// Errors safe to show to the user. code is 'invalid_link' or 'invalid'.
class RecoveryError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const asText = (value) => (typeof value === 'string' ? value : '');
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const logFailure = (what) => (err) => console.error(`[recovery] ${what}`, err.message);

// Links in emails are built from a configured address, never from the request's Host header,
// otherwise an attacker could make the app email a victim a link that points at the attacker's site.
function baseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.trim().replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) return null;
  return `http://localhost:${process.env.PORT || 3000}`;
}

function findValid(token) {
  const text = asText(token);
  if (!TOKEN_FORMAT.test(text)) return null;
  return (
    db
      .prepare(
        `SELECT pr.id, pr.user_id, u.username, u.email
         FROM password_resets pr JOIN users u ON u.id = pr.user_id
         WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > datetime('now')`
      )
      .get(hashOf(text)) || null
  );
}

exports.RecoveryError = RecoveryError;
exports.TOKEN_MINUTES = TOKEN_MINUTES;

// Creates a reset link for the account with this email address and emails it in the background.
// The caller must answer the same way whether or not an account exists, so nothing here is awaited
// and the result is only for tests.
exports.requestReset = (emailInput) => {
  const email = asText(emailInput).trim();
  if (!email || email.length > 254) return { sent: false };

  const user = db.prepare('SELECT id, username, email FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!user) return { sent: false };

  db.prepare("DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 day')").run();

  const recent = db
    .prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(user.id).n;
  if (recent >= MAX_LINKS_PER_HOUR) return { sent: false };

  const base = baseUrl();
  if (!base) {
    console.error('[recovery] APP_URL is not set, so no reset link was created. Set APP_URL to your site address.');
    return { sent: false };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', ?))").run(
    user.id,
    hashOf(token),
    `+${TOKEN_MINUTES} minutes`
  );

  mailer
    .send({
      to: user.email,
      subject: 'Reset your Global Village password',
      text:
        `Hi ${user.username},\n\n` +
        `Someone asked to reset the password for your Global Village account. To choose a new one, open this link:\n\n` +
        `${base}/reset-password/${token}\n\n` +
        `The link works once and expires in ${TOKEN_MINUTES} minutes. If you did not ask for this, ignore this email and your password stays as it is.\n`,
    })
    .catch(logFailure('could not send the reset email'));

  return { sent: true };
};

// True when the link is real, unused and not expired
exports.checkToken = (token) => !!findValid(token);

// Sets the new password, ends every existing session of the account and uses up the link (and any other open
// links). Returns the account id so the caller can close its live connections.
exports.resetPassword = (token, proposed, confirmation) => {
  const row = findValid(token);
  if (!row) throw new RecoveryError('This link is invalid or has expired. Request a new one.', 'invalid_link');

  const next = asText(proposed);
  if (next !== asText(confirmation)) throw new RecoveryError('Passwords do not match.', 'invalid');
  const problems = validatePassword(next, { username: row.username, email: row.email });
  if (problems.length) throw new RecoveryError(problems[0], 'invalid');

  const hash = bcrypt.hashSync(next, 10);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?').run(hash, row.user_id);
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ? AND id != ?').run(row.user_id, row.id);
  })();

  const base = baseUrl();
  mailer
    .send({
      to: row.email,
      subject: 'Your Global Village password was changed',
      text:
        `Hi ${row.username},\n\n` +
        `The password for your Global Village account was just changed, and you were logged out everywhere.\n\n` +
        `If this was you, there is nothing more to do. If it was not, reset your password again right away` +
        (base ? `: ${base}/forgot-password` : '.') +
        '\n',
    })
    .catch(logFailure('could not send the password-changed email'));

  return row.user_id;
};
