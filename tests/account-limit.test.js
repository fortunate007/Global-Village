process.env.TEST_RATE_LIMITS = '1';

const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

test('guessing the password on the deletion form is limited to 5 wrong attempts', async () => {
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username: 'guessme',
      email: 'guessme@example.com',
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: 'Guess',
    })
    .expect(302);

  const wrongGuess = () => agent.post('/account/delete').type('form').send({ password: 'nope', confirm: 'yes' });

  for (let i = 0; i < 5; i += 1) {
    expect((await wrongGuess().expect(302)).headers.location).toBe('/account/delete');
  }
  await wrongGuess().expect(429);

  // Even the right password is refused during the lockout, and nothing was deleted
  await agent.post('/account/delete').type('form').send({ password: 'secret123', confirm: 'yes' }).expect(429);
  expect(db.prepare("SELECT 1 FROM users WHERE username = 'guessme'").get()).toBeDefined();
});
