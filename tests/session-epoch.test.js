const db = require('../src/db');
const { middleware, currentEpoch } = require('../src/middleware/sessionEpoch');

let counter = 0;
function makeUser(epoch = 0) {
  counter += 1;
  const username = `epoch_${counter}_u`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name, session_epoch) VALUES (?, ?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', username, epoch).lastInsertRowid
  );
  return id;
}

test('the counter column exists and defaults to 0', () => {
  const column = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'session_epoch');
  expect(column).toMatchObject({ notnull: 1, dflt_value: '0' });
  expect(currentEpoch(makeUser())).toBe(0);
  expect(currentEpoch(999999)).toBe(0);
});

describe('checking a session', () => {
  const run = (user, session) => {
    const req = { user, session, logout: jest.fn((cb) => cb()) };
    const next = jest.fn();
    middleware(req, {}, next);
    return { req, next };
  };

  test('a matching stamp passes, and a session without a stamp counts as 0', () => {
    const matching = run({ id: 1, session_epoch: 3 }, { authEpoch: 3 });
    expect(matching.next).toHaveBeenCalledWith();
    expect(matching.req.logout).not.toHaveBeenCalled();

    const legacy = run({ id: 1, session_epoch: 0 }, {});
    expect(legacy.next).toHaveBeenCalledWith();
    expect(legacy.req.logout).not.toHaveBeenCalled();
  });

  test('an older stamp, or no stamp after the counter went up, is logged out', () => {
    const older = run({ id: 1, session_epoch: 4 }, { authEpoch: 3 });
    expect(older.req.logout).toHaveBeenCalledTimes(1);
    expect(older.next).toHaveBeenCalledTimes(1);

    const legacy = run({ id: 1, session_epoch: 1 }, {});
    expect(legacy.req.logout).toHaveBeenCalledTimes(1);
  });

  test('requests without a logged-in user are left alone', () => {
    const anonymous = run(undefined, {});
    expect(anonymous.next).toHaveBeenCalledWith();
    expect(anonymous.req.logout).not.toHaveBeenCalled();
  });
});

describe('stamping new logins', () => {
  test('a successful login records the account counter, with or without options', () => {
    const id = makeUser(3);
    const original = jest.fn((user, ...rest) => rest[rest.length - 1](null));
    const req = { session: {}, login: original };
    middleware(req, {}, jest.fn());

    const done = jest.fn();
    req.login({ id }, done);
    expect(req.session.authEpoch).toBe(3);
    expect(done).toHaveBeenCalledWith(null);

    req.session.authEpoch = undefined;
    const doneWithOptions = jest.fn();
    req.logIn({ id }, { keepSessionInfo: true }, doneWithOptions);
    expect(req.session.authEpoch).toBe(3);
    expect(original).toHaveBeenLastCalledWith({ id }, { keepSessionInfo: true }, expect.any(Function));
    expect(doneWithOptions).toHaveBeenCalledWith(null);
  });

  test('a failed login stamps nothing and passes the error on', () => {
    const id = makeUser(2);
    const failure = new Error('login failed');
    const req = { session: {}, login: (user, cb) => cb(failure) };
    middleware(req, {}, jest.fn());

    const done = jest.fn();
    req.login({ id }, done);
    expect(req.session.authEpoch).toBeUndefined();
    expect(done).toHaveBeenCalledWith(failure);
  });
});
