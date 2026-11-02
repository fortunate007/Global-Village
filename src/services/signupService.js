const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const mailer = require('./mailer');
const sms = require('./sms');
const phoneService = require('./phoneService');
const emailVerification = require('./emailVerificationService');
const { normalizePhone } = require('../utils/phoneNumbers');
const { isValidUsername, isValidEmail, isValidDisplayName } = require('../utils/validators');
const { validate: passwordProblems } = require('../utils/passwordPolicy');

const CODE_MINUTES = 10;
const PENDING_MINUTES = 30;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 3;
const MAX_SENDS_PER_DESTINATION_PER_DAY = 5;
const PLACEHOLDER_DOMAIN = 'phone-signup.invalid';

// Safe to show to the user. errors holds every message (a form can have several mistakes).
// code is one of: invalid, taken, rate_limited, expired, bad_code, locked.
class SignupError extends Error {
  constructor(messages, code = 'invalid') {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list[0]);
    this.errors = list;
    this.code = code;
  }
}

const asText = (value) => (typeof value === 'string' ? value : '');
const makeCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
// Codes are short-lived (10 minutes) and the sign-up is dropped after 5 wrong tries, which is what protects them
const hashCode = (id, code) => crypto.createHash('sha256').update(`${id}:${code}`).digest('hex');
const sameHash = (a, b) => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const logFailure = (what) => (err) => console.error(`[signup] ${what}`, err.message);

// Verification is required everywhere except the test suite (where the many tests that create accounts keep working
// unless TEST_SIGNUP_VERIFICATION is set). REQUIRE_SIGNUP_VERIFICATION=false switches it off in an emergency,
// for example while email and SMS sending are not set up yet.
function enabled() {
  if (String(process.env.REQUIRE_SIGNUP_VERIFICATION || '').toLowerCase() === 'false') return false;
  return process.env.NODE_ENV !== 'test' || Boolean(process.env.TEST_SIGNUP_VERIFICATION);
}

const placeholderEmail = (phone) => `phone-${phone.replace(/\D/g, '')}@${PLACEHOLDER_DOMAIN}`;
const isPlaceholderEmail = (email) => typeof email === 'string' && email.toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);

// Sending never blocks or fails the request: a failure is logged, and the person can ask for another code
function deliver(row, code) {
  if (row.method === 'email') {
    mailer
      .send({
        to: row.email,
        subject: 'Your Global Village verification code',
        text:
          `Hi ${row.username},\n\n` +
          `Your Global Village verification code is ${code}. It works for ${CODE_MINUTES} minutes.\n\n` +
          'Enter it on the sign-up page to finish creating your account. ' +
          'If you did not try to sign up, ignore this email and nothing will be created.\n',
      })
      .catch(logFailure('could not send the verification email'));
  } else {
    sms
      .send({ to: row.phone, text: `Global Village: your sign-up code is ${code}. It expires in ${CODE_MINUTES} minutes. Never share it.` })
      .catch(logFailure('could not send the verification text message'));
  }
}

// Call inside a transaction
function assertDestinationOk(destination, method) {
  const recent = db
    .prepare("SELECT COUNT(*) AS n FROM signup_sends WHERE destination = ? AND created_at > datetime('now', '-1 day')")
    .get(destination).n;
  if (recent >= MAX_SENDS_PER_DESTINATION_PER_DAY) {
    throw new SignupError(
      `Too many codes were sent to that ${method === 'email' ? 'email address' : 'phone number'} recently. Please try again later.`,
      'rate_limited'
    );
  }
}

exports.SignupError = SignupError;
exports.CODE_MINUTES = CODE_MINUTES;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
exports.MAX_SENDS = MAX_SENDS;
exports.enabled = enabled;
exports.isPlaceholderEmail = isPlaceholderEmail;

// Checks the form and, if it is fine, parks the sign-up and sends the code. Creates NO account.
// Returns the id of the waiting sign-up. replaceId is the person's earlier waiting sign-up, which is dropped.
exports.startSignup = (input) => {
  const username = asText(input.username).trim();
  const emailInput = asText(input.email).trim();
  const phoneInput = asText(input.phone).trim();
  const displayName = asText(input.displayName).trim();
  const password = asText(input.password);
  const errors = [];

  if (!username) errors.push('Please choose a username.');
  else if (!isValidUsername(username)) errors.push('Username must be 3-20 characters: letters, numbers, underscores only.');
  if (displayName && !isValidDisplayName(displayName)) errors.push('Display name must be 1-40 characters.');

  if (!emailInput && !phoneInput) errors.push('Enter an email address or a phone number to verify.');

  let email = null;
  if (emailInput) {
    if (emailInput.length > 254 || !isValidEmail(emailInput)) errors.push('Please enter a valid email address.');
    else email = emailInput;
  }

  let phone = null;
  if (phoneInput) {
    const normalized = normalizePhone(phoneInput, input.phoneCountry);
    if (!normalized) {
      errors.push('Enter a valid phone number for the selected country, or type the full number starting with + and the country code.');
    } else if (!phoneService.countryAllowed(normalized)) {
      errors.push('Phone numbers from that country are not supported yet.');
    } else {
      phone = normalized;
    }
  }

  if (!password) {
    errors.push('Please choose a password.');
  } else {
    if (password !== asText(input.confirmPassword)) errors.push('Passwords do not match.');
    passwordProblems(password, { username, email: email || '' }).forEach((message) => errors.push(message));
  }

  if (errors.length) throw new SignupError(errors);

  // With both an email and a phone the person chooses (email by default); with one, that one is used
  const hasEmail = Boolean(emailInput);
  const hasPhone = Boolean(phoneInput);
  let method = 'phone';
  if (hasEmail && hasPhone) method = asText(input.verifyBy).toLowerCase() === 'phone' ? 'phone' : 'email';
  else if (hasEmail) method = 'email';

  const nameTaken = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username);
  const emailTaken = email ? db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email) : null;
  if (nameTaken || emailTaken) throw new SignupError('That username or email is already taken.', 'taken');
  if (phone && db.prepare('SELECT 1 FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL').get(phone)) {
    throw new SignupError('That phone number is already in use.', 'taken');
  }

  const destination = method === 'email' ? email.toLowerCase() : phone;
  const passwordHash = bcrypt.hashSync(password, 10);

  const created = db.transaction(() => {
    if (Number.isInteger(input.replaceId)) db.prepare('DELETE FROM pending_signups WHERE id = ?').run(input.replaceId);
    db.prepare("DELETE FROM pending_signups WHERE expires_at < datetime('now', '-1 day')").run();
    db.prepare("DELETE FROM signup_sends WHERE created_at < datetime('now', '-2 days')").run();
    assertDestinationOk(destination, method);

    const code = makeCode();
    const id = Number(
      db
        .prepare(
          `INSERT INTO pending_signups (username, email, phone, display_name, password_hash, method, destination, code_hash,
                                        code_expires_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'x', datetime('now', ?), datetime('now', ?))`
        )
        .run(username, email, phone, displayName || username, passwordHash, method, destination, `+${CODE_MINUTES} minutes`, `+${PENDING_MINUTES} minutes`)
        .lastInsertRowid
    );
    db.prepare('UPDATE pending_signups SET code_hash = ? WHERE id = ?').run(hashCode(id, code), id);
    db.prepare('INSERT INTO signup_sends (destination) VALUES (?)').run(destination);
    return { id, code, row: { method, email, phone, username } };
  })();

  deliver(created.row, created.code);
  return created.id;
};

// The waiting sign-up, or null if it is unknown or has expired
exports.getPending = (id) =>
  Number.isInteger(id)
    ? db.prepare("SELECT * FROM pending_signups WHERE id = ? AND expires_at > datetime('now')").get(id) || null
    : null;

exports.cancel = (id) => {
  if (Number.isInteger(id)) db.prepare('DELETE FROM pending_signups WHERE id = ?').run(id);
};

// Sends a fresh code (the old one stops working). At most 3 codes per sign-up.
exports.resend = (id) => {
  const row = exports.getPending(id);
  if (!row) throw new SignupError('Your sign-up expired. Please start again.', 'expired');
  if (row.sends >= MAX_SENDS) throw new SignupError('The maximum number of codes was sent. Please start again.', 'rate_limited');

  const code = db.transaction(() => {
    assertDestinationOk(row.destination, row.method);
    const fresh = makeCode();
    db.prepare(
      "UPDATE pending_signups SET code_hash = ?, attempts = 0, sends = sends + 1, code_expires_at = datetime('now', ?) WHERE id = ?"
    ).run(hashCode(row.id, fresh), `+${CODE_MINUTES} minutes`, row.id);
    db.prepare('INSERT INTO signup_sends (destination) VALUES (?)').run(row.destination);
    return fresh;
  })();
  deliver(row, code);
};

// The attempt counter must survive a failed guess, so this returns the error instead of throwing inside the transaction
const verifyTx = db.transaction((id, code) => {
  const row = Number.isInteger(id)
    ? db
        .prepare(
          "SELECT *, (code_expires_at > datetime('now')) AS code_live FROM pending_signups WHERE id = ? AND expires_at > datetime('now')"
        )
        .get(id)
    : null;
  if (!row) return { error: ['Your sign-up expired. Please start again.', 'expired'] };
  if (!row.code_live) return { error: ['That code has expired. Ask for a new one.', 'bad_code'] };

  if (!sameHash(row.code_hash, hashCode(row.id, code))) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      db.prepare('DELETE FROM pending_signups WHERE id = ?').run(row.id);
      return { error: ['Too many wrong codes. Please start again.', 'locked'] };
    }
    db.prepare('UPDATE pending_signups SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { error: ['That code is not correct.', 'bad_code'] };
  }

  // The code is right: the account is created now, in the same step that uses the sign-up up
  const email = row.email || placeholderEmail(row.phone);
  const nameOrEmailTaken = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(row.username, email);
  const phoneTaken =
    row.method === 'phone' && db.prepare('SELECT 1 FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL').get(row.phone);
  if (nameOrEmailTaken || phoneTaken) {
    db.prepare('DELETE FROM pending_signups WHERE id = ?').run(row.id);
    return { error: ['That username, email address or phone number was just taken. Please start again.', 'taken'] };
  }

  const verifiedAt = db.prepare("SELECT datetime('now') AS t").get().t;
  const byPhone = row.method === 'phone';
  const info = db
    .prepare(
      `INSERT INTO users (username, email, password_hash, display_name, email_pending_verification, phone, phone_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(row.username, email, row.password_hash, row.display_name, row.method === 'email' ? 0 : 1, byPhone ? row.phone : null, byPhone ? verifiedAt : null);
  db.prepare('DELETE FROM pending_signups WHERE id = ?').run(row.id);
  return { userId: Number(info.lastInsertRowid), row };
});

// Checks the code and, if it is right, creates the account. Returns { userId, method }.
exports.verify = (id, codeInput) => {
  const code = asText(codeInput).replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new SignupError('Enter the 6-digit code.', 'bad_code');

  const outcome = verifyTx(id, code);
  if (outcome.error) throw new SignupError(outcome.error[0], outcome.error[1]);

  // The contact that was not used for verifying is added unverified and gets its usual verification
  const { userId, row } = outcome;
  if (row.method === 'email' && row.phone) phoneService.startForNewAccount(userId, row.phone);
  if (row.method === 'phone' && row.email) emailVerification.startForNewAccount(userId);
  return { userId, method: row.method };
};

// What the verification page shows instead of the full address or number
exports.maskDestination = (row) => {
  if (row.method === 'phone') return phoneService.mask(row.phone);
  const [local, domain] = String(row.email).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};
