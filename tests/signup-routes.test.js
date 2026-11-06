process.env.TEST_SIGNUP_VERIFICATION = '1';
process.env.APP_URL = 'https://app.test';

const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const mailer = require('../src/services/mailer');
const sms = require('../src/services/sms');

let counter = 0;
const form = (extra = {}) => {
  counter += 1;
  return {
    username: `sr_${counter}_u`,
    email: `sr_${counter}@example.com`,
    password: 'secret123',
    confirmPassword: 'secret123',
    displayName: 'Sign Up',
    ...extra,
  };
};
const kenya = () => `07${String(40000000 + (counter += 1))}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const codeFrom = (message) => message.text.match(/\b(\d{6})\b/)[1];
const lastMail = () => mailer.outbox[mailer.outbox.length - 1];
const lastSms = () => sms.outbox[sms.outbox.length - 1];
const userNamed = (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name);
const wrongFor = (code) => (code === '000000' ? '111111' : '000000');
const submit = (agent, data) => agent.post('/register').type('form').send(data);
const sendCode = (agent, code) => agent.post('/register/verify').type('form').send({ code });

beforeEach(() => {
  mailer.clearOutbox();
  sms.clearOutbox();
});

describe('signing up with an email address', () => {
  test('submitting the form creates no account, and the person cannot log in before verifying', async () => {
    const agent = request.agent(app);
    const data = form();
    const res = await submit(agent, data).expect(302);
    expect(res.headers.location).toBe('/register/verify');
    await flush();

    expect(userNamed(data.username)).toBeUndefined();
    const login = await request(app).post('/login').type('form').send({ username: data.username, password: 'secret123' }).expect(302);
    expect(login.headers.location).toBe('/login');

    const page = await agent.get('/register/verify').expect(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).toContain('name="code"');
    expect(page.text).toContain(`${data.email[0]}***@example.com`);
    expect(page.text).not.toContain(data.email);
  });

  test('a wrong code changes nothing, the right code creates the account and logs the person in', async () => {
    const agent = request.agent(app);
    const data = form();
    await submit(agent, data).expect(302);
    await flush();
    const code = codeFrom(lastMail());

    const wrong = await sendCode(agent, wrongFor(code)).expect(302);
    expect(wrong.headers.location).toBe('/register/verify');
    expect(userNamed(data.username)).toBeUndefined();

    const right = await sendCode(agent, code).expect(302);
    expect(right.headers.location).toBe('/users');
    await agent.get('/users').expect(200);

    expect(userNamed(data.username)).toMatchObject({ email: data.email, email_pending_verification: 0 });
    expect((await agent.get('/register/verify').expect(302)).headers.location).toBe('/users');
  });

  test('a new code can be requested, and the sign-up can be cancelled', async () => {
    const agent = request.agent(app);
    const data = form();
    await submit(agent, data).expect(302);
    await flush();

    expect((await agent.post('/register/resend').expect(302)).headers.location).toBe('/register/verify');
    await flush();
    expect(mailer.outbox).toHaveLength(2);

    expect((await agent.post('/register/cancel').expect(302)).headers.location).toBe('/register');
    expect((await agent.get('/register/verify').expect(302)).headers.location).toBe('/register');
    expect(userNamed(data.username)).toBeUndefined();
  });

  test('five wrong codes end the sign-up', async () => {
    const agent = request.agent(app);
    const data = form();
    await submit(agent, data).expect(302);
    await flush();
    const code = codeFrom(lastMail());

    for (let i = 0; i < 4; i += 1) {
      expect((await sendCode(agent, wrongFor(code)).expect(302)).headers.location).toBe('/register/verify');
    }
    expect((await sendCode(agent, wrongFor(code)).expect(302)).headers.location).toBe('/register');
    expect((await agent.get('/register/verify').expect(302)).headers.location).toBe('/register');
    expect(userNamed(data.username)).toBeUndefined();
  });
});

describe('signing up with a phone number', () => {
  test('works with a number from another country, and the account starts with a stand-in email', async () => {
    const agent = request.agent(app);
    const data = form({ email: '', phone: '0802 123 4567', phoneCountry: 'NG' });
    await submit(agent, data).expect(302);
    await flush();

    expect(mailer.outbox).toEqual([]);
    expect(lastSms().to).toBe('+2348021234567');
    expect((await agent.get('/register/verify').expect(200)).text).toContain('567</strong>');

    expect((await sendCode(agent, codeFrom(lastSms())).expect(302)).headers.location).toBe('/users');
    await agent.get('/users').expect(200);

    const user = userNamed(data.username);
    expect(user).toMatchObject({ phone: '+2348021234567', email_pending_verification: 1 });
    expect(user.phone_verified_at).toBeTruthy();
    expect(user.email).toMatch(/@phone-signup\.invalid$/);

    const page = (await agent.get('/account/verify-email').expect(200)).text;
    expect(page).toContain('no email address');
    expect(page).toContain('name="newEmail"');
    expect(page).not.toContain('phone-signup.invalid');
  });

  test('with both contacts, the chosen one gets the code', async () => {
    const agent = request.agent(app);
    await submit(agent, form({ phone: kenya(), verifyBy: 'phone' })).expect(302);
    await flush();
    expect(sms.outbox).toHaveLength(1);
    expect(mailer.outbox).toEqual([]);
  });
});

describe('mistakes', () => {
  test('the form is shown again with every message, and nothing is parked or sent', async () => {
    const res = await submit(request.agent(app), form({ email: '', phone: '' })).expect(200);
    expect(res.text).toContain('Enter an email address or a phone number to verify.');
    await flush();
    expect(mailer.outbox).toEqual([]);
    expect(sms.outbox).toEqual([]);

    const many = await submit(request.agent(app), { username: 'x', email: 'bad', password: 'abc', confirmPassword: 'abd' }).expect(200);
    expect(many.text).toContain('Username must be');
    expect(many.text).toContain('valid email');
  });

  test('a username or email that is taken is refused', async () => {
    const first = request.agent(app);
    const data = form();
    await submit(first, data).expect(302);
    await flush();
    await sendCode(first, codeFrom(lastMail())).expect(302);

    const again = await submit(request.agent(app), form({ username: data.username })).expect(200);
    expect(again.text).toContain('already taken');
  });

  test('the verification pages need a sign-up in progress, and are not for logged-in people', async () => {
    expect((await request(app).get('/register/verify').expect(302)).headers.location).toBe('/register');
    expect((await sendCode(request.agent(app), '123456').expect(302)).headers.location).toBe('/register');
    expect((await request(app).post('/register/resend').expect(302)).headers.location).toBe('/register');
  });

  test('cross-site requests are refused', async () => {
    await request(app).post('/register').set('Sec-Fetch-Site', 'cross-site').type('form').send(form()).expect(403);
  });
});

test('with verification switched off, registration works the old way', async () => {
  process.env.REQUIRE_SIGNUP_VERIFICATION = 'false';
  try {
    const data = form();
    const res = await submit(request.agent(app), data).expect(302);
    expect(res.headers.location).toBe('/users');
    expect(userNamed(data.username)).toBeDefined();
  } finally {
    delete process.env.REQUIRE_SIGNUP_VERIFICATION;
  }
});

test('the registration page lets people choose how to verify, with no email required', async () => {
  const page = (await request(app).get('/register').expect(200)).text;
  expect(page).toContain('name="verifyBy"');
  expect(page).toContain('name="phoneCountry"');
  expect(page).not.toMatch(/<input[^>]*name="email"[^>]*\srequired/);
});
