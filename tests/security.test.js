const express = require('express');
const request = require('supertest');
const { sameOrigin, createLimiter } = require('../src/middleware/security');

function protectedApp() {
  const app = express();
  app.use(sameOrigin());
  app.get('/x', (req, res) => res.send('ok'));
  app.post('/x', (req, res) => res.send('ok'));
  return app;
}

describe('same-origin protection', () => {
  const app = protectedApp();

  test('writes without browser headers pass (curl, tests, servers)', async () => {
    await request(app).post('/x').expect(200);
  });

  test('same-origin and user-initiated writes pass', async () => {
    await request(app).post('/x').set('Sec-Fetch-Site', 'same-origin').expect(200);
    await request(app).post('/x').set('Sec-Fetch-Site', 'none').expect(200);
  });

  test('cross-site and same-site writes are rejected', async () => {
    await request(app).post('/x').set('Sec-Fetch-Site', 'cross-site').expect(403);
    await request(app).post('/x').set('Sec-Fetch-Site', 'same-site').expect(403);
  });

  test('without Sec-Fetch-Site, the Origin header must match the host', async () => {
    await request(app).post('/x').set('Host', 'app.test').set('Origin', 'http://app.test').expect(200);
    await request(app).post('/x').set('Host', 'app.test').set('Origin', 'https://evil.example').expect(403);
    await request(app).post('/x').set('Host', 'app.test').set('Origin', 'null').expect(403);
  });

  test('reads are never blocked', async () => {
    await request(app).get('/x').set('Sec-Fetch-Site', 'cross-site').expect(200);
  });
});

describe('rate limiting', () => {
  test('only failed attempts count, and the limit returns 429', async () => {
    const app = express();
    app.post(
      '/login',
      createLimiter({ windowMs: 60_000, limit: 2, skipSuccessfulRequests: true }),
      (req, res) => res.status(req.get('x-ok') ? 200 : 401).send('x')
    );

    for (let i = 0; i < 5; i += 1) await request(app).post('/login').set('x-ok', '1').expect(200);
    await request(app).post('/login').expect(401);
    await request(app).post('/login').expect(401);
    const blocked = await request(app).post('/login').expect(429);
    expect(blocked.text).toMatch(/too many/i);
  });
});

describe('the real app', () => {
  const app = require('../src/app');

  test('security headers are present on every response', async () => {
    const res = await request(app).get('/definitely-not-a-page');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy-report-only']).toContain("default-src 'self'");
  });

  test('cross-site writes are rejected, normal ones are not', async () => {
    await request(app)
      .post('/login')
      .set('Sec-Fetch-Site', 'cross-site')
      .type('form')
      .send({ username: 'a', password: 'b' })
      .expect(403);

    const res = await request(app).post('/login').type('form').send({ username: 'a', password: 'b' });
    expect(res.status).not.toBe(403);
  });
});
