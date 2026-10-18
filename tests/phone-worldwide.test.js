process.env.APP_URL = 'https://app.test';

const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const sms = require('../src/services/sms');

let counter = 0;
async function register(extra = {}) {
  counter += 1;
  const username = `ww_${counter}_u`;
  const agent = request.agent(app);
  await agent
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
  return { id, username, agent };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const codeFrom = (message) => message.text.match(/\b(\d{6})\b/)[1];
const lastSms = () => sms.outbox[sms.outbox.length - 1];
const userRow = (id) => db.prepare('SELECT phone, phone_verified_at FROM users WHERE id = ?').get(id);

beforeEach(() => sms.clearOutbox());

test('the account and reset pages offer every country, with Kenya preselected', async () => {
  const a = await register();
  const pages = [
    (await a.agent.get('/account/phone').expect(200)).text,
    (await request(app).get('/forgot-password/phone').expect(200)).text,
  ];

  pages.forEach((page) => {
    expect(page).toContain('name="phoneCountry"');
    expect(page).toContain('<option value="KE" selected>Kenya (+254)</option>');
    expect(page).toContain('<option value="NG">Nigeria (+234)</option>');
    expect(page).toContain('<option value="US">United States (+1)</option>');
    expect((page.match(/<option value=/g) || []).length).toBeGreaterThan(200);
  });
});

test('a number from another country is added with its country and then verified', async () => {
  const a = await register();
  await a.agent.post('/account/phone').type('form').send({ phone: '(213) 373-4253', phoneCountry: 'US', password: 'secret123' }).expect(302);
  await flush();

  expect(userRow(a.id)).toEqual({ phone: '+12133734253', phone_verified_at: null });
  expect(lastSms().to).toBe('+12133734253');

  await a.agent.post('/account/phone/verify').type('form').send({ code: codeFrom(lastSms()) }).expect(302);
  expect(userRow(a.id).phone_verified_at).toBeTruthy();
});

test('a number that does not belong to the selected country is refused and nothing is sent', async () => {
  const a = await register();
  await a.agent.post('/account/phone').type('form').send({ phone: '0802 123 4567', phoneCountry: 'US', password: 'secret123' }).expect(302);
  await flush();

  expect(userRow(a.id).phone).toBeNull();
  expect(sms.outbox).toEqual([]);
});

describe('registration', () => {
  test('uses the selected country', async () => {
    const a = await register({ phone: '0802 123 4567', phoneCountry: 'NG' });
    await flush();

    expect(userRow(a.id)).toEqual({ phone: '+2348021234567', phone_verified_at: null });
    expect(lastSms().to).toBe('+2348021234567');
  });

  test('a number starting with + wins over the selected country', async () => {
    const a = await register({ phone: '+44 20 8765 4321', phoneCountry: 'KE' });
    await flush();

    expect(userRow(a.id).phone).toBe('+442087654321');
    expect(lastSms().to).toBe('+442087654321');
  });

  test('a number that does not fit the selected country is not used, and registration still works', async () => {
    const a = await register({ phone: '0802 123 4567', phoneCountry: 'US' });
    await flush();

    expect(userRow(a.id).phone).toBeNull();
    expect(sms.outbox).toEqual([]);
  });
});

describe('resetting a password by text message', () => {
  test('works for a number from any country, typed the national way', async () => {
    const a = await register();
    db.prepare('UPDATE users SET phone = ?, phone_verified_at = CURRENT_TIMESTAMP WHERE id = ?').run('+4915123456789', a.id);

    const guest = request.agent(app);
    const asked = await guest.post('/forgot-password/phone').type('form').send({ phone: '0151 23456789', phoneCountry: 'DE' }).expect(302);
    expect(asked.headers.location).toBe('/forgot-password/phone/code');
    await flush();
    expect(lastSms().to).toBe('+4915123456789');

    const right = await guest.post('/forgot-password/phone/code').type('form').send({ code: codeFrom(lastSms()) }).expect(302);
    expect(right.headers.location).toMatch(/^\/reset-password\/[A-Za-z0-9_-]{43}$/);
  });

  test('a number that does not fit the selected country is refused on the first page', async () => {
    const bad = await request(app).post('/forgot-password/phone').type('form').send({ phone: '0151 23456789', phoneCountry: 'US' }).expect(302);
    expect(bad.headers.location).toBe('/forgot-password/phone');
    await flush();
    expect(sms.outbox).toEqual([]);
  });
});

test('the registration page offers the same country list', async () => {
  const page = (await request(app).get('/register').expect(200)).text;
  expect(page).toContain('name="phoneCountry"');
  expect(page).toContain('<option value="KE" selected>Kenya (+254)</option>');
  expect((page.match(/<option value=/g) || []).length).toBeGreaterThan(200);
});
