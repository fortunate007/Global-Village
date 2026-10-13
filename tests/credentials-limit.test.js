process.env.TEST_RATE_LIMITS = '1';

const request = require('supertest');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

test('guessing the current password is limited to 5 wrong attempts across both forms', async () => {
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username: 'credguess',
      email: 'credguess@example.com',
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: 'Guess',
    })
    .expect(302);

  const guessOnPasswordForm = () =>
    agent.post('/account/password').type('form').send({ currentPassword: 'nope', newPassword: 'brandnew789', confirmPassword: 'brandnew789' });
  const guessOnRevokeForm = () => agent.post('/account/sessions/revoke').type('form').send({ currentPassword: 'nope' });

  for (let i = 0; i < 3; i += 1) await guessOnPasswordForm().expect(302);
  for (let i = 0; i < 2; i += 1) await guessOnRevokeForm().expect(302);
  await guessOnPasswordForm().expect(429);

  // Even the right password is refused during the lockout
  await agent
    .post('/account/password')
    .type('form')
    .send({ currentPassword: 'secret123', newPassword: 'brandnew789', confirmPassword: 'brandnew789' })
    .expect(429);
});
