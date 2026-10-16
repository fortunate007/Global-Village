const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const mailer = require('./mailer');
const { baseUrl } = require('../utils/appUrl');
const { isValidEmail } = require('../utils/validators');

const TOKEN_HOURS = 24;
const MAX_SENDS_PER_HOUR = 3;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes in base64url

// Errors safe to show to the user. code is one of: invalid, invalid_link, wrong_password,
// not_pending, rate_limited, unavailable.
class VerificationError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const asText = (value) => (typeof value === 'string' ? value : '');
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

// New accounts start unconfirmed everywhere except the test suite, where registration stays as it was
// unless TEST_EMAIL_VERIFICATION is set. That keeps the many tests that register throwaway accounts
// working, while dedicated tests exercise the real behavior.
const enabled = () => process.env.NODE_ENV !== 'test' || Boolean(process.env.TEST_EMAIL_VERIFICATION);

// Marks the account unconfirmed and records a new link. Runs inside a transaction, so a limit or a missing
// site address rolls everything back. Returns the email to send AFTER the transaction has committed.
function prepareLink(user) {
  const base = baseUrl();
  if (!base) {
    throw new VerificationError('Verification emails cannot be sent right now. Please try again later.', 'unavailable');
  }

  db.prepare("DELETE FROM email_verifications WHERE expires_at < datetime('now', '-1 day')").run();

  const recent = db
    .prepare("SELECT COUNT(*) AS n FROM email_verifications WHERE user_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(user.id).n;
  if (recent >= MAX_SENDS_PER_HOUR) {
    throw new VerificationError(
      'A link was sent recently. Check your inbox (and spam folder), or try again in an hour.',
      'rate_limited'
    );
  }

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE users SET email_pending_verification = 1 WHERE id = ?').run(user.id);
  db.prepare(
    "INSERT INTO email_verifications (user_id, email, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))"
  ).run(user.id, user.email, hashOf(token), `+${TOKEN_HOURS} hours`);

  return {
    to: user.email,
    subject: 'Confirm your Global Village email address',
    text:
      `Hi ${user.username},\n\n` +
      `Welcome to Global Village! To confirm that this email address belongs to you, open this link:\n\n` +
      `${base}/verify-email/${token}\n\n` +
      `The link works for ${TOKEN_HOURS} hours. If you did not create an account, ignore this email.\n`,
  };
}

// Sending never blocks or fails the request: a failure is logged, and the person can ask for another link
function deliver(message) {
  mailer.send(message).catch((err) => console.error('[verification] could not send the email', err.message));
}

function findValid(token) {
  const text = asText(token);
  if (!TOKEN_FORMAT.test(text)) return null;
  return (
    db
      .prepare(
        `SELECT ev.id, ev.user_id
         FROM email_verifications ev JOIN users u ON u.id = ev.user_id
         WHERE ev.token_hash = ? AND ev.used_at IS NULL AND ev.expires_at > datetime('now')
           AND u.email = ev.email COLLATE NOCASE`
      )
      .get(hashOf(text)) || null
  );
}

exports.VerificationError = VerificationError;
exports.TOKEN_HOURS = TOKEN_HOURS;

// Called right after registration. Returns true if the account is now waiting for confirmation. It never throws:
// if no link can be sent, the account is left exactly as it was, so nobody is held up by a mail problem.
exports.startForNewAccount = (userId) => {
  if (!enabled()) return false;
  try {
    const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(userId);
    if (!user) return false;
    const message = db.transaction(() => prepareLink(user))();
    deliver(message);
    return true;
  } catch (err) {
    console.error('[verification] could not start email verification', err.message);
    return false;
  }
};

exports.checkToken = (token) => !!findValid(token);

// Confirms the address. Every link of the account is used up. Returns the account id.
exports.confirm = (token) => {
  const row = findValid(token);
  if (!row) throw new VerificationError('This link is invalid or has expired.', 'invalid_link');

  db.transaction(() => {
    db.prepare('UPDATE users SET email_pending_verification = 0 WHERE id = ?').run(row.user_id);
    db.prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(
      row.user_id
    );
  })();
  return row.user_id;
};

// Sends another link to the current address (earlier links keep working until they expire)
exports.resend = (userId) => {
  const user = db
    .prepare('SELECT id, username, email, email_pending_verification AS pending FROM users WHERE id = ?')
    .get(userId);
  if (!user) throw new VerificationError('Account not found.', 'invalid');
  if (!user.pending) throw new VerificationError('Your email address is already confirmed.', 'not_pending');

  const message = db.transaction(() => prepareLink(user))();
  deliver(message);
};

// Fixes a typo in the address of an unconfirmed account. Needs the password, kills every older link and
// counts toward the same 3-emails-per-hour limit, so it cannot be used to send mail to arbitrary people.
exports.changeEmail = (userId, password, newEmail) => {
  const user = db
    .prepare(
      'SELECT id, username, email, password_hash, email_pending_verification AS pending FROM users WHERE id = ?'
    )
    .get(userId);
  if (!user) throw new VerificationError('Account not found.', 'invalid');
  if (!bcrypt.compareSync(asText(password), user.password_hash)) {
    throw new VerificationError('Incorrect password.', 'wrong_password');
  }
  if (!user.pending) {
    throw new VerificationError('Your email address is already confirmed. Changing it is not available yet.', 'not_pending');
  }

  const email = asText(newEmail).trim();
  if (!email || email.length > 254 || !isValidEmail(email)) {
    throw new VerificationError('Please enter a valid email address.', 'invalid');
  }
  if (email.toLowerCase() === user.email.toLowerCase()) {
    throw new VerificationError('That is already the address on your account. Use "Send the link again" instead.', 'invalid');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, userId)) {
    throw new VerificationError('That email address is already in use.', 'invalid');
  }

  let message;
  try {
    message = db.transaction(() => {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, userId);
      db.prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(
        userId
      );
      return prepareLink({ id: userId, username: user.username, email });
    })();
  } catch (err) {
    if (err && /UNIQUE/.test(err.message)) {
      throw new VerificationError('That email address is already in use.', 'invalid');
    }
    throw err;
  }
  deliver(message);
};
