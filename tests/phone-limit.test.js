process.env.TEST_RATE_LIMITS = '1';
process.env.APP_URL = 'https://app.test';

const request = require('supertest');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

test('asking for reset codes is limited to 5 per hour per address', async () => {
  const ask = () => request(app).post('/forgot-password/phone').type('form').send({ phone: '0712345678' });

  for (let i = 0; i < 5; i += 1) await ask().expect(302);
  const blocked = await ask().expect(429);
  expect(blocked.text).toMatch(/too many/i);
});

test('wrong passwords on the phone form are limited to 5 per 15 minutes', async () => {
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username: 'phlimit',
      email: 'phlimit@example.com',
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: 'Limit',
    })
    .expect(302);

  const wrong = () => agent.post('/account/phone').type('form').send({ phone: '0712345678', password: 'nope' });
  for (let i = 0; i < 5; i += 1) {
    expect((await wrong().expect(302)).headers.location).toBe('/account/phone');
  }
  await wrong().expect(429);
});
