const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'sessions.db');

// Each stored session is JSON that includes its cookie's expiry (an ISO date). A row counts as expired when
// that date is in the past. CASE keeps unreadable JSON from raising an error, and a missing or unparsable
// date gives NULL, so those rows are kept rather than deleted.
const EXPIRED = `CASE WHEN json_valid(sess) THEN datetime(json_extract(sess, '$.cookie.expires')) END < datetime('now')`;

// Opens the sessions database only for as long as the work takes. Never creates a database that is missing.
function withSessions(file, work) {
  if (!fs.existsSync(file)) return { skipped: 'no sessions database found' };

  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
    if (!columns.length) return { skipped: 'no sessions table yet' };
    if (!columns.includes('sess')) return { skipped: 'unexpected sessions table layout' };
    return work(db);
  } finally {
    db.close();
  }
}

// Counts stored sessions and how many have expired, without changing anything
function inspect(file = DEFAULT_FILE) {
  return withSessions(file, (db) =>
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(${EXPIRED}), 0) AS expired FROM sessions`).get()
  );
}

// Deletes expired sessions. Live sessions are never touched.
function prune(file = DEFAULT_FILE) {
  return withSessions(file, (db) => {
    const deleted = db.prepare(`DELETE FROM sessions WHERE ${EXPIRED}`).run().changes;
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    return { deleted, remaining };
  });
}

// Runs the cleanup shortly after startup and then regularly. The timers never keep the process alive, and a
// failed run is logged and never thrown, so housekeeping cannot take the app down.
function schedule({ file = DEFAULT_FILE, firstRunMs = 30 * 1000, intervalMs = 6 * 60 * 60 * 1000, log = console } = {}) {
  const tick = () => {
    try {
      const result = prune(file);
      if (result.deleted) log.log(`[sessions] removed ${result.deleted} expired session(s)`);
    } catch (err) {
      log.error('[sessions] cleanup failed', err);
    }
  };

  const first = setTimeout(tick, firstRunMs);
  const repeat = setInterval(tick, intervalMs);
  [first, repeat].forEach((timer) => timer.unref && timer.unref());

  return {
    stop() {
      clearTimeout(first);
      clearInterval(repeat);
    },
  };
}

module.exports = { inspect, prune, schedule, DEFAULT_FILE };
