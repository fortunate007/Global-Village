process.env.APP_URL = 'https://app.test';

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const mailer = require('../src/services/mailer');
const recovery = require('../src/services/recoveryService');

let counter = 0;
function makeUser() {
  counter += 1;
  const username = `recov_${counter}_u`;
  const email = `Recov_${counter}@Example.com`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, email, bcrypt.hashSync('old-secret-1', 10), username).lastInsertRowid
  );
  return { id, username, email };
}

const tokenFrom = (message) => message.text.match(/\/reset-password\/([A-Za-z0-9_-]{43})/)[1];
const rowsFor = (userId) => db.prepare('SELECT * FROM password_resets WHERE user_id = ?').all(userId);
const epochOf = (id) => db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(id).session_epoch;
const passwordMatches = (id, password) =>
  bcrypt.compareSync(password, db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id).password_hash);
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => mailer.clearOutbox());

describe('asking for a link', () => {
  test('an unknown or malformed email creates nothing and sends nothing', () => {
    ['nobody@example.com', '', '   ', undefined, null, 42, ['a@b.c'], `${'x'.repeat(250)}@example.com`].forEach((email) => {
      expect(recovery.requestReset(email)).toEqual({ sent: false });
    });
    expect(mailer.outbox).toEqual([]);
  });

  test('a known email (any letter case) gets a one-time link, and only a hash of the token is stored', async () => {
    const user = makeUser();
    expect(recovery.requestReset(`  ${user.email.toLowerCase()}  `)).toEqual({ sent: true });
    await flush();

    expect(mailer.outbox).toHaveLength(1);
    const [message] = mailer.outbox;
    expect(message.to).toBe(user.email);
    expect(message.subject).toMatch(/reset/i);
    expect(message.text).toContain('https://app.test/reset-password/');
    expect(message.text).toContain(user.username);

    const token = tokenFrom(message);
    const rows = rowsFor(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(recovery.checkToken(token)).toBe(true);
  });

  test('each account gets at most 3 links per hour, silently', async () => {
    const user = makeUser();
    const results = [1, 2, 3, 4, 5].map(() => recovery.requestReset(user.email));
    await flush();

    expect(results.map((r) => r.sent)).toEqual([true, true, true, false, false]);
    expect(mailer.outbox).toHaveLength(3);
    expect(rowsFor(user.id)).toHaveLength(3);
  });

  test('without APP_URL in production nothing is built from the request and nothing is sent', () => {
    const user = makeUser();
    const savedEnv = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL, RENDER: process.env.RENDER };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;
    delete process.env.RENDER;
    try {
      expect(recovery.requestReset(user.email)).toEqual({ sent: false });
    } finally {
      Object.entries(savedEnv).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }

    expect(error).toHaveBeenCalledWith(expect.stringContaining('APP_URL'));
    error.mockRestore();
    expect(mailer.outbox).toEqual([]);
    expect(rowsFor(user.id)).toEqual([]);
  });

  test('a failing mail transport is logged and never thrown', async () => {
    const user = makeUser();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const send = jest.spyOn(mailer, 'send').mockRejectedValue(new Error('smtp is down'));

    expect(() => recovery.requestReset(user.email)).not.toThrow();
    await flush();

    expect(error).toHaveBeenCalledWith('[recovery] could not send the reset email', 'smtp is down');
    send.mockRestore();
    error.mockRestore();
  });

  test('old expired tokens are tidied away', () => {
    const user = makeUser();
    db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, 'old', datetime('now', '-3 days'))").run(user.id);
    recovery.requestReset(user.email);
    expect(rowsFor(user.id).some((r) => r.token_hash === 'old')).toBe(false);
  });
});

describe('checking a link', () => {
  async function freshToken() {
    const user = makeUser();
    recovery.requestReset(user.email);
    await flush();
    return { user, token: tokenFrom(mailer.outbox[mailer.outbox.length - 1]) };
  }

  test('rejects anything that is not a real token', () => {
    ['', 'short', 'x'.repeat(43), `${'a'.repeat(42)}!`, 'a'.repeat(44), undefined, null, 5, ['a'.repeat(43)]].forEach((value) => {
      expect(recovery.checkToken(value)).toBe(false);
    });
  });

  test('expired and used links stop working', async () => {
    const expired = await freshToken();
    db.prepare("UPDATE password_resets SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(expired.user.id);
    expect(recovery.checkToken(expired.token)).toBe(false);

    const used = await freshToken();
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(used.user.id);
    expect(recovery.checkToken(used.token)).toBe(false);
  });
});

describe('setting the new password', () => {
  async function freshToken() {
    const user = makeUser();
    recovery.requestReset(user.email);
    await flush();
    return { user, token: tokenFrom(mailer.outbox[mailer.outbox.length - 1]) };
  }

  test('changes the password, ends old sessions, uses up every link and tells the owner', async () => {
    const { user, token } = await freshToken();
    recovery.requestReset(user.email); // a second open link
    await flush();
    const before = epochOf(user.id);
    mailer.clearOutbox();

    expect(recovery.resetPassword(token, 'Brand-new-pass-77', 'Brand-new-pass-77')).toBe(user.id);
    await flush();

    expect(passwordMatches(user.id, 'Brand-new-pass-77')).toBe(true);
    expect(passwordMatches(user.id, 'old-secret-1')).toBe(false);
    expect(epochOf(user.id)).toBe(before + 1);
    expect(rowsFor(user.id)).toHaveLength(1);
    expect(rowsFor(user.id)[0].used_at).toBeTruthy();

    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]).toMatchObject({ to: user.email });
    expect(mailer.outbox[0].subject).toMatch(/changed/i);
    expect(mailer.outbox[0].text).toContain('https://app.test/forgot-password');

    expect(() => recovery.resetPassword(token, 'Another-pass-88', 'Another-pass-88')).toThrow(
      expect.objectContaining({ code: 'invalid_link' })
    );
    expect(passwordMatches(user.id, 'Brand-new-pass-77')).toBe(true);
  });

  test('an expired link cannot be used', async () => {
    const { user, token } = await freshToken();
    db.prepare("UPDATE password_resets SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(user.id);

    expect(() => recovery.resetPassword(token, 'Brand-new-pass-77', 'Brand-new-pass-77')).toThrow(
      expect.objectContaining({ code: 'invalid_link' })
    );
    expect(passwordMatches(user.id, 'old-secret-1')).toBe(true);
  });

  test('a mismatch or a weak password changes nothing and leaves the link usable', async () => {
    const { user, token } = await freshToken();
    process.env.TEST_PASSWORD_POLICY = '1';
    try {
      const attempts = [
        ['Brand-new-pass-77', 'different-pass-88', /do not match/],
        ['short1!', 'short1!', /at least 8/],
        ['password123', 'password123', /too common/],
        [`xx-${user.username}-99`, `xx-${user.username}-99`, /username or email/],
        [undefined, undefined, /at least 8|8-72/],
      ];
      attempts.forEach(([password, confirm, message]) => {
        let error;
        try {
          recovery.resetPassword(token, password, confirm);
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(recovery.RecoveryError);
        expect(error.code).toBe('invalid');
        expect(error.message).toMatch(message);
      });
    } finally {
      delete process.env.TEST_PASSWORD_POLICY;
    }

    expect(passwordMatches(user.id, 'old-secret-1')).toBe(true);
    expect(recovery.checkToken(token)).toBe(true);
  });

  test('deleting an account removes its links', async () => {
    const { user } = await freshToken();
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    expect(rowsFor(user.id)).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
