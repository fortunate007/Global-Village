// These tests switch the limiter on, because the rest of the suite runs with it off
process.env.TEST_RATE_LIMITS = '1';

const request = require('supertest');
const app = require('../src/app');

afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

const login = (password) =>
  request(app).post('/login').type('form').send({ username: 'limituser', password });

test('failed logins count toward the limit, successful ones do not, and the lockout is real', async () => {
  await request(app)
    .post('/register')
    .type('form')
    .send({
      username: 'limituser',
      email: 'limit@example.com',
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: 'Limit',
    })
    .expect(302);

  // 9 failures, each answered with the normal redirect back to the login page
  for (let i = 0; i < 9; i += 1) {
    const res = await login('wrong-password').expect(302);
    expect(res.headers.location).toBe('/login');
  }

  // A correct login in between works and is not counted
  const ok = await login('secret123').expect(302);
  expect(ok.headers.location).toBe('/users');

  // The 10th failure is still allowed. If the success above had been counted, this would be blocked.
  expect((await login('wrong-password').expect(302)).headers.location).toBe('/login');

  // The 11th failure is blocked, and from then on even the correct password is refused
  const blocked = await login('wrong-password').expect(429);
  expect(blocked.text).toMatch(/too many/i);
  await login('secret123').expect(429);
});
