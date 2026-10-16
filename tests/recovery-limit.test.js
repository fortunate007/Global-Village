process.env.TEST_RATE_LIMITS = '1';
process.env.APP_URL = 'https://app.test';

const request = require('supertest');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

test('asking for reset links is limited to 5 per hour per address', async () => {
  const ask = () => request(app).post('/forgot-password').type('form').send({ email: 'someone@example.com' });

  for (let i = 0; i < 5; i += 1) await ask().expect(302);
  const blocked = await ask().expect(429);
  expect(blocked.text).toMatch(/too many/i);
});
