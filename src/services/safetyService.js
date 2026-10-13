const db = require('../db');

// Errors safe to show to the user
class SafetyError extends Error {}

const REASONS = {
  spam: 'Spam',
  abuse: 'Abusive or hateful',
  harassment: 'Harassment',
  misinformation: 'Misleading information',
  other: 'Something else',
};

exports.SafetyError = SafetyError;
exports.REASONS = REASONS;

// The database rejects blocked interactions with RAISE(ABORT, 'blocked')
exports.isBlockError = (err) =>
  !!err && err.code === 'SQLITE_CONSTRAINT_TRIGGER' && /blocked/.test(err.message || '');

function requireTarget(me, targetId) {
  if (!Number.isInteger(targetId) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(targetId)) {
    throw new SafetyError('User not found.');
  }
  if (targetId === me) throw new SafetyError("You can't do that to yourself.");
}

exports.block = (me, target) => {
  require('./followService').removeBetween(me, target);
  requireTarget(me, target);
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(me, target);
};
exports.unblock = (me, target) => {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(me, target);
};
exports.mute = (me, target) => {
  requireTarget(me, target);
  db.prepare('INSERT OR IGNORE INTO mutes (muter_id, muted_id) VALUES (?, ?)').run(me, target);
};
exports.unmute = (me, target) => {
  db.prepare('DELETE FROM mutes WHERE muter_id = ? AND muted_id = ?').run(me, target);
};

exports.listBlocked = (me) =>
  db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? ORDER BY b.created_at DESC`
    )
    .all(me);

exports.listMuted = (me) =>
  db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM mutes m JOIN users u ON u.id = m.muted_id
       WHERE m.muter_id = ? ORDER BY m.created_at DESC`
    )
    .all(me);

// Authors whose posts this viewer should not see: people they blocked or muted, and people who blocked them
exports.hiddenAuthorIds = (viewerId) =>
  new Set(
    db
      .prepare(
        `SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?
         UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?
         UNION SELECT muted_id FROM mutes WHERE muter_id = ?`
      )
      .all(viewerId, viewerId, viewerId)
      .map((r) => r.id)
  );

const blockedEitherWay = (a, b) =>
  !!db
    .prepare(
      `SELECT 1 FROM blocks
       WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`
    )
    .get(a, b, b, a);
exports.blockedEitherWay = blockedEitherWay;

// Lists of posts (feed, tags, search, bookmarks, mentions). Logged-out visitors see everything.
exports.filterPosts = (viewerId, rows) => {
  if (!viewerId) return rows;
  const hidden = exports.hiddenAuthorIds(viewerId);
  if (!hidden.size) return rows;
  return rows
    .filter((r) => !hidden.has(r.author_id) && !(r.original && hidden.has(r.original.author_id)))
    .map((r) => {
      if (r.quoted && hidden.has(r.quoted.author_id)) r.quoted = null;
      return r;
    });
};

// A single thread. Blocked either way = not found. Muted authors' replies are dropped.
exports.filterThread = (viewerId, thread) => {
  if (!thread || !viewerId) return thread;
  if (blockedEitherWay(viewerId, thread.post.author_id)) return null;
  const hidden = exports.hiddenAuthorIds(viewerId);
  thread.ancestors = exports.filterPosts(viewerId, thread.ancestors);
  thread.replies = exports.filterPosts(viewerId, thread.replies);
  if (thread.post.quoted && hidden.has(thread.post.quoted.author_id)) thread.post.quoted = null;
  return thread;
};

exports.filterPeople = (viewerId, people) => {
  if (!viewerId) return people;
  const hidden = exports.hiddenAuthorIds(viewerId);
  return people.filter((u) => !hidden.has(u.id));
};

// ---- Reports ----

// Reposts have no text, so reporting one reports the original post
exports.getReportablePost = (postId) => {
  const row = db.prepare('SELECT id, repost_of_id FROM posts WHERE id = ?').get(postId);
  if (!row) return null;
  return db
    .prepare(
      `SELECT p.id, p.author_id, p.body, u.username
       FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`
    )
    .get(row.repost_of_id || row.id);
};

exports.report = (reporterId, postId, reason, details) => {
  if (!REASONS[reason]) throw new SafetyError('Please choose a reason.');
  const post = exports.getReportablePost(postId);
  if (!post) throw new SafetyError('Post not found.');
  if (post.author_id === reporterId) throw new SafetyError("You can't report your own post.");

  const text = String(details || '').trim().slice(0, 500);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO reports (reporter_id, post_id, post_author_id, post_body, reason, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(reporterId, post.id, post.author_id, post.body, reason, text);
  return { created: result.changes > 0 };
};

exports.openReports = (limit = 100) =>
  db
    .prepare(
      `SELECT r.id, r.reason, r.details, r.post_id, r.post_body, r.post_author_id, r.created_at,
              ru.username AS reporter_username, au.username AS author_username
       FROM reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users au ON au.id = r.post_author_id
       WHERE r.status = 'open'
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`
    )
    .all(limit);

exports.resolveReport = (adminId, reportId, status) => {
  if (!['resolved', 'dismissed'].includes(status)) throw new SafetyError('Invalid status.');
  const result = db
    .prepare(
      `UPDATE reports SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
       WHERE id = ? AND status = 'open'`
    )
    .run(status, adminId, reportId);
  if (!result.changes) throw new SafetyError('Report not found or already handled.');
};

// Deletes the reported post and resolves every open report about it
exports.removeReportedPost = db.transaction((adminId, reportId) => {
  const report = db.prepare("SELECT id, post_id FROM reports WHERE id = ? AND status = 'open'").get(reportId);
  if (!report) throw new SafetyError('Report not found or already handled.');
  if (report.post_id) {
    db.prepare(
      `UPDATE reports SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
       WHERE post_id = ? AND status = 'open'`
    ).run(adminId, report.post_id);
    db.prepare('DELETE FROM posts WHERE id = ?').run(report.post_id);
  } else {
    exports.resolveReport(adminId, reportId, 'resolved');
  }
});

exports.isAdmin = (userId) => !!db.prepare('SELECT 1 FROM users WHERE id = ? AND is_admin = 1').get(userId);

exports.blockedIds = (userId) =>
  new Set(
    db
      .prepare(
        'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id FROM blocks WHERE blocked_id = ?'
      )
      .all(userId, userId)
      .map((r) => r.id)
  );

// ---- Keeping the reports table tidy ----

function assertDays(days) {
  if (!Number.isInteger(days) || days < 1) throw new SafetyError('days must be a whole number, 1 or more.');
}

// Resolved and dismissed reports older than the given number of days. Open reports are never included.
exports.countPrunable = (days) => {
  assertDays(days);
  return db
    .prepare("SELECT COUNT(*) AS n FROM reports WHERE status != 'open' AND resolved_at < datetime('now', ?)")
    .get(`-${days} days`).n;
};

exports.pruneResolved = (days) => {
  assertDays(days);
  return db
    .prepare("DELETE FROM reports WHERE status != 'open' AND resolved_at < datetime('now', ?)")
    .run(`-${days} days`).changes;
};
