process.env.TEST_RATE_LIMITS = '1';

const request = require('supertest');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

test('wrong passwords do not use up the downloads, and the sixth download in an hour is refused', async () => {
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username: 'exportlimit',
      email: 'exportlimit@example.com',
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: 'Limit',
    })
    .expect(302);

  const send = (password) => agent.post('/account/export').type('form').send({ password });

  for (let i = 0; i < 3; i += 1) await send('nope').expect(302);
  for (let i = 0; i < 5; i += 1) await send('secret123').expect(200);

  const blocked = await send('secret123').expect(429);
  expect(blocked.text).toMatch(/too many/i);
});
