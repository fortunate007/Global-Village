'use strict';

const http = require('http');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { io: ioClient } = require('socket.io-client');
const { createSocketServer } = require('../../src/realtime');

function startServer({ authenticated }) {
  return new Promise((resolve) => {
    const app = express();
    const sessionMiddleware = session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: true,
    });
    app.use(sessionMiddleware);
    app.get('/login', (req, res) => {
      if (authenticated) req.session.passport = { user: '42' };
      req.session.save(() => res.sendStatus(200));
    });

    const server = http.createServer(app);
    const io = createSocketServer(server, sessionMiddleware);
    server.listen(0, () => resolve({ server, io, port: server.address().port }));
  });
}

describe('realtime setup', () => {
  test('rejects unauthenticated socket connections', async () => {
    const { server, io, port } = await startServer({ authenticated: false });
    const client = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      reconnection: false,
    });

    const err = await new Promise((resolve) => client.on('connect_error', resolve));
    expect(err.message).toBe('Unauthorized');

    client.close();
    io.close();
    server.close();
  });

  test('accepts authenticated socket and emits realtime:ready', async () => {
    const { server, io, port } = await startServer({ authenticated: true });

    const res = await request(server).get('/login');
    const cookie = res.headers['set-cookie'].join('; ');

    const client = ioClient(`http://localhost:${port}`, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      reconnection: false,
    });

    const payload = await new Promise((resolve) => client.on('realtime:ready', resolve));
    expect(payload).toEqual({ userId: '42' });

    client.close();
    io.close();
    server.close();
  });
});
