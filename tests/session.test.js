const request = require('supertest');
const { resolveSecret } = require('../src/config/session');

const KEYS = ['SESSION_SECRET', 'RENDER', 'NODE_ENV'];
const saved = {};

beforeEach(() => KEYS.forEach((k) => { saved[k] = process.env[k]; }));
afterEach(() => {
  KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  jest.restoreAllMocks();
});

describe('session secret', () => {
  test('an explicit secret is always used', () => {
    process.env.SESSION_SECRET = 'my-own-secret';
    expect(resolveSecret()).toBe('my-own-secret');
  });

  test('development keeps the convenient default', () => {
    delete process.env.SESSION_SECRET;
    delete process.env.RENDER;
    process.env.NODE_ENV = 'development';
    expect(resolveSecret()).toBe('global-village-dev-secret');
  });

  test('production without a secret gets a random one and a warning, never the public default', () => {
    delete process.env.SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const first = resolveSecret();
    const second = resolveSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe('global-village-dev-secret');
    expect(warn).toHaveBeenCalled();
  });

  test('Render is treated as production even if NODE_ENV is missing', () => {
    delete process.env.SESSION_SECRET;
    process.env.NODE_ENV = 'development';
    process.env.RENDER = 'true';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('session cookie', () => {
  test('is HttpOnly and SameSite=Lax', async () => {
    const app = require('../src/app');
    const res = await request(app)
      .post('/register')
      .type('form')
      .send({
        username: 'cookieuser',
        email: 'cookie@example.com',
        password: 'secret123',
        confirmPassword: 'secret123',
        displayName: 'Cookie',
      })
      .expect(302);

    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});
