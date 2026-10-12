const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');

const form = (overrides) => ({
  username: 'CaseUser',
  email: 'case@example.com',
  password: 'secret123',
  confirmPassword: 'secret123',
  displayName: 'Case',
  ...overrides,
});

test('usernames and emails are unique regardless of letter case', async () => {
  await request(app).post('/register').type('form').send(form()).expect(302);

  const sameName = await request(app)
    .post('/register')
    .type('form')
    .send(form({ username: 'caseuser', email: 'other@example.com' }));
  const sameEmail = await request(app)
    .post('/register')
    .type('form')
    .send(form({ username: 'someoneelse', email: 'CASE@EXAMPLE.COM' }));

  expect(sameName.status).not.toBe(302);
  expect(sameEmail.status).not.toBe(302);
  expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(1);
});

test('the database itself rejects case-variant duplicates', () => {
  const insert = db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)');
  expect(() => insert.run('CASEUSER', 'brandnew@example.com', 'x', 'Dup')).toThrow(/UNIQUE/);
  expect(() => insert.run('brandnew', 'Case@Example.com', 'x', 'Dup')).toThrow(/UNIQUE/);
});
