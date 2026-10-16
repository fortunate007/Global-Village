process.env.APP_URL = 'https://app.test';
process.env.TEST_EMAIL_VERIFICATION = '1';

const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const mailer = require('../src/services/mailer');

afterAll(() => {
  delete process.env.TEST_EMAIL_VERIFICATION;
});

let counter = 0;
async function register() {
  counter += 1;
  const username = `evr_${counter}_u`;
  const email = `${username}@example.com`;
  const agent = request.agent(app);
  const res = await agent
    .post('/register')
    .type('form')
    .send({ username, email, password: 'secret123', confirmPassword: 'secret123', displayName: username })
    .expect(302);
  expect(res.headers.location).toBe('/users');
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return { id, username, email, agent };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const pendingOf = (id) => db.prepare('SELECT email_pending_verification AS p FROM users WHERE id = ?').get(id).p;
const emailOf = (id) => db.prepare('SELECT email FROM users WHERE id = ?').get(id).email;
const lastLink = () => {
  const { text } = mailer.outbox[mailer.outbox.length - 1];
  return text.match(/(\/verify-email\/[A-Za-z0-9_-]{43})/)[1];
};

beforeEach(() => mailer.clearOutbox());

describe('registration', () => {
  test('creates an unconfirmed account, emails a link to the address and logs the person in as usual', async () => {
    const a = await register();
    await flush();

    expect(pendingOf(a.id)).toBe(1);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].to).toBe(a.email);
    expect(mailer.outbox[0].subject).toMatch(/confirm/i);
    await a.agent.get('/users').expect(200);
  });
});

describe('the link', () => {
  test('opening it only shows a button, and pressing it confirms the address', async () => {
    const a = await register();
    await flush();
    const path = lastLink();

    const page = await request(app).get(path).expect(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).toContain(`action="${path}"`);
    expect(pendingOf(a.id)).toBe(1); // a mail scanner opening the link changes nothing

    const done = await a.agent.post(path).expect(302);
    expect(done.headers.location).toBe('/users');
    expect(pendingOf(a.id)).toBe(0);
  });

  test('confirming while logged out sends the person to the login page', async () => {
    const a = await register();
    await flush();
    const path = lastLink();

    const done = await request(app).post(path).type('form').send({}).expect(302);
    expect(done.headers.location).toBe('/login');
    expect(pendingOf(a.id)).toBe(0);
  });

  test('a used link, a made-up link and a malformed link all get the expired page', async () => {
    const a = await register();
    await flush();
    const path = lastLink();
    await request(app).post(path).type('form').send({}).expect(302);

    const reused = await request(app).get(path).expect(400);
    expect(reused.text).toContain('expired');
    await request(app).post(path).type('form').send({}).expect(400);
    await request(app).get(`/verify-email/${'a'.repeat(43)}`).expect(400);
    await request(app).get('/verify-email/short').expect(400);
    expect(pendingOf(a.id)).toBe(0);
  });

  test('cross-site confirmations are refused', async () => {
    const a = await register();
    await flush();
    const path = lastLink();

    await request(app).post(path).set('Sec-Fetch-Site', 'cross-site').type('form').send({}).expect(403);
    expect(pendingOf(a.id)).toBe(1);
  });
});

describe('the status page', () => {
  test('you must be logged in, and an unconfirmed account sees the resend and change forms', async () => {
    expect((await request(app).get('/account/verify-email').expect(302)).headers.location).toBe('/login');

    const a = await register();
    const page = (await a.agent.get('/account/verify-email').expect(200)).text;
    expect(page).toContain(a.email);
    expect(page).toContain('/account/verify-email/resend');
    expect(page).toContain('name="newEmail"');
  });

  test('a confirmed account sees no forms', async () => {
    const a = await register();
    await flush();
    await a.agent.post(lastLink()).expect(302);

    const page = (await a.agent.get('/account/verify-email').expect(200)).text;
    expect(page).not.toContain('name="newEmail"');
    expect(page).not.toContain('/account/verify-email/resend');
  });
});

describe('sending the link again', () => {
  test('sends another email while unconfirmed and nothing once confirmed', async () => {
    const a = await register();
    await flush();
    const path = lastLink();

    const resend = await a.agent.post('/account/verify-email/resend').expect(302);
    expect(resend.headers.location).toBe('/account/verify-email');
    await flush();
    expect(mailer.outbox).toHaveLength(2);

    await a.agent.post(path).expect(302);
    mailer.clearOutbox();
    await a.agent.post('/account/verify-email/resend').expect(302);
    await flush();
    expect(mailer.outbox).toEqual([]);
  });

  test('you must be logged in', async () => {
    expect((await request(app).post('/account/verify-email/resend').expect(302)).headers.location).toBe('/login');
  });
});

describe('changing the address', () => {
  test('a wrong password changes nothing', async () => {
    const a = await register();
    await flush();
    mailer.clearOutbox();

    const res = await a.agent.post('/account/email').type('form').send({ password: 'nope', newEmail: 'fixed@example.com' }).expect(302);
    expect(res.headers.location).toBe('/account/verify-email');
    expect(emailOf(a.id)).toBe(a.email);
    await flush();
    expect(mailer.outbox).toEqual([]);
  });

  test('a good change moves the link to the new address and kills the old link', async () => {
    const a = await register();
    await flush();
    const oldPath = lastLink();
    mailer.clearOutbox();
    const fixed = `fixed_${a.username}@example.com`;

    await a.agent.post('/account/email').type('form').send({ password: 'secret123', newEmail: fixed }).expect(302);
    await flush();

    expect(emailOf(a.id)).toBe(fixed);
    expect(pendingOf(a.id)).toBe(1);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].to).toBe(fixed);

    await request(app).get(oldPath).expect(400);
    const newPath = lastLink();
    await request(app).get(newPath).expect(200);
    await a.agent.post(newPath).expect(302);
    expect(pendingOf(a.id)).toBe(0);
  });

  test('an address that belongs to someone else is refused', async () => {
    const a = await register();
    const b = await register();
    await a.agent.post('/account/email').type('form').send({ password: 'secret123', newEmail: b.email.toUpperCase() }).expect(302);
    expect(emailOf(a.id)).toBe(a.email);
  });
});

describe('password reset', () => {
  test('no reset link goes to an unconfirmed address, and one does after confirmation', async () => {
    const a = await register();
    await flush();
    const path = lastLink();

    await request(app).post('/forgot-password').type('form').send({ email: a.email }).expect(302);
    await flush();
    expect(mailer.outbox).toHaveLength(1); // only the confirmation email from registration

    await request(app).post(path).type('form').send({}).expect(302);
    await request(app).post('/forgot-password').type('form').send({ email: a.email }).expect(302);
    await flush();
    expect(mailer.outbox).toHaveLength(2);
    expect(mailer.outbox[1].subject).toMatch(/reset/i);
  });
});
