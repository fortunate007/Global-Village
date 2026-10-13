const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { inspect, prune, schedule } = require('../src/services/sessionMaintenance');

const DAY = 24 * 3600 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const session = (offsetMs, extra = {}) =>
  JSON.stringify({ cookie: { originalMaxAge: 30 * DAY, expires: iso(offsetMs), httpOnly: true }, ...extra });

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
});
afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeDb(rows, { layout = 'normal' } = {}) {
  const file = path.join(dir, 'sessions.db');
  const db = new Database(file);
  if (layout === 'normal') {
    db.exec('CREATE TABLE sessions (sid PRIMARY KEY, expired, sess)');
    const insert = db.prepare('INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)');
    Object.entries(rows || {}).forEach(([sid, sess]) => insert.run(sid, 0, sess));
  } else if (layout === 'odd') {
    db.exec('CREATE TABLE sessions (sid PRIMARY KEY, payload)');
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run('x', 'y');
  }
  db.close();
  return file;
}

const sids = (file) => {
  const db = new Database(file);
  try {
    return db.prepare('SELECT sid FROM sessions ORDER BY sid').all().map((r) => r.sid);
  } finally {
    db.close();
  }
};

const MIXED = () => ({
  expired_yesterday: session(-DAY),
  expired_last_month: session(-30 * DAY),
  live_tomorrow: session(DAY),
  live_in_a_minute: session(60 * 1000),
  no_expiry: JSON.stringify({ cookie: { originalMaxAge: null, expires: null } }),
  no_cookie: JSON.stringify({ passport: { user: 1 } }),
  broken_json: '{not json',
  garbage_date: JSON.stringify({ cookie: { expires: 'yesterday' } }),
});
const KEPT = ['broken_json', 'garbage_date', 'live_in_a_minute', 'live_tomorrow', 'no_cookie', 'no_expiry'];

describe('pruning', () => {
  test('removes expired sessions and keeps everything else, including unreadable ones', () => {
    const file = makeDb(MIXED());
    expect(prune(file)).toEqual({ deleted: 2, remaining: 6 });
    expect(sids(file)).toEqual(KEPT);
    expect(prune(file)).toEqual({ deleted: 0, remaining: 6 });
  });

  test('the library\'s own "expired" column does not matter', () => {
    const file = makeDb({});
    const db = new Database(file);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('old_number_live_cookie', 1, session(DAY));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('big_number_dead_cookie', 9999999999999, session(-DAY));
    db.close();

    prune(file);
    expect(sids(file)).toEqual(['old_number_live_cookie']);
  });

  test('inspecting counts without deleting anything', () => {
    const file = makeDb(MIXED());
    expect(inspect(file)).toEqual({ total: 8, expired: 2 });
    expect(sids(file)).toHaveLength(8);
  });

  test('a missing database is skipped and not created', () => {
    const file = path.join(dir, 'nothing-here.db');
    expect(inspect(file)).toEqual({ skipped: 'no sessions database found' });
    expect(prune(file)).toEqual({ skipped: 'no sessions database found' });
    expect(fs.existsSync(file)).toBe(false);
  });

  test('a database without the sessions table, or with a different layout, is left alone', () => {
    const empty = makeDb(null, { layout: 'none' });
    expect(prune(empty)).toEqual({ skipped: 'no sessions table yet' });

    fs.rmSync(empty);
    const odd = makeDb(null, { layout: 'odd' });
    expect(prune(odd)).toEqual({ skipped: 'unexpected sessions table layout' });
    expect(sids(odd)).toEqual(['x']);
  });
});

describe('the schedule', () => {
  test('runs shortly after startup and then regularly, and can be stopped', () => {
    jest.useFakeTimers();
    const file = makeDb({ gone: session(-DAY), kept: session(DAY) });
    const log = { log: jest.fn(), error: jest.fn() };
    const job = schedule({ file, firstRunMs: 1000, intervalMs: 5000, log });

    expect(sids(file)).toEqual(['gone', 'kept']);
    jest.advanceTimersByTime(1000);
    expect(sids(file)).toEqual(['kept']);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('removed 1 expired'));

    const db = new Database(file);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('later', 0, session(-DAY));
    db.close();
    jest.advanceTimersByTime(5000);
    expect(sids(file)).toEqual(['kept']);

    job.stop();
    const again = new Database(file);
    again.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('after_stop', 0, session(-DAY));
    again.close();
    jest.advanceTimersByTime(60000);
    expect(sids(file)).toEqual(['after_stop', 'kept']);
  });

  test('a failing run is logged and never thrown', () => {
    jest.useFakeTimers();
    const log = { log: jest.fn(), error: jest.fn() };
    const job = schedule({ file: dir, firstRunMs: 10, intervalMs: 1000, log });

    expect(() => jest.advanceTimersByTime(10)).not.toThrow();
    expect(log.error).toHaveBeenCalled();
    job.stop();
  });

  test('the session store starts the schedule, except while running tests', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'session.js'), 'utf8');
    expect(source).toMatch(/if \(!isTest\) require\('\.\.\/services\/sessionMaintenance'\)\.schedule\(\);/);
  });
});

describe('the command-line tool', () => {
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/prune-sessions.js', ...args], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });

  test('runs as a dry run by default', () => {
    const file = makeDb(MIXED());
    const result = run(`--file=${file}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('8 stored session(s), 2 expired.');
    expect(result.stdout).toContain('Nothing was deleted');
    expect(sids(file)).toHaveLength(8);
  });

  test('--delete removes only the expired sessions', () => {
    const file = makeDb(MIXED());
    const result = run(`--file=${file}`, '--delete');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Deleted 2 expired session(s), 6 remain.');
    expect(sids(file)).toEqual(KEPT);
  });

  test('says so when there is nothing to do', () => {
    const missing = run(`--file=${path.join(dir, 'missing.db')}`);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('Nothing to do: no sessions database found.');

    const clean = run(`--file=${makeDb({ live: session(DAY) })}`);
    expect(clean.stdout).toContain('1 stored session(s), 0 expired.');
    expect(clean.stdout).not.toContain('Nothing was deleted');
  });
});
