const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const sms = require('./sms');

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_ACCOUNT_PER_HOUR = 3;
const MAX_CODES_PER_NUMBER_PER_DAY = 5;

// Errors safe to show to the user. code is one of: invalid, wrong_password, in_use, rate_limited,
// no_phone, not_pending, bad_code.
class PhoneError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const asText = (value) => (typeof value === 'string' ? value : '');
const BAD_CODE = 'That code is not correct or has expired. Ask for a new one.';
const TOO_MANY = 'Too many codes were sent recently. Please try again later.';

const { normalizePhone } = require('../utils/phoneNumbers');

// Optional allow-list, to stop texts to expensive foreign numbers: PHONE_ALLOWED_COUNTRY_CODES=254,255,256
function countryAllowed(phone) {
  const allowed = (process.env.PHONE_ALLOWED_COUNTRY_CODES || '')
    .split(',')
    .map((code) => code.replace(/\D/g, ''))
    .filter(Boolean);
  return allowed.length === 0 || allowed.some((code) => phone.startsWith(`+${code}`));
}

// +254712345678 -> +•••••••••678
const mask = (phone) => (phone ? String(phone).replace(/\d(?=\d{3})/g, '•') : '');

const makeCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
// Codes are short-lived (10 minutes) and locked after 5 wrong tries, which is what protects them
const hashCode = (phone, code) => crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');
const sameHash = (a, b) => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const verifyText = (code) =>
  `Global Village: your verification code is ${code}. It expires in ${CODE_MINUTES} minutes. Never share it.`;
const resetText = (code) =>
  `Global Village: your password reset code is ${code}. It expires in ${CODE_MINUTES} minutes. If you did not ask for it, ignore this message.`;

// Sending never blocks or fails the request: a failure is logged, and the person can ask for another code
function deliver(phone, text) {
  sms.send({ to: phone, text }).catch((err) => console.error('[phone] could not send the text message', err.message));
}

const takenByOther = (phone, userId) =>
  !!db.prepare('SELECT 1 FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL AND id != ?').get(phone, userId);

// Creates a code and returns it for sending. Call inside a transaction: a limit rolls everything back.
function createCode({ userId, phone, purpose }) {
  db.prepare("DELETE FROM phone_codes WHERE created_at < datetime('now', '-2 days')").run();

  const forAccount = db
    .prepare("SELECT COUNT(*) AS n FROM phone_codes WHERE user_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(userId).n;
  // Per number too, so nobody can use the site to flood someone else's phone with codes
  const forNumber = db
    .prepare("SELECT COUNT(*) AS n FROM phone_codes WHERE phone = ? AND created_at > datetime('now', '-1 day')")
    .get(phone).n;
  if (forAccount >= MAX_CODES_PER_ACCOUNT_PER_HOUR || forNumber >= MAX_CODES_PER_NUMBER_PER_DAY) {
    throw new PhoneError(TOO_MANY, 'rate_limited');
  }

  db.prepare("UPDATE phone_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND purpose = ? AND used_at IS NULL").run(
    userId,
    purpose
  );
  const code = makeCode();
  db.prepare(
    "INSERT INTO phone_codes (user_id, phone, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
  ).run(userId, phone, purpose, hashCode(phone, code), `+${CODE_MINUTES} minutes`);
  return code;
}

// Finds the newest usable code row and checks the guess. A wrong guess counts, and the fifth wrong guess locks the
// code. Returns the row on success and null otherwise (wrong, expired, used and locked all look the same).
// Call inside a transaction, and do not throw before it commits, or the attempt count is rolled back.
function checkLatest(selectSql, params, phone, code) {
  const row = db
    .prepare(`${selectSql} AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`)
    .get(...params);
  if (!row || row.attempts >= MAX_ATTEMPTS) return null;

  if (!sameHash(row.code_hash, hashCode(phone, code))) {
    db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    if (row.attempts + 1 >= MAX_ATTEMPTS) db.prepare('UPDATE phone_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
    return null;
  }
  return row;
}

const cleanCode = (value) => asText(value).replace(/\s/g, '');

exports.PhoneError = PhoneError;
exports.CODE_MINUTES = CODE_MINUTES;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
exports.normalizePhone = normalizePhone;
exports.mask = mask;

// Adds or changes the number on an account (needs the password) and texts a code to it.
// The new number starts unverified, whatever the old one was.
exports.setPhone = (userId, password, phoneInput, country) => {
  const user = db.prepare('SELECT id, password_hash, phone, phone_verified_at FROM users WHERE id = ?').get(userId);
  if (!user) throw new PhoneError('Account not found.', 'invalid');
  if (!bcrypt.compareSync(asText(password), user.password_hash)) throw new PhoneError('Incorrect password.', 'wrong_password');

  const phone = normalizePhone(phoneInput, country);
  if (!phone) {
    throw new PhoneError('Enter a valid phone number for the selected country, or type the full number starting with + and the country code.', 'invalid');
  }
  if (!countryAllowed(phone)) throw new PhoneError('Phone numbers from that country are not supported yet.', 'invalid');
  if (user.phone === phone && user.phone_verified_at) {
    throw new PhoneError('That number is already verified on your account.', 'invalid');
  }
  if (takenByOther(phone, userId)) throw new PhoneError('That phone number is already in use.', 'in_use');

  const code = db.transaction(() => {
    const created = createCode({ userId, phone, purpose: 'verify' });
    db.prepare('UPDATE users SET phone = ?, phone_verified_at = NULL WHERE id = ?').run(phone, userId);
    return created;
  })();
  deliver(phone, verifyText(code));
};

// For the optional phone field on the registration form. Never throws and never blocks registration.
// Returns null (nothing entered), 'sent', 'invalid', 'in_use' or 'unavailable'.
exports.startForNewAccount = (userId, phoneInput, country) => {
  if (typeof phoneInput !== 'string' || !phoneInput.trim()) return null;

  const phone = normalizePhone(phoneInput, country);
  if (!phone || !countryAllowed(phone)) return 'invalid';
  try {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return 'unavailable';
    if (takenByOther(phone, userId)) return 'in_use';

    const code = db.transaction(() => {
      const created = createCode({ userId, phone, purpose: 'verify' });
      db.prepare('UPDATE users SET phone = ?, phone_verified_at = NULL WHERE id = ?').run(phone, userId);
      return created;
    })();
    deliver(phone, verifyText(code));
    return 'sent';
  } catch (err) {
    if (!(err instanceof PhoneError)) console.error('[phone] could not start phone verification', err.message);
    return 'unavailable';
  }
};

// Sends another code to the number on the account while it is still unverified
exports.resend = (userId) => {
  const user = db.prepare('SELECT id, phone, phone_verified_at FROM users WHERE id = ?').get(userId);
  if (!user || !user.phone) throw new PhoneError('Add a phone number first.', 'no_phone');
  if (user.phone_verified_at) throw new PhoneError('Your phone number is already verified.', 'not_pending');

  const code = db.transaction(() => createCode({ userId, phone: user.phone, purpose: 'verify' }))();
  deliver(user.phone, verifyText(code));
};

const confirmTx = db.transaction((userId, code) => {
  const user = db.prepare('SELECT id, phone, phone_verified_at FROM users WHERE id = ?').get(userId);
  if (!user || !user.phone) return { error: ['Add a phone number first.', 'no_phone'] };
  if (user.phone_verified_at) return { error: ['Your phone number is already verified.', 'not_pending'] };

  const row = checkLatest(
    "SELECT id, code_hash, attempts FROM phone_codes WHERE user_id = ? AND purpose = 'verify' AND phone = ?",
    [userId, user.phone],
    user.phone,
    code
  );
  if (!row) return { error: [BAD_CODE, 'bad_code'] };

  try {
    db.prepare("UPDATE phone_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL").run(userId);
    db.prepare('UPDATE users SET phone_verified_at = CURRENT_TIMESTAMP WHERE id = ? AND phone = ?').run(userId, user.phone);
  } catch (err) {
    // Somebody else verified the same number first
    if (/UNIQUE/.test(err.message)) return { error: ['That phone number was just verified by another account.', 'in_use'] };
    throw err;
  }
  return { ok: true };
});

exports.confirm = (userId, codeInput) => {
  const code = cleanCode(codeInput);
  if (!/^\d{6}$/.test(code)) throw new PhoneError('Enter the 6-digit code.', 'bad_code');
  const result = confirmTx(userId, code);
  if (result.error) throw new PhoneError(result.error[0], result.error[1]);
};

// Removes the number from the account (needs the password)
exports.remove = (userId, password) => {
  const user = db.prepare('SELECT id, password_hash, phone FROM users WHERE id = ?').get(userId);
  if (!user) throw new PhoneError('Account not found.', 'invalid');
  if (!bcrypt.compareSync(asText(password), user.password_hash)) throw new PhoneError('Incorrect password.', 'wrong_password');
  if (!user.phone) throw new PhoneError('There is no phone number on your account.', 'no_phone');

  db.transaction(() => {
    db.prepare('UPDATE users SET phone = NULL, phone_verified_at = NULL WHERE id = ?').run(userId);
    db.prepare('UPDATE phone_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(userId);
  })();
};

// ---- Password reset by text message ----

// Texts a reset code to a VERIFIED number. Never throws and never reveals whether the number belongs to an
// account: the caller answers the same way either way.
exports.requestResetCode = (phoneInput) => {
  const phone = normalizePhone(phoneInput);
  if (!phone || !countryAllowed(phone)) return { sent: false };

  const user = db.prepare('SELECT id FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL').get(phone);
  if (!user) return { sent: false };

  let code;
  try {
    code = db.transaction(() => createCode({ userId: user.id, phone, purpose: 'reset' }))();
  } catch (err) {
    if (!(err instanceof PhoneError)) console.error('[phone] could not create a reset code', err.message);
    return { sent: false };
  }
  deliver(phone, resetText(code));
  return { sent: true };
};

const resetTx = db.transaction((phone, code) => {
  const row = checkLatest(
    "SELECT id, user_id, code_hash, attempts FROM phone_codes WHERE purpose = 'reset' AND phone = ?",
    [phone],
    phone,
    code
  );
  if (!row) return null;
  db.prepare('UPDATE phone_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  return row.user_id;
});

// Checks a reset code. Returns the account id on success and uses the code up. Every failure gives the same message.
exports.verifyResetCode = (phoneInput, codeInput) => {
  const phone = normalizePhone(phoneInput);
  const code = cleanCode(codeInput);
  if (!phone || !/^\d{6}$/.test(code)) throw new PhoneError(BAD_CODE, 'bad_code');

  const userId = resetTx(phone, code);
  if (!userId) throw new PhoneError(BAD_CODE, 'bad_code');
  return userId;
};
