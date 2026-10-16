const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const posts = require('../src/services/postService');
const safety = require('../src/services/safetyService');

let counter = 0;
async function makeAccount(name, { admin = false } = {}) {
  counter += 1;
  const username = `${name}_${counter}_mr`;
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username,
      email: `${username}@example.com`,
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: name,
    })
    .expect(302);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  if (admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
  return { id, username, agent };
}

const suspendedAt = (id) => db.prepare('SELECT suspended_at FROM users WHERE id = ?').get(id).suspended_at;
const suspend = (admin, id, body = {}) => admin.agent.post(`/admin/users/${id}/suspend`).type('form').send(body);
const unsuspend = (admin, id, body = {}) => admin.agent.post(`/admin/users/${id}/unsuspend`).type('form').send(body);

async function tryLogin(username, password = 'secret123') {
  const agent = request.agent(app);
  const res = await agent.post('/login').type('form').send({ username, password });
  return { agent, location: res.headers.location };
}

describe('access', () => {
  test('visitors and ordinary members cannot reach the admin pages or actions', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');

    await request(app).get('/admin/users').expect(404);
    await request(app).get('/admin/actions').expect(404);
    await a.agent.get('/admin/users').expect(404);
    await a.agent.get('/admin/actions').expect(404);
    await a.agent.post(`/admin/users/${b.id}/suspend`).type('form').send({}).expect(404);
    await a.agent.post(`/admin/users/${b.id}/unsuspend`).type('form').send({}).expect(404);
    await request(app).post(`/admin/users/${b.id}/suspend`).type('form').send({}).expect(404);

    expect(suspendedAt(b.id)).toBeNull();
    await b.agent.get('/users').expect(200);
  });

  test('admins see the pages', async () => {
    const admin = await makeAccount('admin', { admin: true });
    await admin.agent.get('/admin/users').expect(200);
    await admin.agent.get('/admin/actions').expect(200);
  });
});

describe('suspending and unsuspending', () => {
  test('the whole flow: logged out at once, locked out of logging in, then back after unsuspending', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const b = await makeAccount('bob');
    await b.agent.get('/users').expect(200);

    const res = await suspend(admin, b.id, { reason: 'spam wave' }).expect(302);
    expect(res.headers.location).toBe('/admin/users');
    expect(suspendedAt(b.id)).toBeTruthy();

    // The open session stops working on its next request
    expect((await b.agent.get('/users').expect(302)).headers.location).toBe('/login');

    // Logging in again is refused, even with the right password
    const refused = await tryLogin(b.username);
    expect(refused.location).toBe('/login');
    expect((await refused.agent.get('/users').expect(302)).headers.location).toBe('/login');

    // Admins can see it
    const accounts = (await admin.agent.get('/admin/users').expect(200)).text;
    expect(accounts).toContain(`@${b.username}`);
    expect(accounts).toContain('spam wave');
    expect(accounts).toContain(`/admin/users/${b.id}/unsuspend`);
    const log = (await admin.agent.get('/admin/actions').expect(200)).text;
    expect(log).toContain(`@${b.username}`);
    expect(log).toContain('spam wave');
    expect(log).toContain('suspended');

    // Unsuspending lets them log in again, but old sessions stay dead
    expect((await unsuspend(admin, b.id, { reason: 'appeal accepted' }).expect(302)).headers.location).toBe('/admin/users');
    expect(suspendedAt(b.id)).toBeNull();
    expect((await b.agent.get('/users').expect(302)).headers.location).toBe('/login');

    const fresh = await tryLogin(b.username);
    expect(fresh.location).toBe('/users');
    await fresh.agent.get('/users').expect(200);

    const after = (await admin.agent.get('/admin/actions').expect(200)).text;
    expect(after).toContain('appeal accepted');
    expect(after).toContain('unsuspended');
  });

  test('other people are not affected', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const b = await makeAccount('bob');
    const c = await makeAccount('carol');

    await suspend(admin, b.id, {}).expect(302);
    await c.agent.get('/users').expect(200);
    await admin.agent.get('/users').expect(200);
  });

  test('only the two known return places are used, never an address from the form', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const b = await makeAccount('bob');
    const c = await makeAccount('carol');

    expect((await suspend(admin, b.id, { from: 'reports' }).expect(302)).headers.location).toBe('/admin/reports');
    expect((await suspend(admin, c.id, { from: 'https://evil.example' }).expect(302)).headers.location).toBe('/admin/users');
    expect((await unsuspend(admin, b.id, { from: 'reports' }).expect(302)).headers.location).toBe('/admin/reports');
  });

  test('refusals change nothing: yourself, another admin, unknown accounts, bad addresses and repeats', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const otherAdmin = await makeAccount('admin2', { admin: true });
    const b = await makeAccount('bob');

    expect((await suspend(admin, admin.id).expect(302)).headers.location).toBe('/admin/users');
    expect(suspendedAt(admin.id)).toBeNull();
    await suspend(admin, otherAdmin.id).expect(302);
    expect(suspendedAt(otherAdmin.id)).toBeNull();
    await suspend(admin, 999999).expect(302);

    await admin.agent.post('/admin/users/abc/suspend').type('form').send({}).expect(404);

    await suspend(admin, b.id).expect(302);
    const logged = db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n;
    await suspend(admin, b.id).expect(302);
    await unsuspend(admin, otherAdmin.id).expect(302);
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_actions').get().n).toBe(logged);

    await admin.agent.get('/users').expect(200);
    await otherAdmin.agent.get('/users').expect(200);
  });

  test('open chat connections of the suspended account are closed', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const b = await makeAccount('bob');
    const c = await makeAccount('carol');
    const mine = { disconnect: jest.fn(), userId: String(b.id), request: { sessionID: 'phone' } };
    const theirs = { disconnect: jest.fn(), userId: String(c.id), request: { sessionID: 'laptop' } };
    const io = { of: () => ({ sockets: new Map([['1', mine], ['2', theirs]]) }) };

    const original = app.get('io');
    app.set('io', io);
    try {
      await suspend(admin, b.id).expect(302);
    } finally {
      app.set('io', original);
    }

    expect(mine.disconnect).toHaveBeenCalledWith(true);
    expect(theirs.disconnect).not.toHaveBeenCalled();
  });
});

describe('the admin pages', () => {
  test('search finds accounts, and everything shown is escaped', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const b = await makeAccount('bob');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('<script>alert(1)</script>', b.id);

    const found = (await admin.agent.get('/admin/users').query({ q: b.username }).expect(200)).text;
    expect(found).toContain(`@${b.username}`);
    expect(found).toContain(`/admin/users/${b.id}/suspend`);
    expect(found).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(found).not.toContain('<script>alert(1)</script>');

    const empty = (await admin.agent.get('/admin/users').query({ q: 'no-such-person-anywhere' }).expect(200)).text;
    expect(empty).toContain('No accounts found.');

    const odd = (await admin.agent.get('/admin/users').query({ q: '<i>x</i>' }).expect(200)).text;
    expect(odd).not.toContain('<i>x</i>');
    await admin.agent.get('/admin/users?q=a&q=b').expect(200);
  });

  test('admins and yourself get no suspend button', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const other = await makeAccount('admin2', { admin: true });

    const page = (await admin.agent.get('/admin/users').query({ q: 'admin' }).expect(200)).text;
    expect(page).toContain(`@${other.username}`);
    expect(page).not.toContain(`/admin/users/${other.id}/suspend`);
    expect(page).not.toContain(`/admin/users/${admin.id}/suspend`);
  });

  test('the moderation log shows who did what, and survives deleting the admin', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const helper = await makeAccount('admin2', { admin: true });
    const b = await makeAccount('bob');
    await suspend(admin, b.id, { reason: 'logged reason' }).expect(302);

    const page = (await helper.agent.get('/admin/actions').expect(200)).text;
    expect(page).toContain(`@${admin.username}`);
    expect(page).toContain('logged reason');

    db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
    const after = (await helper.agent.get('/admin/actions').expect(200)).text;
    expect(after).toContain('a deleted admin');
    expect(after).toContain('logged reason');
  });
});

describe('reports page', () => {
  test('each report offers a "Suspend author" button that works and returns to the reports', async () => {
    const admin = await makeAccount('admin', { admin: true });
    const author = await makeAccount('author');
    const reporter = await makeAccount('reporter');
    const postId = posts.createPost(author.id, 'a post that earns a suspension');
    safety.report(reporter.id, postId, 'abuse', '');

    const page = (await admin.agent.get('/admin/reports').expect(200)).text;
    expect(page).toContain(`/admin/users/${author.id}/suspend`);
    expect(page).toContain('Suspend author');

    const res = await suspend(admin, author.id, { from: 'reports', reason: 'Reported post (report #1)' }).expect(302);
    expect(res.headers.location).toBe('/admin/reports');
    expect(suspendedAt(author.id)).toBeTruthy();
  });
});
