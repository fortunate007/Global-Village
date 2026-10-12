const bcrypt = require('bcryptjs');
const db = require('../src/db');
const configurePassport = require('../src/config/passport');

// Capture the strategy callback and the session loader so they can be called directly
const captured = {};
configurePassport({
  use: (strategy) => { captured.verify = strategy._verify; },
  serializeUser: () => {},
  deserializeUser: (fn) => { captured.deserialize = fn; },
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
      .run('MixedCase', 'Mixed@Example.com', bcrypt.hashSync('secret123', 10), 'Mixed').lastInsertRowid
  );
});

test('login works with any letter case, by username or by email', async () => {
  for (const name of ['MixedCase', 'mixedcase', 'MIXEDCASE', 'mixed@example.com', 'MIXED@EXAMPLE.COM']) {
    const { user } = await attempt(name, 'secret123');
    expect(user && user.id).toBe(userId);
  }
});

test('wrong passwords and unknown accounts are rejected', async () => {
  expect((await attempt('MixedCase', 'wrong-password')).user).toBe(false);
  expect((await attempt('nobody-here', 'secret123')).user).toBe(false);
});

test('the user loaded from the session never carries the password hash', () =>
  new Promise((resolve, reject) => {
    captured.deserialize(userId, (err, user) => {
      try {
        expect(err).toBeNull();
        expect(user.username).toBe('MixedCase');
        expect(user.password_hash).toBeUndefined();
        resolve();
      } catch (assertion) {
        reject(assertion);
      }
    });
  }));

test('a user that no longer exists loads as empty', () =>
  new Promise((resolve) => {
    captured.deserialize(999999, (err, user) => {
      expect(err).toBeNull();
      expect(user).toBeUndefined();
      resolve();
    });
  }));
