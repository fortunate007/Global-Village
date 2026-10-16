process.env.APP_URL = 'https://app.test';

const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const mailer = require('../src/services/mailer');

let counter = 0;
async function makeAccount() {
  counter += 1;
  const username = `rr_${counter}_u`;
  const email = `${username}@example.com`;
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({ username, email, password: 'secret123', confirmPassword: 'secret123', displayName: username })
    .expect(302);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return { id, username, email, agent };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const askFor = (email) => request(app).post('/forgot-password').type('form').send({ email });
const lastLinkPath = () => {
  const { text } = mailer.outbox[mailer.outbox.length - 1];
  return text.match(/(\/reset-password\/[A-Za-z0-9_-]{43})/)[1];
};
const login = (username, password) => request(app).post('/login').type('form').send({ username, password });

beforeEach(() => mailer.clearOutbox());

describe('asking for a link', () => {
  test('the pages are for guests, and the form is shown', async () => {
    const page = await request(app).get('/forgot-password').expect(200);
    expect(page.text).toContain('name="email"');

    const a = await makeAccount();
    expect((await a.agent.get('/forgot-password').expect(302)).headers.location).toBe('/users');
    expect((await a.agent.post('/forgot-password').type('form').send({ email: a.email }).expect(302)).headers.location).toBe('/users');
  });

  test('known and unknown emails get exactly the same answer, but only the known one gets an email', async () => {
    const a = await makeAccount();

    const unknown = await askFor('nobody-at-all@example.com').expect(302);
    await flush();
    expect(mailer.outbox).toEqual([]);

    const known = await askFor(a.email).expect(302);
    await flush();
    expect(mailer.outbox).toHaveLength(1);

    expect(known.headers.location).toBe(unknown.headers.location);
    expect(known.headers.location).toBe('/login');
    expect(known.text).toBe(unknown.text);
  });

  test('cross-site requests are refused', async () => {
    await request(app).post('/forgot-password').set('Sec-Fetch-Site', 'cross-site').type('form').send({ email: 'x@example.com' }).expect(403);
  });
});

describe('the whole flow', () => {
  test('request, open the link, set a new password, log in, and the link cannot be reused', async () => {
    const a = await makeAccount();
    const otherDevice = request.agent(app);
    await otherDevice.post('/login').type('form').send({ username: a.username, password: 'secret123' }).expect(302);
    await otherDevice.get('/users').expect(200);

    await askFor(a.email).expect(302);
    await flush();
    const path = lastLinkPath();

    const page = await request(app).get(path).expect(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).toContain('name="password"');
    expect(page.text).toContain(`action="${path}"`);

    // A weak password is refused and the link keeps working
    const weak = await request(app).post(path).type('form').send({ password: 'abc', confirmPassword: 'abc' }).expect(302);
    expect(weak.headers.location).toBe(path);
    await request(app).get(path).expect(200);

    // A mismatch is refused too
    const mismatch = await request(app).post(path).type('form').send({ password: 'Brand-new-pass-77', confirmPassword: 'nope' }).expect(302);
    expect(mismatch.headers.location).toBe(path);

    const done = await request(app).post(path).type('form').send({ password: 'Brand-new-pass-77', confirmPassword: 'Brand-new-pass-77' }).expect(302);
    expect(done.headers.location).toBe('/login');

    expect((await login(a.username, 'Brand-new-pass-77').expect(302)).headers.location).toBe('/users');
    expect((await login(a.username, 'secret123').expect(302)).headers.location).toBe('/login');

    // Every older session is logged out, including the one that was logged in while this happened
    expect((await otherDevice.get('/users').expect(302)).headers.location).toBe('/login');
    expect((await a.agent.get('/users').expect(302)).headers.location).toBe('/login');

    // The used link is dead for both the page and the form
    const reused = await request(app).get(path).expect(400);
    expect(reused.text).toContain('expired');
    const reusedPost = await request(app).post(path).type('form').send({ password: 'Third-pass-99', confirmPassword: 'Third-pass-99' }).expect(400);
    expect(reusedPost.text).toContain('expired');
    expect((await login(a.username, 'Third-pass-99').expect(302)).headers.location).toBe('/login');
  });

  test('made-up, malformed and expired links get the expired page', async () => {
    await request(app).get(`/reset-password/${'a'.repeat(43)}`).expect(400);
    await request(app).get('/reset-password/short').expect(400);
    await request(app).post(`/reset-password/${'b'.repeat(43)}`).type('form').send({ password: 'Brand-new-pass-77', confirmPassword: 'Brand-new-pass-77' }).expect(400);

    const a = await makeAccount();
    await askFor(a.email).expect(302);
    await flush();
    const path = lastLinkPath();
    db.prepare("UPDATE password_resets SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(a.id);
    const expired = await request(app).get(path).expect(400);
    expect(expired.text).toContain('/forgot-password');
  });

  test('live chat connections of the account are closed', async () => {
    const a = await makeAccount();
    await askFor(a.email).expect(302);
    await flush();
    const path = lastLinkPath();

    const mine = { disconnect: jest.fn(), userId: String(a.id), request: { sessionID: 'phone' } };
    const theirs = { disconnect: jest.fn(), userId: String(a.id + 1000), request: { sessionID: 'x' } };
    const io = { of: () => ({ sockets: new Map([['1', mine], ['2', theirs]]) }) };
    const original = app.get('io');
    app.set('io', io);
    try {
      await request(app).post(path).type('form').send({ password: 'Brand-new-pass-77', confirmPassword: 'Brand-new-pass-77' }).expect(302);
    } finally {
      app.set('io', original);
    }

    expect(mine.disconnect).toHaveBeenCalledWith(true);
    expect(theirs.disconnect).not.toHaveBeenCalled();
  });
});

test('the login page links to the forgot-password page', async () => {
  const page = await request(app).get('/login').expect(200);
  expect(page.text).toContain('/forgot-password');
});
