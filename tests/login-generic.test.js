const bcrypt = require('bcryptjs');
const db = require('../src/db');
const configurePassport = require('../src/config/passport');

const captured = {};
configurePassport({
  use: (strategy) => { captured.verify = strategy._verify; },
  serializeUser: () => {},
  deserializeUser: () => {},
});

const failure = (username, password) =>
  new Promise((resolve) => captured.verify(username, password, (err, user, info) => resolve(info)));

test('unknown accounts and wrong passwords get the same message, so usernames cannot be probed', async () => {
  db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('probeuser', 'probe@example.com', bcrypt.hashSync('secret123', 10), 'Probe');

  const unknown = await failure('no-such-user', 'whatever');
  const wrong = await failure('probeuser', 'wrong-password');
  expect(unknown.message).toBe(wrong.message);
  expect(unknown.message).not.toMatch(/no account/i);
});
