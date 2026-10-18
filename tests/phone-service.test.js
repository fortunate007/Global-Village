process.env.APP_URL = 'https://app.test';

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const sms = require('../src/services/sms');
const phones = require('../src/services/phoneService');
const recovery = require('../src/services/recoveryService');

const PASSWORD = 'old-secret-1';
let counter = 0;
let numberCounter = 0;

function makeUser() {
  counter += 1;
  const username = `ph_${counter}_u`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, bcrypt.hashSync(PASSWORD, 10), username).lastInsertRowid
  );
  return { id, username };
}

const local = () => `07${String(10000000 + (numberCounter += 1))}`;
const intl = (number) => `+254${number.slice(1)}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const codeFrom = (message) => message.text.match(/\b(\d{6})\b/)[1];
const lastSms = () => sms.outbox[sms.outbox.length - 1];
const wrongFor = (code) => (code === '000000' ? '111111' : '000000');
const userRow = (id) => db.prepare('SELECT phone, phone_verified_at FROM users WHERE id = ?').get(id);
const codesFor = (id) => db.prepare('SELECT * FROM phone_codes WHERE user_id = ? ORDER BY id').all(id);
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

function verifiedUser(number = local()) {
  const user = makeUser();
  db.prepare('UPDATE users SET phone = ?, phone_verified_at = CURRENT_TIMESTAMP WHERE id = ?').run(intl(number), user.id);
  return { ...user, number, phone: intl(number) };
}

async function pendingUser(number = local()) {
  const user = makeUser();
  phones.setPhone(user.id, PASSWORD, number);
  await flush();
  return { ...user, number, phone: intl(number), code: codeFrom(lastSms()) };
}

beforeEach(() => sms.clearOutbox());

describe('normalizePhone', () => {
  test.each([
    ['0712 345 678', undefined, '+254712345678'],
    ['0712345678', 'KE', '+254712345678'],
    ['712345678', 'KE', '+254712345678'],
    ['+254 712-345-678', undefined, '+254712345678'],
    ['00254712345678', undefined, '+254712345678'],
    ['  +254712345678  ', 'US', '+254712345678'],
    ['(213) 373-4253', 'US', '+12133734253'],
    ['020 8765 4321', 'GB', '+442087654321'],
    ['0802 123 4567', 'NG', '+2348021234567'],
  ])('%j (country %s) becomes %s', (input, country, expected) => {
    expect(phones.normalizePhone(input, country)).toBe(expected);
  });

  test.each(['', '   ', '12345', 'abc', '+0123456789', 'x'.repeat(40)])('%j is refused', (input) => {
    expect(phones.normalizePhone(input)).toBeNull();
  });

  test('anything that is not text is refused', () => {
    [undefined, null, 712345678, ['0712345678'], {}].forEach((value) => expect(phones.normalizePhone(value)).toBeNull());
  });

  test('numbers typed without a country use the configured default country', () => {
    const saved = process.env.DEFAULT_PHONE_COUNTRY;
    process.env.DEFAULT_PHONE_COUNTRY = 'UG';
    try {
      expect(phones.normalizePhone('0712345678')).toBe('+256712345678');
    } finally {
      if (saved === undefined) delete process.env.DEFAULT_PHONE_COUNTRY;
      else process.env.DEFAULT_PHONE_COUNTRY = saved;
    }
  });

  test('numbers are masked for display', () => {
    expect(phones.mask('+254712345678')).toBe('+•••••••••678');
    expect(phones.mask(null)).toBe('');
    expect(phones.mask(undefined)).toBe('');
  });
});

describe('adding a number', () => {
  test('a wrong password or a bad number changes nothing and sends nothing', async () => {
    const user = makeUser();

    expect(errorOf(() => phones.setPhone(user.id, 'wrong-password', local())).code).toBe('wrong_password');
    ['', 'abc', '12345', undefined, 12345].forEach((value) => {
      expect(errorOf(() => phones.setPhone(user.id, PASSWORD, value)).code).toBe('invalid');
    });
    expect(errorOf(() => phones.setPhone(999999, PASSWORD, local()))).toBeInstanceOf(phones.PhoneError);

    await flush();
    expect(userRow(user.id)).toEqual({ phone: null, phone_verified_at: null });
    expect(sms.outbox).toEqual([]);
    expect(codesFor(user.id)).toEqual([]);
  });

  test('a good number is saved unverified, a code is texted and only its hash is stored', async () => {
    const user = makeUser();
    const number = local();
    phones.setPhone(user.id, PASSWORD, number);
    await flush();

    expect(userRow(user.id)).toEqual({ phone: intl(number), phone_verified_at: null });
    expect(sms.outbox).toHaveLength(1);
    expect(lastSms().to).toBe(intl(number));
    expect(lastSms().text).toMatch(/verification code is \d{6}/);

    const code = codeFrom(lastSms());
    const rows = codesFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'verify', phone: intl(number), attempts: 0, used_at: null });
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(db.prepare("SELECT expires_at > datetime('now') AS live FROM phone_codes WHERE user_id = ?").get(user.id).live).toBe(1);
  });

  test('the allowed-countries setting refuses other countries', () => {
    const saved = process.env.PHONE_ALLOWED_COUNTRY_CODES;
    process.env.PHONE_ALLOWED_COUNTRY_CODES = '254, 255';
    try {
      const user = makeUser();
      const error = errorOf(() => phones.setPhone(user.id, PASSWORD, '+12133734253'));
      expect(error.code).toBe('invalid');
      expect(error.message).toMatch(/not supported/);
      expect(() => phones.setPhone(user.id, PASSWORD, local())).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.PHONE_ALLOWED_COUNTRY_CODES;
      else process.env.PHONE_ALLOWED_COUNTRY_CODES = saved;
    }
  });

  test('a number that another account has verified is refused, but unverified numbers may repeat', async () => {
    const owner = verifiedUser();
    const other = makeUser();
    expect(errorOf(() => phones.setPhone(other.id, PASSWORD, owner.number)).code).toBe('in_use');
    expect(userRow(other.id).phone).toBeNull();

    const shared = local();
    const first = makeUser();
    const second = makeUser();
    phones.setPhone(first.id, PASSWORD, shared);
    phones.setPhone(second.id, PASSWORD, shared);
    await flush();
    expect(sms.outbox).toHaveLength(2);
    const [codeA, codeB] = sms.outbox.map(codeFrom);

    phones.confirm(first.id, codeA);
    expect(userRow(first.id).phone_verified_at).toBeTruthy();

    // The other account can no longer prove the same number
    const error = errorOf(() => phones.confirm(second.id, codeB));
    expect(error.code).toBe('in_use');
    expect(userRow(second.id).phone_verified_at).toBeNull();
  });

  test('changing the number starts again and the old codes stop working', async () => {
    const user = await pendingUser();
    const oldCode = user.code;
    const newNumber = local();

    phones.setPhone(user.id, PASSWORD, newNumber);
    await flush();
    expect(userRow(user.id)).toEqual({ phone: intl(newNumber), phone_verified_at: null });

    expect(errorOf(() => phones.confirm(user.id, oldCode)).code).toBe('bad_code');
    phones.confirm(user.id, codeFrom(lastSms()));
    expect(userRow(user.id).phone_verified_at).toBeTruthy();

    // A verified number can be replaced, which drops the verification until the new one is confirmed
    const third = local();
    phones.setPhone(user.id, PASSWORD, third);
    expect(userRow(user.id)).toEqual({ phone: intl(third), phone_verified_at: null });
  });

  test('the same verified number cannot be added again', async () => {
    const user = await pendingUser();
    phones.confirm(user.id, user.code);
    expect(errorOf(() => phones.setPhone(user.id, PASSWORD, user.number)).code).toBe('invalid');
  });

  test('a failing text message is logged and never thrown', async () => {
    const user = makeUser();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const send = jest.spyOn(sms, 'send').mockRejectedValue(new Error('provider down'));

    expect(() => phones.setPhone(user.id, PASSWORD, local())).not.toThrow();
    await flush();

    expect(error).toHaveBeenCalledWith('[phone] could not send the text message', 'provider down');
    expect(userRow(user.id).phone).not.toBeNull();
    send.mockRestore();
    error.mockRestore();
  });
});

describe('confirming a number', () => {
  test('the right code verifies, and the code cannot be used twice', async () => {
    const user = await pendingUser();
    phones.confirm(user.id, user.code);

    expect(userRow(user.id).phone_verified_at).toBeTruthy();
    expect(codesFor(user.id).every((row) => row.used_at)).toBe(true);
    expect(errorOf(() => phones.confirm(user.id, user.code)).code).toBe('not_pending');
  });

  test('spaces inside the code are fine, malformed codes are refused and do not count as attempts', async () => {
    const user = await pendingUser();
    ['', 'abc', '12345', '1234567', undefined, null, 123456].forEach((value) => {
      expect(errorOf(() => phones.confirm(user.id, value)).code).toBe('bad_code');
    });
    expect(codesFor(user.id)[0].attempts).toBe(0);

    phones.confirm(user.id, `${user.code.slice(0, 3)} ${user.code.slice(3)}`);
    expect(userRow(user.id).phone_verified_at).toBeTruthy();
  });

  test('wrong codes are counted, and the fifth wrong one locks the code for good', async () => {
    const user = await pendingUser();
    const wrong = wrongFor(user.code);

    for (let i = 1; i <= 4; i += 1) {
      expect(errorOf(() => phones.confirm(user.id, wrong)).code).toBe('bad_code');
      expect(codesFor(user.id)[0].attempts).toBe(i);
    }
    expect(errorOf(() => phones.confirm(user.id, wrong)).code).toBe('bad_code');

    expect(errorOf(() => phones.confirm(user.id, user.code)).code).toBe('bad_code');
    expect(userRow(user.id).phone_verified_at).toBeNull();

    // Asking for a new code starts fresh
    phones.resend(user.id);
    phones.confirm(user.id, codeFrom(lastSms()));
    expect(userRow(user.id).phone_verified_at).toBeTruthy();
  });

  test('an expired code is refused', async () => {
    const user = await pendingUser();
    db.prepare("UPDATE phone_codes SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(user.id);
    expect(errorOf(() => phones.confirm(user.id, user.code)).code).toBe('bad_code');
    expect(userRow(user.id).phone_verified_at).toBeNull();
  });

  test('accounts without a number, and unknown accounts, are refused', () => {
    const user = makeUser();
    expect(errorOf(() => phones.confirm(user.id, '123456')).code).toBe('no_phone');
    expect(errorOf(() => phones.confirm(999999, '123456')).code).toBe('no_phone');
  });
});

describe('sending again, limits and removing', () => {
  test('a new code replaces the old one', async () => {
    const user = await pendingUser();
    phones.resend(user.id);
    await flush();
    const fresh = codeFrom(lastSms());

    if (fresh !== user.code) expect(errorOf(() => phones.confirm(user.id, user.code)).code).toBe('bad_code');
    phones.confirm(user.id, fresh);
    expect(userRow(user.id).phone_verified_at).toBeTruthy();
  });

  test('resending is refused without a number or once verified', async () => {
    expect(errorOf(() => phones.resend(makeUser().id)).code).toBe('no_phone');

    const user = await pendingUser();
    phones.confirm(user.id, user.code);
    expect(errorOf(() => phones.resend(user.id)).code).toBe('not_pending');
  });

  test('an account gets at most 3 codes per hour', async () => {
    const user = makeUser();
    phones.setPhone(user.id, PASSWORD, local());
    phones.resend(user.id);
    phones.resend(user.id);
    await flush();
    expect(sms.outbox).toHaveLength(3);

    expect(errorOf(() => phones.resend(user.id)).code).toBe('rate_limited');
    expect(errorOf(() => phones.setPhone(user.id, PASSWORD, local())).code).toBe('rate_limited');
    await flush();
    expect(sms.outbox).toHaveLength(3);
    expect(codesFor(user.id)).toHaveLength(3);
  });

  test('a number gets at most 5 codes per day, whoever asks', async () => {
    const number = local();
    const insert = db.prepare(
      "INSERT INTO phone_codes (user_id, phone, purpose, code_hash, expires_at) VALUES (?, ?, 'verify', 'x', datetime('now', '+10 minutes'))"
    );
    for (let i = 0; i < 5; i += 1) insert.run(makeUser().id, intl(number));

    const user = makeUser();
    expect(errorOf(() => phones.setPhone(user.id, PASSWORD, number)).code).toBe('rate_limited');
    expect(userRow(user.id).phone).toBeNull();
    await flush();
    expect(sms.outbox).toEqual([]);
  });

  test('removing the number needs the password and clears everything', async () => {
    const user = await pendingUser();
    phones.confirm(user.id, user.code);

    expect(errorOf(() => phones.remove(user.id, 'wrong-password')).code).toBe('wrong_password');
    expect(userRow(user.id).phone).toBe(user.phone);

    phones.remove(user.id, PASSWORD);
    expect(userRow(user.id)).toEqual({ phone: null, phone_verified_at: null });
    expect(errorOf(() => phones.remove(user.id, PASSWORD)).code).toBe('no_phone');
  });

  test('deleting the account removes its codes', async () => {
    const user = await pendingUser();
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    expect(codesFor(user.id)).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('the optional field on the registration form', () => {
  test('nothing entered does nothing', () => {
    const user = makeUser();
    [undefined, null, '', '   ', 42].forEach((value) => expect(phones.startForNewAccount(user.id, value)).toBeNull());
    expect(userRow(user.id).phone).toBeNull();
  });

  test('a good number starts verification', async () => {
    const user = makeUser();
    const number = local();
    expect(phones.startForNewAccount(user.id, number)).toBe('sent');
    await flush();
    expect(userRow(user.id)).toEqual({ phone: intl(number), phone_verified_at: null });
    expect(lastSms().to).toBe(intl(number));
  });

  test('bad numbers, numbers in use and limits are reported without throwing', async () => {
    const user = makeUser();
    expect(phones.startForNewAccount(user.id, 'junk')).toBe('invalid');
    expect(phones.startForNewAccount(user.id, verifiedUser().number)).toBe('in_use');
    expect(phones.startForNewAccount(999999, local())).toBe('unavailable');

    const number = local();
    const insert = db.prepare(
      "INSERT INTO phone_codes (user_id, phone, purpose, code_hash, expires_at) VALUES (?, ?, 'verify', 'x', datetime('now', '+10 minutes'))"
    );
    for (let i = 0; i < 5; i += 1) insert.run(makeUser().id, intl(number));
    expect(phones.startForNewAccount(user.id, number)).toBe('unavailable');

    await flush();
    expect(sms.outbox).toEqual([]);
    expect(userRow(user.id).phone).toBeNull();
  });
});

describe('password reset by text message', () => {
  test('numbers that are unknown, unverified or invalid get nothing, and say nothing', async () => {
    const pending = await pendingUser();
    sms.clearOutbox();

    expect(phones.requestResetCode(local())).toEqual({ sent: false });
    expect(phones.requestResetCode(pending.number)).toEqual({ sent: false });
    ['junk', '', undefined, null, 123].forEach((value) => expect(phones.requestResetCode(value)).toEqual({ sent: false }));
    await flush();
    expect(sms.outbox).toEqual([]);
  });

  test('a verified number gets a reset code that works once', async () => {
    const user = verifiedUser();
    expect(phones.requestResetCode(user.number)).toEqual({ sent: true });
    await flush();

    expect(lastSms().to).toBe(user.phone);
    expect(lastSms().text).toMatch(/password reset code is \d{6}/);
    const code = codeFrom(lastSms());
    expect(JSON.stringify(codesFor(user.id))).not.toContain(code);

    expect(phones.verifyResetCode(user.number, code)).toBe(user.id);
    expect(errorOf(() => phones.verifyResetCode(user.number, code)).code).toBe('bad_code');
  });

  test('wrong codes lock the reset code after 5 tries, and all failures look the same', async () => {
    const user = verifiedUser();
    phones.requestResetCode(user.number);
    await flush();
    const code = codeFrom(lastSms());
    const wrong = wrongFor(code);

    const messages = new Set();
    for (let i = 0; i < 5; i += 1) messages.add(errorOf(() => phones.verifyResetCode(user.number, wrong)).message);
    messages.add(errorOf(() => phones.verifyResetCode(user.number, code)).message);
    messages.add(errorOf(() => phones.verifyResetCode(local(), code)).message);
    messages.add(errorOf(() => phones.verifyResetCode('junk', '123456')).message);
    expect(messages.size).toBe(1);
  });

  test('expired codes and codes for another purpose do not work', async () => {
    const user = verifiedUser();
    phones.requestResetCode(user.number);
    await flush();
    const code = codeFrom(lastSms());
    db.prepare("UPDATE phone_codes SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(user.id);
    expect(errorOf(() => phones.verifyResetCode(user.number, code)).code).toBe('bad_code');

    // A verification code (for an unverified number) can never be used to reset a password
    const pending = await pendingUser();
    expect(errorOf(() => phones.verifyResetCode(pending.number, pending.code)).code).toBe('bad_code');
  });

  test('an account gets at most 3 reset codes per hour', async () => {
    const user = verifiedUser();
    const results = [1, 2, 3, 4].map(() => phones.requestResetCode(user.number).sent);
    await flush();
    expect(results).toEqual([true, true, true, false]);
    expect(sms.outbox).toHaveLength(3);
  });

  test('the code leads to the normal reset page and sets the new password', async () => {
    const user = verifiedUser();
    phones.requestResetCode(user.number);
    await flush();
    const userId = phones.verifyResetCode(user.number, codeFrom(lastSms()));

    const token = recovery.issueTokenForUser(userId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(recovery.checkToken(token)).toBe(true);

    recovery.resetPassword(token, 'Brand-new-pass-77', 'Brand-new-pass-77');
    const hash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id).password_hash;
    expect(bcrypt.compareSync('Brand-new-pass-77', hash)).toBe(true);
    expect(recovery.checkToken(token)).toBe(false);
  });
});
