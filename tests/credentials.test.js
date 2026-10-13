const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');

let counter = 0;
async function makeAccount(name) {
  counter += 1;
  const username = `${name}_${counter}_cred`;
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
    })
    .expect(302);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return { id, username, agent };
}

async function signIn(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form').send({ username, password });
  return { agent, location: res.headers.location };
}

const epochOf = (id) => db.prepare('SELECT session_epoch FROM users WHERE id = ?').get(id).session_epoch;
const change = (user, current, next, confirm = next) =>
  user.agent.post('/account/password').type('form').send({ currentPassword: current, newPassword: next, confirmPassword: confirm });
const revoke = (user, password) =>
  user.agent.post('/account/sessions/revoke').type('form').send({ currentPassword: password });

describe('access', () => {
  test('you must be logged in for the page and for both forms', async () => {
    expect((await request(app).get('/account/security').expect(302)).headers.location).toBe('/login');
    expect((await request(app).post('/account/password').type('form').send({}).expect(302)).headers.location).toBe('/login');
    expect((await request(app).post('/account/sessions/revoke').type('form').send({}).expect(302)).headers.location).toBe('/login');
  });

  test('the page shows both forms', async () => {
    const a = await makeAccount('alice');
    const page = (await a.agent.get('/account/security').expect(200)).text;
    expect(page).toContain('/account/password');
    expect(page).toContain('/account/sessions/revoke');
  });
});

describe('changing the password', () => {
  test('a wrong current password changes nothing', async () => {
    const a = await makeAccount('alice');
    const before = epochOf(a.id);

    const res = await change(a, 'wrong-password', 'brandnew789').expect(302);
    expect(res.headers.location).toBe('/account/security');

    expect(epochOf(a.id)).toBe(before);
    expect((await signIn(a.username, 'secret123')).location).toBe('/users');
    expect((await signIn(a.username, 'brandnew789')).location).toBe('/login');
  });

  test('invalid new passwords change nothing', async () => {
    const a = await makeAccount('alice');
    const before = epochOf(a.id);

    for (const [next, confirm] of [
      ['brandnew789', 'different789'],
      ['abc', 'abc'],
      ['x'.repeat(73), 'x'.repeat(73)],
      ['secret123', 'secret123'],
      ['', ''],
    ]) {
      const res = await change(a, 'secret123', next, confirm).expect(302);
      expect(res.headers.location).toBe('/account/security');
    }
    await a.agent.post('/account/password').type('form').send({ currentPassword: 'secret123' }).expect(302);

    expect(epochOf(a.id)).toBe(before);
    expect((await signIn(a.username, 'secret123')).location).toBe('/users');
  });

  test('the new password works, the old one does not, and this device stays logged in', async () => {
    const a = await makeAccount('alice');
    const before = epochOf(a.id);

    const res = await change(a, 'secret123', 'brandnew789').expect(302);
    expect(res.headers.location).toBe('/account/security');
    expect(epochOf(a.id)).toBe(before + 1);

    await a.agent.get('/users').expect(200);
    expect((await signIn(a.username, 'secret123')).location).toBe('/login');

    const fresh = await signIn(a.username, 'brandnew789');
    expect(fresh.location).toBe('/users');
    await fresh.agent.get('/users').expect(200);
  });

  test('other devices are logged out at their next request, even though they signed in earlier', async () => {
    const a = await makeAccount('alice');
    const other = await signIn(a.username, 'secret123');
    await other.agent.get('/users').expect(200);

    await change(a, 'secret123', 'brandnew789').expect(302);

    const stale = await other.agent.get('/users').expect(302);
    expect(stale.headers.location).toBe('/login');
    await a.agent.get('/users').expect(200);

    // Logging in again on that device works with the new password
    const again = await signIn(a.username, 'brandnew789');
    await again.agent.get('/users').expect(200);
  });

  test('changing the password does not affect other people\'s sessions', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');

    await change(a, 'secret123', 'brandnew789').expect(302);

    await b.agent.get('/users').expect(200);
  });

  test('live chat connections of other devices are closed, this device\'s are kept', async () => {
    const a = await makeAccount('alice');
    const other = { disconnect: jest.fn(), userId: String(a.id), request: { sessionID: 'some-other-session' } };
    const stranger = { disconnect: jest.fn(), userId: String(a.id + 1000), request: { sessionID: 'x' } };
    const io = { of: () => ({ sockets: new Map([['1', other], ['2', stranger]]) }) };

    const original = app.get('io');
    app.set('io', io);
    try {
      await change(a, 'secret123', 'brandnew789').expect(302);
    } finally {
      app.set('io', original);
    }

    expect(other.disconnect).toHaveBeenCalledWith(true);
    expect(stranger.disconnect).not.toHaveBeenCalled();
  });
});

describe('logging out other devices', () => {
  test('a wrong password does nothing', async () => {
    const a = await makeAccount('alice');
    const other = await signIn(a.username, 'secret123');
    const before = epochOf(a.id);

    await revoke(a, 'wrong-password').expect(302);

    expect(epochOf(a.id)).toBe(before);
    await other.agent.get('/users').expect(200);
  });

  test('the right password logs out the others, keeps this device and keeps the password', async () => {
    const a = await makeAccount('alice');
    const other = await signIn(a.username, 'secret123');
    await other.agent.get('/users').expect(200);

    await revoke(a, 'secret123').expect(302);

    expect((await other.agent.get('/users').expect(302)).headers.location).toBe('/login');
    await a.agent.get('/users').expect(200);
    expect((await signIn(a.username, 'secret123')).location).toBe('/users');
  });
});
