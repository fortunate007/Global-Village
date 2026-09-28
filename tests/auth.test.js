const request = require('supertest');
const { app, registerAndLogin } = require('./helpers');

describe('auth', () => {
  test('registering with valid data logs the user in and redirects to /users', async () => {
    const res = await request(app).post('/register').type('form').send({
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'Passw0rd!x',
      confirmPassword: 'Passw0rd!x',
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/users');
  });

  test('rejects an invalid email address', async () => {
    const res = await request(app).post('/register').type('form').send({
      username: 'bob',
      email: 'not-an-email',
      displayName: 'Bob',
      password: 'Passw0rd!x',
      confirmPassword: 'Passw0rd!x',
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain('valid email');
  });

  test('rejects a duplicate username', async () => {
    await request(app).post('/register').type('form').send({
      username: 'carol',
      email: 'carol1@example.com',
      displayName: 'Carol',
      password: 'Passw0rd!x',
      confirmPassword: 'Passw0rd!x',
    });

    const res = await request(app).post('/register').type('form').send({
      username: 'carol',
      email: 'carol2@example.com',
      displayName: 'Carol Two',
      password: 'Passw0rd!x',
      confirmPassword: 'Passw0rd!x',
    });

    expect(res.text).toContain('already taken');
  });

  test('rejects mismatched passwords', async () => {
    const res = await request(app).post('/register').type('form').send({
      username: 'dave',
      email: 'dave@example.com',
      displayName: 'Dave',
      password: 'Passw0rd!x',
      confirmPassword: 'somethingElse1',
    });

    expect(res.text).toContain('do not match');
  });

  test('logging in with the wrong password fails', async () => {
    await request(app).post('/register').type('form').send({
      username: 'erin',
      email: 'erin@example.com',
      displayName: 'Erin',
      password: 'Passw0rd!x',
      confirmPassword: 'Passw0rd!x',
    });

    const res = await request(app).post('/login').type('form').send({
      username: 'erin',
      password: 'wrongPassword1',
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('a logged-in user can log out and is then redirected to /login when visiting /users', async () => {
    const { agent } = await registerAndLogin({ username: 'finn' });

    const loggedIn = await agent.get('/users');
    expect(loggedIn.status).toBe(200);

    await agent.post('/logout');
    const afterLogout = await agent.get('/users');
    expect(afterLogout.status).toBe(302);
    expect(afterLogout.headers.location).toBe('/login');
  });

  test('an anonymous visitor is redirected away from a protected page', async () => {
    const res = await request(app).get('/users');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
