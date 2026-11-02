process.env.TEST_SIGNUP_VERIFICATION = '1';
process.env.TEST_EMAIL_VERIFICATION = '1';
process.env.APP_URL = 'https://app.test';

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const mailer = require('../src/services/mailer');
const sms = require('../src/services/sms');
const signup = require('../src/services/signupService');
const emailVerification = require('../src/services/emailVerificationService');

let counter = 0;
const nextId = () => (counter += 1);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const codeFrom = (message) => message.text.match(/\b(\d{6})\b/)[1];
const lastMail = () => mailer.outbox[mailer.outbox.length - 1];
const lastSms = () => sms.outbox[sms.outbox.length - 1];
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const pendingCount = () => db.prepare('SELECT COUNT(*) AS n FROM pending_signups').get().n;
const userNamed = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const wrongFor = (code) => (code === '000000' ? '111111' : '000000');
const kenya = () => `07${String(30000000 + nextId())}`;
const intl = (local) => `+254${local.slice(1)}`;
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

function details(extra = {}) {
  const n = nextId();
  return {
    username: `su_${n}_u`,
    email: `su_${n}@example.com`,
    password: 'secret123',
    confirmPassword: 'secret123',
    displayName: `User ${n}`,
    ...extra,
  };
}

beforeEach(() => {
  mailer.clearOutbox();
  sms.clearOutbox();
});

describe('signing up with an email address', () => {
  test('nothing exists until the code is entered, then the account is created, verified by email', async () => {
    const input = details();
    const before = userCount();
    const id = signup.startSignup(input);
    await flush();

    expect(userCount()).toBe(before);
    expect(userNamed(input.username)).toBeUndefined();
    expect(mailer.outbox).toHaveLength(1);
    expect(lastMail().to).toBe(input.email);
    expect(lastMail().subject).toMatch(/verification code/i);

    const code = codeFrom(lastMail());
    expect(JSON.stringify(db.prepare('SELECT * FROM pending_signups WHERE id = ?').get(id))).not.toContain(code);
    expect(signup.getPending(id)).toMatchObject({ username: input.username, method: 'email' });

    const result = signup.verify(id, code);
    const user = userNamed(input.username);
    expect(result).toEqual({ userId: user.id, method: 'email' });
    expect(user).toMatchObject({ email: input.email, display_name: input.displayName, email_pending_verification: 0, phone: null });
    expect(bcrypt.compareSync('secret123', user.password_hash)).toBe(true);
    expect(signup.getPending(id)).toBeNull();
    expect(userCount()).toBe(before + 1);
  });

  test('a display name is optional and defaults to the username', async () => {
    const input = details({ displayName: '' });
    const id = signup.startSignup(input);
    await flush();
    signup.verify(id, codeFrom(lastMail()));
    expect(userNamed(input.username).display_name).toBe(input.username);
  });
});

describe('signing up with a phone number', () => {
  test('a phone number alone is enough, and the account gets a stand-in email until a real one is added', async () => {
    const input = details({ email: '', phone: '0802 123 4567', phoneCountry: 'NG' });
    const id = signup.startSignup(input);
    await flush();

    expect(mailer.outbox).toEqual([]);
    expect(lastSms().to).toBe('+2348021234567');
    expect(lastSms().text).toMatch(/sign-up code is \d{6}/);

    const { userId, method } = signup.verify(id, codeFrom(lastSms()));
    const user = userById(userId);
    expect(method).toBe('phone');
    expect(user).toMatchObject({ phone: '+2348021234567', email_pending_verification: 1 });
    expect(user.phone_verified_at).toBeTruthy();
    expect(user.email).toBe('phone-2348021234567@phone-signup.invalid');
    expect(signup.isPlaceholderEmail(user.email)).toBe(true);
    expect(signup.isPlaceholderEmail('someone@example.com')).toBe(false);
    expect(signup.isPlaceholderEmail(undefined)).toBe(false);

    const refused = errorOf(() => emailVerification.resend(userId));
    expect(refused).toBeInstanceOf(emailVerification.VerificationError);
    expect(refused.message).toMatch(/no email address/);
  });

  test('with both contacts and the phone chosen, the phone is verified and the email gets its confirmation link', async () => {
    const number = kenya();
    const input = details({ phone: number, verifyBy: 'phone' });
    const id = signup.startSignup(input);
    await flush();

    expect(mailer.outbox).toEqual([]);
    expect(lastSms().to).toBe(intl(number));
    const { userId } = signup.verify(id, codeFrom(lastSms()));
    await flush();

    const user = userById(userId);
    expect(user).toMatchObject({ email: input.email, email_pending_verification: 1, phone: intl(number) });
    expect(user.phone_verified_at).toBeTruthy();
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].subject).toMatch(/confirm/i);
  });

  test('with both contacts and the email chosen, the phone is added unverified and gets its own code', async () => {
    const number = kenya();
    const input = details({ phone: number, verifyBy: 'email' });
    const id = signup.startSignup(input);
    await flush();

    expect(sms.outbox).toEqual([]);
    const { userId } = signup.verify(id, codeFrom(lastMail()));
    await flush();

    const user = userById(userId);
    expect(user).toMatchObject({ email: input.email, email_pending_verification: 0, phone: intl(number), phone_verified_at: null });
    expect(lastSms().to).toBe(intl(number));
    expect(lastSms().text).toMatch(/verification code is \d{6}/);
  });

  test('when only one contact is given, that one is used whatever the choice says', () => {
    const phoneOnly = signup.startSignup(details({ email: '', phone: kenya(), verifyBy: 'email' }));
    const emailOnly = signup.startSignup(details({ verifyBy: 'phone' }));
    expect(signup.getPending(phoneOnly).method).toBe('phone');
    expect(signup.getPending(emailOnly).method).toBe('email');
  });
});

describe('mistakes and conflicts', () => {
  test('mistakes are reported together, and nothing is parked or sent', async () => {
    const before = pendingCount();
    const error = errorOf(() =>
      signup.startSignup({ username: 'x', email: 'nope', password: 'abc', confirmPassword: 'abd', displayName: '', phone: 'zzz' })
    );

    expect(error).toBeInstanceOf(signup.SignupError);
    expect(error.code).toBe('invalid');
    const text = error.errors.join(' | ');
    expect(text).toMatch(/Username must be/);
    expect(text).toMatch(/valid email/);
    expect(text).toMatch(/valid phone number/);
    expect(text).toMatch(/6-72 characters/);
    expect(text).toMatch(/do not match/);

    await flush();
    expect(pendingCount()).toBe(before);
    expect(mailer.outbox).toEqual([]);
    expect(sms.outbox).toEqual([]);
  });

  test('an email address or a phone number is required', () => {
    const error = errorOf(() => signup.startSignup(details({ email: '', phone: '' })));
    expect(error.errors).toContain('Enter an email address or a phone number to verify.');
    [undefined, null, 42, ['a@b.c']].forEach((value) => {
      expect(errorOf(() => signup.startSignup(details({ email: value, phone: value }))).errors).toContain(
        'Enter an email address or a phone number to verify.'
      );
    });
  });

  test('names, emails and verified phone numbers that already belong to someone are refused', () => {
    const existing = details();
    db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
      existing.username,
      existing.email,
      'x',
      'Existing'
    );
    const number = kenya();
    db.prepare(
      'INSERT INTO users (username, email, password_hash, display_name, phone, phone_verified_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(`own_${nextId()}_u`, `own_${nextId()}@example.com`, 'x', 'Owner', intl(number));

    const before = pendingCount();
    const byName = errorOf(() => signup.startSignup(details({ username: existing.username.toUpperCase() })));
    const byEmail = errorOf(() => signup.startSignup(details({ email: existing.email.toUpperCase() })));
    const byPhone = errorOf(() => signup.startSignup(details({ email: '', phone: number })));

    [byName, byEmail].forEach((error) => {
      expect(error).toBeInstanceOf(signup.SignupError);
      expect(error.code).toBe('taken');
      expect(error.message).toMatch(/already taken/);
    });
    expect(byPhone.code).toBe('taken');
    expect(byPhone.message).toMatch(/phone number is already in use/);
    expect(pendingCount()).toBe(before);
  });

  test('a code cannot be sent to the same address more than 5 times a day', async () => {
    const input = details();
    const insert = db.prepare('INSERT INTO signup_sends (destination) VALUES (?)');
    for (let i = 0; i < 5; i += 1) insert.run(input.email.toLowerCase());
    const before = pendingCount();

    const error = errorOf(() => signup.startSignup(input));
    await flush();

    expect(error.code).toBe('rate_limited');
    expect(pendingCount()).toBe(before);
    expect(mailer.outbox).toEqual([]);
  });

  test('somebody taking the username while the code is pending is caught when the code is entered', async () => {
    const input = details();
    const id = signup.startSignup(input);
    await flush();
    const code = codeFrom(lastMail());
    db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
      input.username,
      `other_${nextId()}@example.com`,
      'x',
      'Quicker'
    );

    expect(errorOf(() => signup.verify(id, code)).code).toBe('taken');
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get(input.username).n).toBe(1);
    expect(signup.getPending(id)).toBeNull();
  });
});

describe('the code', () => {
  test('wrong codes are counted, and the fifth one drops the sign-up', async () => {
    const id = signup.startSignup(details());
    await flush();
    const code = codeFrom(lastMail());
    const wrong = wrongFor(code);

    for (let i = 1; i <= 4; i += 1) {
      expect(errorOf(() => signup.verify(id, wrong)).code).toBe('bad_code');
      expect(signup.getPending(id).attempts).toBe(i);
    }
    expect(errorOf(() => signup.verify(id, wrong)).code).toBe('locked');
    expect(signup.getPending(id)).toBeNull();
    expect(errorOf(() => signup.verify(id, code)).code).toBe('expired');
  });

  test('malformed codes are refused and do not count', async () => {
    const id = signup.startSignup(details());
    await flush();
    ['', 'abc', '12345', '1234567', undefined, null, 123456].forEach((value) => {
      expect(errorOf(() => signup.verify(id, value)).code).toBe('bad_code');
    });
    expect(signup.getPending(id).attempts).toBe(0);
  });

  test('spaces inside the code are fine', async () => {
    const input = details();
    const id = signup.startSignup(input);
    await flush();
    const code = codeFrom(lastMail());
    signup.verify(id, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(userNamed(input.username)).toBeDefined();
  });

  test('an expired code is refused until a new one is sent, and an expired sign-up is gone', async () => {
    const input = details();
    const id = signup.startSignup(input);
    await flush();
    const code = codeFrom(lastMail());

    db.prepare("UPDATE pending_signups SET code_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
    const error = errorOf(() => signup.verify(id, code));
    expect(error.code).toBe('bad_code');
    expect(error.message).toMatch(/expired/);
    expect(signup.getPending(id)).not.toBeNull();

    signup.resend(id);
    await flush();
    signup.verify(id, codeFrom(lastMail()));
    expect(userNamed(input.username)).toBeDefined();

    const other = signup.startSignup(details());
    await flush();
    const otherCode = codeFrom(lastMail());
    db.prepare("UPDATE pending_signups SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(other);
    expect(signup.getPending(other)).toBeNull();
    expect(errorOf(() => signup.verify(other, otherCode)).code).toBe('expired');
    expect(errorOf(() => signup.resend(other)).code).toBe('expired');
  });

  test('a new code replaces the old one, and a sign-up gets at most 3 codes', async () => {
    const input = details();
    const id = signup.startSignup(input);
    await flush();
    const first = codeFrom(lastMail());

    signup.resend(id);
    await flush();
    const second = codeFrom(lastMail());
    if (first !== second) expect(errorOf(() => signup.verify(id, first)).code).toBe('bad_code');

    signup.resend(id);
    await flush();
    expect(mailer.outbox).toHaveLength(3);
    expect(errorOf(() => signup.resend(id)).code).toBe('rate_limited');
    await flush();
    expect(mailer.outbox).toHaveLength(3);

    signup.verify(id, codeFrom(lastMail()));
    expect(userNamed(input.username)).toBeDefined();
  });
});

describe('starting over', () => {
  test('a new sign-up replaces the old one, and cancelling removes it', () => {
    const first = signup.startSignup(details());
    const second = signup.startSignup({ ...details(), replaceId: first });
    expect(signup.getPending(first)).toBeNull();
    expect(signup.getPending(second)).not.toBeNull();

    signup.cancel(second);
    expect(signup.getPending(second)).toBeNull();
    expect(() => signup.cancel(undefined)).not.toThrow();
    expect(() => signup.cancel('x')).not.toThrow();
  });
});

describe('switches and display', () => {
  test('verification can be switched off for emergencies, and is off in tests unless asked for', () => {
    expect(signup.enabled()).toBe(true);

    process.env.REQUIRE_SIGNUP_VERIFICATION = 'false';
    expect(signup.enabled()).toBe(false);
    delete process.env.REQUIRE_SIGNUP_VERIFICATION;
    expect(signup.enabled()).toBe(true);

    const saved = process.env.TEST_SIGNUP_VERIFICATION;
    delete process.env.TEST_SIGNUP_VERIFICATION;
    expect(signup.enabled()).toBe(false);
    process.env.TEST_SIGNUP_VERIFICATION = saved;
  });

  test('addresses and numbers are masked', () => {
    expect(signup.maskDestination({ method: 'email', email: 'someone@example.com' })).toBe('s***@example.com');
    expect(signup.maskDestination({ method: 'phone', phone: '+254712345678' })).toBe('+•••••••••678');
  });
});
