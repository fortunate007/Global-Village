process.env.TEST_RATE_LIMITS = '1';

const request = require('supertest');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

test('guessing the password on the export form is limited to 5 wrong attempts', async () => {
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username: 'exportguess',
      email: 'exportguess@example.com',
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: 'Guess',
    })
    .expect(302);

  const wrong = () => agent.post('/account/export').type('form').send({ password: 'nope' });

  for (let i = 0; i < 5; i += 1) {
    expect((await wrong().expect(302)).headers.location).toBe('/account/export');
  }
  await wrong().expect(429);

  // Even the right password is refused during the lockout
  await agent.post('/account/export').type('form').send({ password: 'secret123' }).expect(429);
});
