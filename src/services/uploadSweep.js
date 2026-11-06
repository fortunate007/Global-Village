const { findOrphans, removeOrphans } = require('../utils/uploadCleanup');

// Removes picture files in the posts folder that no post refers to. Files younger than minAgeHours are left alone.
function sweepOnce(db, { root, minAgeHours = 24 } = {}) {
  const options = { minAgeHours };
  if (root) options.root = root;
  const orphans = findOrphans(db, options).filter((orphan) => orphan.folder === 'posts');
  return removeOrphans(orphans);
}

// The timers never keep the process alive, and a failed sweep is logged and never thrown
function schedule({ db, firstRunMs = 5 * 60 * 1000, intervalMs = 24 * 3600 * 1000, minAgeHours = 24, log = console } = {}) {
  const tick = () => {
    try {
      const result = sweepOnce(db, { minAgeHours });
      if (result.removed) log.log(`[uploads] removed ${result.removed} unused post picture(s)`);
    } catch (err) {
      log.error('[uploads] sweep failed', err.message);
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

// UPLOAD_SWEEP=false switches it off. Nothing runs while testing.
function scheduleFromEnv(db, log = console) {
  if (process.env.NODE_ENV === 'test') return null;
  if (String(process.env.UPLOAD_SWEEP || '').toLowerCase() === 'false') return null;
  return schedule({ db, log });
}

module.exports = { sweepOnce, schedule, scheduleFromEnv };
