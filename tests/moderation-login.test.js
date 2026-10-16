const bcrypt = require('bcryptjs');
const db = require('../src/db');
const configurePassport = require('../src/config/passport');
const { middleware } = require('../src/middleware/sessionEpoch');

const captured = {};
configurePassport({
  use: (strategy) => { captured.verify = strategy._verify; },
  serializeUser: () => {},
  deserializeUser: () => {},
});

const attempt = (username, password) =>
  new Promise((resolve, reject) => {
    captured.verify(username, password, (err, user, info) => (err ? reject(err) : resolve({ user, info })));
  });

let userId;
beforeAll(() => {
  userId = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run('suspendable', 'suspendable@example.com', bcrypt.hashSync('secret123', 10), 'Suspendable').lastInsertRowid
  );
});

describe('logging in', () => {
  test('a suspended account is refused with a clear message, but only after the right password', async () => {
    db.prepare('UPDATE users SET suspended_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);

    const right = await attempt('suspendable', 'secret123');
    expect(right.user).toBe(false);
    expect(right.info.message).toBe('This account has been suspended.');

    const wrong = await attempt('suspendable', 'wrong-password');
    expect(wrong.user).toBe(false);
    expect(wrong.info.message).not.toMatch(/suspended/i);

    const unknown = await attempt('nobody-here-at-all', 'secret123');
    expect(unknown.info.message).not.toMatch(/suspended/i);
  });

  test('once unsuspended, login works again', async () => {
    db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?').run(userId);
    const result = await attempt('suspendable', 'secret123');
    expect(result.user && result.user.id).toBe(userId);
  });
});

describe('sessions', () => {
  const run = (user) => {
    const req = { user, session: {}, logout: jest.fn((cb) => cb()) };
    const next = jest.fn();
    middleware(req, {}, next);
    return { req, next };
  };

  test('a suspended account is logged out on its next request, even with a matching session', () => {
    const { req, next } = run({ id: 1, session_epoch: 0, suspended_at: '2026-01-01 00:00:00' });
    expect(req.logout).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('an account that is not suspended carries on as before', () => {
    const { req, next } = run({ id: 1, session_epoch: 0, suspended_at: null });
    expect(req.logout).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });
});
