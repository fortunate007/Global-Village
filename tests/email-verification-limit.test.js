process.env.TEST_RATE_LIMITS = '1';
process.env.TEST_EMAIL_VERIFICATION = '1';
process.env.APP_URL = 'https://app.test';

const request = require('supertest');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
  delete process.env.TEST_EMAIL_VERIFICATION;
});

test('wrong passwords on the change-address form are limited to 5 per 15 minutes', async () => {
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username: 'evlimit',
      email: 'evlimit@example.com',
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: 'Limit',
    })
    .expect(302);

  const wrong = () => agent.post('/account/email').type('form').send({ password: 'nope', newEmail: 'other@example.com' });

  for (let i = 0; i < 5; i += 1) {
    expect((await wrong().expect(302)).headers.location).toBe('/account/verify-email');
  }
  await wrong().expect(429);
});

test('confirmation attempts are limited to 20 per hour per address', async () => {
  const attempt = () => request(app).post(`/verify-email/${'a'.repeat(43)}`).type('form').send({});

  for (let i = 0; i < 20; i += 1) await attempt().expect(400);
  const blocked = await attempt().expect(429);
  expect(blocked.text).toMatch(/too many/i);
});
