process.env.APP_URL = 'https://app.test';
process.env.TEST_EMAIL_VERIFICATION = '1';

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const mailer = require('../src/services/mailer');
const verification = require('../src/services/emailVerificationService');
const recovery = require('../src/services/recoveryService');

afterAll(() => {
  delete process.env.TEST_EMAIL_VERIFICATION;
});

let counter = 0;
function makeUser() {
  counter += 1;
  const username = `ver_${counter}_u`;
  const email = `Ver_${counter}@Example.com`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, email, bcrypt.hashSync('old-secret-1', 10), username).lastInsertRowid
  );
  return { id, username, email };
}

const tokenFrom = (message) => message.text.match(/\/verify-email\/([A-Za-z0-9_-]{43})/)[1];
const rowsFor = (userId) => db.prepare('SELECT * FROM email_verifications WHERE user_id = ?').all(userId);
const pendingOf = (id) => db.prepare('SELECT email_pending_verification AS p FROM users WHERE id = ?').get(id).p;
const emailOf = (id) => db.prepare('SELECT email FROM users WHERE id = ?').get(id).email;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

beforeEach(() => mailer.clearOutbox());

describe('starting verification for a new account', () => {
  test('marks the account unconfirmed, emails a one-time link and stores only a hash of it', async () => {
    const user = makeUser();
    expect(verification.startForNewAccount(user.id)).toBe(true);
    await flush();

    expect(pendingOf(user.id)).toBe(1);
    expect(mailer.outbox).toHaveLength(1);
    const [message] = mailer.outbox;
    expect(message.to).toBe(user.email);
    expect(message.subject).toMatch(/confirm/i);
    expect(message.text).toContain('https://app.test/verify-email/');
    expect(message.text).toContain(user.username);

    const token = tokenFrom(message);
    const rows = rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].email).toBe(user.email);
    expect(verification.checkToken(token)).toBe(true);
  });

  test('is off by default while testing, so existing tests that register accounts are unaffected', async () => {
    const user = makeUser();
    const saved = process.env.TEST_EMAIL_VERIFICATION;
    delete process.env.TEST_EMAIL_VERIFICATION;
    try {
      expect(verification.startForNewAccount(user.id)).toBe(false);
    } finally {
      process.env.TEST_EMAIL_VERIFICATION = saved;
    }
    await flush();
    expect(pendingOf(user.id)).toBe(0);
    expect(mailer.outbox).toEqual([]);
  });

  test('unknown accounts are ignored', () => {
    expect(verification.startForNewAccount(999999)).toBe(false);
  });

  test('without a site address in production nothing is built from the request, and the account is left alone', () => {
    const user = makeUser();
    const savedEnv = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL, RENDER: process.env.RENDER };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;
    delete process.env.RENDER;
    let result;
    try {
      result = verification.startForNewAccount(user.id);
    } finally {
      Object.entries(savedEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }

    expect(result).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[verification]'), expect.stringContaining('cannot be sent'));
    error.mockRestore();
    expect(pendingOf(user.id)).toBe(0);
    expect(mailer.outbox).toEqual([]);
    expect(rowsFor(user.id)).toEqual([]);
  });

  test('a failing mail transport is logged and never thrown', async () => {
    const user = makeUser();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const send = jest.spyOn(mailer, 'send').mockRejectedValue(new Error('smtp is down'));

    expect(verification.startForNewAccount(user.id)).toBe(true);
    await flush();

    expect(error).toHaveBeenCalledWith('[verification] could not send the email', 'smtp is down');
    send.mockRestore();
    error.mockRestore();
  });
});

describe('checking and confirming a link', () => {
  async function started() {
    const user = makeUser();
    verification.startForNewAccount(user.id);
    await flush();
    return { user, token: tokenFrom(mailer.outbox[mailer.outbox.length - 1]) };
  }

  test('rejects anything that is not a real token', () => {
    ['', 'short', 'x'.repeat(43), `${'a'.repeat(42)}!`, 'a'.repeat(44), undefined, null, 5, ['a'.repeat(43)]].forEach(
      (value) => expect(verification.checkToken(value)).toBe(false)
    );
  });

  test('confirming clears the flag and uses up every link of the account, and works only once', async () => {
    const { user, token } = await started();
    verification.resend(user.id);
    await flush();
    const second = tokenFrom(mailer.outbox[mailer.outbox.length - 1]);
    expect(rowsFor(user.id)).toHaveLength(2);

    expect(verification.confirm(token)).toBe(user.id);
    expect(pendingOf(user.id)).toBe(0);
    expect(verification.checkToken(second)).toBe(false);

    const again = errorOf(() => verification.confirm(token));
    expect(again).toBeInstanceOf(verification.VerificationError);
    expect(again.code).toBe('invalid_link');
  });

  test('expired links cannot be used', async () => {
    const { user, token } = await started();
    db.prepare("UPDATE email_verifications SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(user.id);

    expect(verification.checkToken(token)).toBe(false);
    expect(errorOf(() => verification.confirm(token)).code).toBe('invalid_link');
    expect(pendingOf(user.id)).toBe(1);
  });

  test('a link only works while the account still has the address it was sent to', async () => {
    const { user, token } = await started();
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run('someone-else@example.com', user.id);
    expect(verification.checkToken(token)).toBe(false);
    expect(errorOf(() => verification.confirm(token)).code).toBe('invalid_link');
  });

  test('deleting the account removes its links', async () => {
    const { user } = await started();
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    expect(rowsFor(user.id)).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('sending the link again', () => {
  test('sends another link to the current address, at most 3 emails per hour', async () => {
    const user = makeUser();
    verification.startForNewAccount(user.id);
    verification.resend(user.id);
    verification.resend(user.id);
    await flush();
    expect(mailer.outbox).toHaveLength(3);
    mailer.outbox.forEach((message) => expect(message.to).toBe(user.email));

    const blocked = errorOf(() => verification.resend(user.id));
    expect(blocked).toBeInstanceOf(verification.VerificationError);
    expect(blocked.code).toBe('rate_limited');
    await flush();
    expect(mailer.outbox).toHaveLength(3);
    expect(rowsFor(user.id)).toHaveLength(3);
  });

  test('is refused once the address is confirmed, and for unknown accounts', async () => {
    const user = makeUser();
    verification.startForNewAccount(user.id);
    await flush();
    verification.confirm(tokenFrom(mailer.outbox[0]));
    mailer.clearOutbox();

    expect(errorOf(() => verification.resend(user.id)).code).toBe('not_pending');
    expect(errorOf(() => verification.resend(999999)).code).toBe('invalid');
    await flush();
    expect(mailer.outbox).toEqual([]);
  });

  test('accounts that existed before this feature are never asked to confirm', () => {
    const user = makeUser(); // never started: the default 0, like every older account
    expect(errorOf(() => verification.resend(user.id)).code).toBe('not_pending');
  });
});

describe('changing the address of an unconfirmed account', () => {
  async function started() {
    const user = makeUser();
    verification.startForNewAccount(user.id);
    await flush();
    return { user, oldToken: tokenFrom(mailer.outbox[mailer.outbox.length - 1]) };
  }

  test('a wrong password changes nothing', async () => {
    const { user, oldToken } = await started();
    const error = errorOf(() => verification.changeEmail(user.id, 'wrong-password', 'fixed@example.com'));
    expect(error.code).toBe('wrong_password');
    expect(emailOf(user.id)).toBe(user.email);
    expect(verification.checkToken(oldToken)).toBe(true);
  });

  test('bad addresses, the same address and addresses already in use are refused', async () => {
    const { user } = await started();
    const other = makeUser();

    ['', '   ', 'not-an-email', `${'x'.repeat(250)}@example.com`, undefined, null, 42].forEach((value) => {
      expect(errorOf(() => verification.changeEmail(user.id, 'old-secret-1', value)).code).toBe('invalid');
    });
    expect(errorOf(() => verification.changeEmail(user.id, 'old-secret-1', user.email.toUpperCase())).code).toBe('invalid');
    expect(errorOf(() => verification.changeEmail(user.id, 'old-secret-1', other.email.toLowerCase())).code).toBe('invalid');
    expect(emailOf(user.id)).toBe(user.email);
  });

  test('the new address gets a link, the old links stop working and the account stays unconfirmed', async () => {
    const { user, oldToken } = await started();
    mailer.clearOutbox();

    verification.changeEmail(user.id, 'old-secret-1', `  fixed_${user.username}@example.com  `);
    await flush();

    expect(emailOf(user.id)).toBe(`fixed_${user.username}@example.com`);
    expect(pendingOf(user.id)).toBe(1);
    expect(verification.checkToken(oldToken)).toBe(false);

    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].to).toBe(`fixed_${user.username}@example.com`);
    const newToken = tokenFrom(mailer.outbox[0]);
    expect(verification.checkToken(newToken)).toBe(true);
    expect(verification.confirm(newToken)).toBe(user.id);
    expect(pendingOf(user.id)).toBe(0);
  });

  test('confirmed accounts cannot change the address here', async () => {
    const { user, oldToken } = await started();
    verification.confirm(oldToken);
    const error = errorOf(() => verification.changeEmail(user.id, 'old-secret-1', 'fixed@example.com'));
    expect(error.code).toBe('not_pending');
    expect(emailOf(user.id)).toBe(user.email);
  });

  test('changes count toward the 3-per-hour limit and leave everything untouched when refused', async () => {
    const { user, oldToken } = await started(); // 1st email
    verification.changeEmail(user.id, 'old-secret-1', `one_${user.username}@example.com`); // 2nd
    verification.changeEmail(user.id, 'old-secret-1', `two_${user.username}@example.com`); // 3rd
    await flush();
    const sent = mailer.outbox.length;
    expect(sent).toBe(3);

    const blocked = errorOf(() => verification.changeEmail(user.id, 'old-secret-1', `three_${user.username}@example.com`));
    expect(blocked.code).toBe('rate_limited');
    expect(emailOf(user.id)).toBe(`two_${user.username}@example.com`);
    const latest = tokenFrom(mailer.outbox[mailer.outbox.length - 1]);
    expect(verification.checkToken(latest)).toBe(true);
    expect(verification.checkToken(oldToken)).toBe(false);
    await flush();
    expect(mailer.outbox).toHaveLength(sent);
  });
});

describe('password reset links', () => {
  test('are not sent to an unconfirmed address, and are once it is confirmed', async () => {
    const user = makeUser();
    verification.startForNewAccount(user.id);
    await flush();
    const token = tokenFrom(mailer.outbox[0]);
    mailer.clearOutbox();

    expect(recovery.requestReset(user.email)).toEqual({ sent: false });
    await flush();
    expect(mailer.outbox).toEqual([]);

    verification.confirm(token);
    expect(recovery.requestReset(user.email)).toEqual({ sent: true });
    await flush();
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].subject).toMatch(/reset/i);
  });

  test('accounts that existed before this feature still get them', async () => {
    const user = makeUser();
    expect(recovery.requestReset(user.email)).toEqual({ sent: true });
    await flush();
    expect(mailer.outbox).toHaveLength(1);
  });
});
