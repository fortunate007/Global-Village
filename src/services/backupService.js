const fs = require('fs');
const path = require('path');

const FILE_PATTERN = /^global-village-\d{8}-\d{6}(?:-\d+)?\.db$/;
const HOUR_MS = 3600 * 1000;

// Where backups go: BACKUP_DIR, or data/backups next to the database
const backupDir = () => process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'data', 'backups');

function numberFromEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
// How many backups to keep (BACKUP_KEEP, 1 to 365, default 7) and the hours between them (BACKUP_INTERVAL_HOURS, 1 to 168, default 24)
const keepCount = () => Math.floor(numberFromEnv('BACKUP_KEEP', 7, 1, 365));
const intervalHours = () => numberFromEnv('BACKUP_INTERVAL_HOURS', 24, 1, 168);

const pad = (n) => String(n).padStart(2, '0');
const stamp = (now) =>
  `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
  `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

// Backup file names, newest first. Other files in the folder are never listed.
function listBackups(dir = backupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => FILE_PATTERN.test(name)).sort().reverse();
}

// Deletes all but the newest `keep` backups (always at least one) and returns the names removed
function prune(dir = backupDir(), keep = keepCount()) {
  const remove = listBackups(dir).slice(Math.max(1, Math.floor(keep)));
  remove.forEach((name) => fs.rmSync(path.join(dir, name), { force: true }));
  return remove;
}

// Writes a consistent copy of the live database (safe while the app is running), readable only by its owner
function backupNow(db, { dir = backupDir(), keep = keepCount(), now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let name = `global-village-${stamp(now)}.db`;
  let n = 0;
  while (fs.existsSync(path.join(dir, name))) {
    n += 1;
    name = `global-village-${stamp(now)}-${n}.db`;
  }
  const file = path.join(dir, name);

  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
  const removed = prune(dir, keep);
  return { file, name, size: fs.statSync(file).size, removed };
}

// True when there is no backup yet, or the newest one is at least `hours` old
function dueForBackup(dir = backupDir(), hours = intervalHours(), now = Date.now()) {
  const newest = listBackups(dir)[0];
  if (!newest) return true;
  return now - fs.statSync(path.join(dir, newest)).mtimeMs >= hours * HOUR_MS;
}

// Checks every hour and writes a backup when one is due, so restarts never cause extra copies.
// A failed backup is logged and never thrown. The timers never keep the process alive.
function schedule({
  db,
  dir = backupDir(),
  keep = keepCount(),
  hours = intervalHours(),
  firstRunMs = 90 * 1000,
  checkEveryMs = HOUR_MS,
  log = console,
} = {}) {
  const tick = () => {
    try {
      if (!dueForBackup(dir, hours)) return;
      const result = backupNow(db, { dir, keep });
      log.log(`[backup] wrote ${result.name} (${Math.ceil(result.size / 1024)} KB)`);
    } catch (err) {
      log.error('[backup] backup failed', err.message);
    }
  };

  const first = setTimeout(tick, firstRunMs);
  const repeat = setInterval(tick, checkEveryMs);
  [first, repeat].forEach((timer) => timer.unref && timer.unref());

  return {
    stop() {
      clearTimeout(first);
      clearInterval(repeat);
    },
  };
}

// Used when the app starts: nothing during tests, and BACKUP_ENABLED=false switches it off
function scheduleFromEnv(db, log = console) {
  if (process.env.NODE_ENV === 'test') return null;
  if (String(process.env.BACKUP_ENABLED || '').toLowerCase() === 'false') {
    log.log('[backup] automatic backups are switched off (BACKUP_ENABLED=false)');
    return null;
  }
  return schedule({ db, log });
}

module.exports = { backupDir, keepCount, intervalHours, listBackups, prune, backupNow, dueForBackup, schedule, scheduleFromEnv };
