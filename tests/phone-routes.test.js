process.env.APP_URL = 'https://app.test';

const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const sms = require('../src/services/sms');
const phones = require('../src/services/phoneService');

let counter = 0;
let numberCounter = 0;
const local = () => `07${String(20000000 + (numberCounter += 1))}`;
const intl = (number) => `+254${number.slice(1)}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const codeFrom = (message) => message.text.match(/\b(\d{6})\b/)[1];
const lastSms = () => sms.outbox[sms.outbox.length - 1];
const wrongFor = (code) => (code === '000000' ? '111111' : '000000');
const userRow = (id) => db.prepare('SELECT phone, phone_verified_at FROM users WHERE id = ?').get(id);

async function register(extra = {}) {
  counter += 1;
  const username = `phr_${counter}_u`;
  const agent = request.agent(app);
  const res = await agent
    .post('/register')
    .type('form')
    .send({
      username,
      email: `${username}@example.com`,
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: username,
      ...extra,
    })
    .expect(302);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return { id, username, agent, res };
}

function verifyNumber(userId, number) {
  db.prepare('UPDATE users SET phone = ?, phone_verified_at = CURRENT_TIMESTAMP WHERE id = ?').run(intl(number), userId);
}

beforeEach(() => sms.clearOutbox());

describe('registration', () => {
  test('without a number nothing happens', async () => {
    const a = await register();
    await flush();
    expect(a.res.headers.location).toBe('/users');
    expect(userRow(a.id)).toEqual({ phone: null, phone_verified_at: null });
    expect(sms.outbox).toEqual([]);
  });

  test('a good number is saved unverified and a code is texted', async () => {
    const number = local();
    const a = await register({ phone: number });
    await flush();

    expect(a.res.headers.location).toBe('/users');
    expect(userRow(a.id)).toEqual({ phone: intl(number), phone_verified_at: null });
    expect(sms.outbox).toHaveLength(1);
    expect(lastSms().to).toBe(intl(number));
    await a.agent.get('/users').expect(200);
  });

  test('a bad number never stops registration', async () => {
    const a = await register({ phone: 'not a number' });
    await flush();
    expect(a.res.headers.location).toBe('/users');
    expect(userRow(a.id).phone).toBeNull();
    expect(sms.outbox).toEqual([]);
  });

  test('a number that someone else already verified is not used, and registration still works', async () => {
    const owner = await register();
    const number = local();
    verifyNumber(owner.id, number);

    const a = await register({ phone: number });
    await flush();
    expect(a.res.headers.location).toBe('/users');
    expect(userRow(a.id).phone).toBeNull();
    expect(sms.outbox).toEqual([]);
  });
});

describe('the account page', () => {
  test('you must be logged in for the page and every form', async () => {
    expect((await request(app).get('/account/phone').expect(302)).headers.location).toBe('/login');
    for (const path of ['/account/phone', '/account/phone/verify', '/account/phone/resend', '/account/phone/remove']) {
      expect((await request(app).post(path).type('form').send({}).expect(302)).headers.location).toBe('/login');
    }
  });

  test('adding, verifying, resending and removing a number', async () => {
    const a = await register();
    let page = (await a.agent.get('/account/phone').expect(200)).text;
    expect(page).toContain('Add a number');
    expect(page).not.toContain('/account/phone/verify');

    // A wrong password changes nothing
    const number = local();
    await a.agent.post('/account/phone').type('form').send({ phone: number, password: 'nope' }).expect(302);
    expect(userRow(a.id).phone).toBeNull();

    const added = await a.agent.post('/account/phone').type('form').send({ phone: number, password: 'secret123' }).expect(302);
    expect(added.headers.location).toBe('/account/phone');
    await flush();
    expect(userRow(a.id)).toEqual({ phone: intl(number), phone_verified_at: null });
    page = (await a.agent.get('/account/phone').expect(200)).text;
    expect(page).toContain(intl(number));
    expect(page).toContain('/account/phone/verify');
    expect(a.res).toBeDefined();

    // Wrong code, then the right one
    const code = codeFrom(lastSms());
    await a.agent.post('/account/phone/verify').type('form').send({ code: wrongFor(code) }).expect(302);
    expect(userRow(a.id).phone_verified_at).toBeNull();
    await a.agent.post('/account/phone/verify').type('form').send({ code }).expect(302);
    expect(userRow(a.id).phone_verified_at).toBeTruthy();
    page = (await a.agent.get('/account/phone').expect(200)).text;
    expect(page).toContain('is verified');

    // Nothing more to resend once verified
    sms.clearOutbox();
    await a.agent.post('/account/phone/resend').expect(302);
    await flush();
    expect(sms.outbox).toEqual([]);

    // Removing needs the password
    await a.agent.post('/account/phone/remove').type('form').send({ password: 'nope' }).expect(302);
    expect(userRow(a.id).phone).not.toBeNull();
    await a.agent.post('/account/phone/remove').type('form').send({ password: 'secret123' }).expect(302);
    expect(userRow(a.id)).toEqual({ phone: null, phone_verified_at: null });
  });

  test('a new code can be requested while the number is unverified', async () => {
    const a = await register({ phone: local() });
    await flush();
    sms.clearOutbox();

    await a.agent.post('/account/phone/resend').expect(302);
    await flush();
    expect(sms.outbox).toHaveLength(1);
  });

  test('cross-site requests are refused', async () => {
    const a = await register();
    await a.agent.post('/account/phone').set('Sec-Fetch-Site', 'cross-site').type('form').send({ phone: local(), password: 'secret123' }).expect(403);
    expect(userRow(a.id).phone).toBeNull();
  });

  test('other people never see the number', async () => {
    const a = await register();
    const b = await register();
    const number = local();
    verifyNumber(a.id, number);

    const page = (await b.agent.get(`/profile/${a.id}`).expect(200)).text;
    expect(page).not.toContain(number.slice(-8));
    expect(page).not.toContain(intl(number));
  });
});

describe('resetting a password by text message', () => {
  async function verifiedAccount() {
    const a = await register();
    const number = local();
    verifyNumber(a.id, number);
    await flush();
    sms.clearOutbox();
    return { ...a, number };
  }

  test('the pages are for guests', async () => {
    const page = await request(app).get('/forgot-password/phone').expect(200);
    expect(page.text).toContain('name="phone"');

    const a = await register();
    expect((await a.agent.get('/forgot-password/phone').expect(302)).headers.location).toBe('/users');
    expect((await a.agent.post('/forgot-password/phone').type('form').send({ phone: local() }).expect(302)).headers.location).toBe('/users');
  });

  test('the whole flow: ask for a code, enter it, choose a new password, log in, and the code cannot be reused', async () => {
    const a = await verifiedAccount();
    const guest = request.agent(app);

    const asked = await guest.post('/forgot-password/phone').type('form').send({ phone: a.number }).expect(302);
    expect(asked.headers.location).toBe('/forgot-password/phone/code');
    await flush();
    expect(lastSms().to).toBe(intl(a.number));
    const code = lastSms() && codeFrom(lastSms());

    const codePage = await guest.get('/forgot-password/phone/code').expect(200);
    expect(codePage.headers['cache-control']).toBe('no-store');
    expect(codePage.text).toContain(phones.mask(intl(a.number)));
    expect(codePage.text).not.toContain(intl(a.number));

    const wrong = await guest.post('/forgot-password/phone/code').type('form').send({ code: wrongFor(code) }).expect(302);
    expect(wrong.headers.location).toBe('/forgot-password/phone/code');

    const right = await guest.post('/forgot-password/phone/code').type('form').send({ code }).expect(302);
    expect(right.headers.location).toMatch(/^\/reset-password\/[A-Za-z0-9_-]{43}$/);

    await guest.get(right.headers.location).expect(200);
    const done = await guest
      .post(right.headers.location)
      .type('form')
      .send({ password: 'Brand-new-pass-77', confirmPassword: 'Brand-new-pass-77' })
      .expect(302);
    expect(done.headers.location).toBe('/login');

    const login = (password) => request(app).post('/login').type('form').send({ username: a.username, password });
    expect((await login('Brand-new-pass-77').expect(302)).headers.location).toBe('/users');
    expect((await login('secret123').expect(302)).headers.location).toBe('/login');

    // Every older session is logged out, and the used code leads nowhere
    expect((await a.agent.get('/users').expect(302)).headers.location).toBe('/login');
    expect((await guest.post('/forgot-password/phone/code').type('form').send({ code }).expect(302)).headers.location).toBe('/forgot-password/phone');
  });

  test('a number that belongs to no account gets the same answers and no text', async () => {
    const a = await verifiedAccount();
    const known = request.agent(app);
    const unknown = request.agent(app);

    const knownAnswer = await known.post('/forgot-password/phone').type('form').send({ phone: a.number }).expect(302);
    const unknownAnswer = await unknown.post('/forgot-password/phone').type('form').send({ phone: local() }).expect(302);
    await flush();

    expect(unknownAnswer.headers.location).toBe(knownAnswer.headers.location);
    expect(sms.outbox).toHaveLength(1); // only the real account's number was texted
    expect((await unknown.get('/forgot-password/phone/code').expect(200)).text).toContain('we sent it a 6-digit code');

    // Entering any code for the unknown number just fails like a wrong code does
    const failed = await unknown.post('/forgot-password/phone/code').type('form').send({ code: '123456' }).expect(302);
    expect(failed.headers.location).toBe('/forgot-password/phone/code');
  });

  test('an unverified number gets no reset code', async () => {
    const a = await register({ phone: local() });
    await flush();
    sms.clearOutbox();
    const number = userRow(a.id).phone.replace('+254', '0');

    const guest = request.agent(app);
    await guest.post('/forgot-password/phone').type('form').send({ phone: number }).expect(302);
    await flush();
    expect(sms.outbox).toEqual([]);
  });

  test('a badly written number is refused on the first page, and the code page needs the first step', async () => {
    const guest = request.agent(app);
    const bad = await guest.post('/forgot-password/phone').type('form').send({ phone: 'abc' }).expect(302);
    expect(bad.headers.location).toBe('/forgot-password/phone');

    expect((await guest.get('/forgot-password/phone/code').expect(302)).headers.location).toBe('/forgot-password/phone');
    expect((await guest.post('/forgot-password/phone/code').type('form').send({ code: '123456' }).expect(302)).headers.location).toBe('/forgot-password/phone');
  });

  test('five wrong codes lock the code, and a fresh request starts over', async () => {
    const a = await verifiedAccount();
    const guest = request.agent(app);
    await guest.post('/forgot-password/phone').type('form').send({ phone: a.number }).expect(302);
    await flush();
    const code = codeFrom(lastSms());

    for (let i = 0; i < 5; i += 1) {
      await guest.post('/forgot-password/phone/code').type('form').send({ code: wrongFor(code) }).expect(302);
    }
    const locked = await guest.post('/forgot-password/phone/code').type('form').send({ code }).expect(302);
    expect(locked.headers.location).toBe('/forgot-password/phone/code');

    sms.clearOutbox();
    await guest.post('/forgot-password/phone').type('form').send({ phone: a.number }).expect(302);
    await flush();
    const fresh = await guest.post('/forgot-password/phone/code').type('form').send({ code: codeFrom(lastSms()) }).expect(302);
    expect(fresh.headers.location).toMatch(/^\/reset-password\//);
  });

  test('cross-site requests are refused', async () => {
    await request(app).post('/forgot-password/phone').set('Sec-Fetch-Site', 'cross-site').type('form').send({ phone: local() }).expect(403);
  });
});

test('the registration page offers an optional phone field', async () => {
  const page = (await request(app).get('/register').expect(200)).text;
  expect(page).toContain('name="phone"');
});

test('the data export includes your own number', async () => {
  const exportService = require('../src/services/exportService');
  const a = await register();
  const number = local();
  verifyNumber(a.id, number);

  const data = exportService.buildExport(a.id);
  expect(data.profile.phone).toBe(intl(number));
  expect(data.profile.phone_verified_at).toBeTruthy();
});
