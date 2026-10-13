process.env.TEST_PASSWORD_POLICY = '1';

const bcrypt = require('bcryptjs');
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_PASSWORD_POLICY;
});

const STRONG = 'T7-lemon-river-93';

let counter = 0;
const nextName = () => {
  counter += 1;
  return `pp${counter}x`;
};

const register = (agent, username, password) =>
  agent
    .post('/register')
    .type('form')
    .send({ username, email: `${username}@example.com`, password, confirmPassword: password, displayName: username });
const userCount = (username) => db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get(username).n;

describe('registration', () => {
  test.each([
    ['short1!', 'at least 8 characters'],
    ['password123', 'too common'],
    ['qwertyuiop', 'too common'],
    ['aaaaaaaaaa', 'different characters'],
  ])('%s is refused with a clear message and no account is made', async (password, message) => {
    const username = nextName();
    const res = await register(request(app), username, password).expect(200);
    expect(res.text).toContain(message);
    expect(userCount(username)).toBe(0);
  });

  test('a password containing the username is refused', async () => {
    counter += 1;
    const username = `lemonriver${counter}`;
    const res = await register(request(app), username, `T7-${username}-93`).expect(200);
    expect(res.text).toContain('cannot contain your username or email');
    expect(userCount(username)).toBe(0);
  });

  test('a strong password creates the account and logs in', async () => {
    const username = nextName();
    const res = await register(request(app), username, STRONG).expect(302);
    expect(res.headers.location).toBe('/users');
    expect(userCount(username)).toBe(1);
  });
});

describe('changing the password', () => {
  async function account() {
    const username = nextName();
    const agent = request.agent(app);
    await register(agent, username, STRONG).expect(302);
    return { username, agent, id: db.prepare('SELECT id FROM users WHERE username = ?').get(username).id };
  }
  const change = (user, next) =>
    user.agent.post('/account/password').type('form').send({ currentPassword: STRONG, newPassword: next, confirmPassword: next });
  const epochOf = (id) => db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(id).session_epoch;
  const login = (username, password) => request(app).post('/login').type('form').send({ username, password });

  test('weak new passwords change nothing', async () => {
    const a = await account();
    const before = epochOf(a.id);

    for (const weak of ['short1!', 'password123', 'aaaaaaaaaa', `x${a.username}x-Q9`]) {
      const res = await change(a, weak).expect(302);
      expect(res.headers.location).toBe('/account/security');
    }

    expect(epochOf(a.id)).toBe(before);
    expect((await login(a.username, STRONG).expect(302)).headers.location).toBe('/users');
  });

  test('a strong new password is accepted and replaces the old one', async () => {
    const a = await account();
    const before = epochOf(a.id);
    const fresh = 'Q9-maple-hill-27';

    await change(a, fresh).expect(302);

    expect(epochOf(a.id)).toBe(before + 1);
    expect((await login(a.username, fresh).expect(302)).headers.location).toBe('/users');
    expect((await login(a.username, STRONG).expect(302)).headers.location).toBe('/login');
  });
});

test('people with older, weaker passwords can still log in', async () => {
  const username = nextName();
  db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    username,
    `${username}@example.com`,
    bcrypt.hashSync('abc123', 10),
    username
  );

  const res = await request(app).post('/login').type('form').send({ username, password: 'abc123' }).expect(302);
  expect(res.headers.location).toBe('/users');
});
