const http = require('http');
const { io: connectClient } = require('socket.io-client');
const db = require('../src/db');
const { createSocketServer } = require('../src/realtime');

let counter = 0;
function makeUser(epoch) {
  counter += 1;
  const username = `socketepoch_${counter}_u`;
  return Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name, session_epoch) VALUES (?, ?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', username, epoch).lastInsertRowid
  );
}

// Starts a socket server whose "session" is whatever the test supplies
async function attempt(session) {
  const server = http.createServer();
  const sessionMiddleware = (req, res, next) => {
    req.session = session;
    next();
  };
  const io = createSocketServer(server, sessionMiddleware);
  await new Promise((resolve) => server.listen(0, resolve));

  const outcome = await new Promise((resolve) => {
    const client = connectClient(`http://localhost:${server.address().port}`, {
      reconnection: false,
      transports: ['websocket'],
    });
    client.on('connect', () => {
      client.close();
      resolve('connected');
    });
    client.on('connect_error', (err) => {
      client.close();
      resolve(err.message);
    });
  });

  await new Promise((resolve) => io.close(resolve));
  return outcome;
}

test('a session stamped with the account counter can connect', async () => {
  const id = makeUser(2);
  expect(await attempt({ passport: { user: id }, authEpoch: 2 })).toBe('connected');
});

test('a session from before the counter went up is refused, so a reconnect cannot sneak back in', async () => {
  const id = makeUser(2);
  expect(await attempt({ passport: { user: id }, authEpoch: 1 })).toBe('Unauthorized');
  expect(await attempt({ passport: { user: id } })).toBe('Unauthorized');
});

test('sessions from before this feature still work while the counter is 0', async () => {
  const id = makeUser(0);
  expect(await attempt({ passport: { user: id } })).toBe('connected');
});

test('sessions without a logged-in user are refused', async () => {
  expect(await attempt({})).toBe('Unauthorized');
});
