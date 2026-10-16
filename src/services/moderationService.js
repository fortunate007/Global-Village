const db = require('../db');
const safety = require('./safetyService');

// Errors safe to show to the user
class ModerationError extends Error {}

const NOTE_MAX = 500;
const SEARCH_MAX = 50;

const asText = (value) => (typeof value === 'string' ? value : '');
const clean = (value, max) => asText(value).trim().slice(0, max);
const escapeLike = (text) => text.replace(/[\\%_]/g, '\\$&');

// Checked again here, in the database, in addition to the routes
function requireAdmin(adminId) {
  if (!safety.isAdmin(adminId)) throw new ModerationError('Admins only.');
}

function loadTarget(targetId) {
  const target = Number.isInteger(targetId)
    ? db.prepare('SELECT id, username, is_admin, suspended_at FROM users WHERE id = ?').get(targetId)
    : null;
  if (!target) throw new ModerationError('Account not found.');
  return target;
}

const logAction = db.prepare(
  'INSERT INTO admin_actions (admin_id, action, target_user_id, target_username, note) VALUES (?, ?, ?, ?, ?)'
);

// Raising session_epoch ends every session of the account at its next request and stops live chat
// connections from coming back. The caller closes the connections that are open right now.
const suspendTx = db.transaction((adminId, targetId, reason) => {
  requireAdmin(adminId);
  const target = loadTarget(targetId);
  if (target.id === adminId) throw new ModerationError('You cannot suspend your own account.');
  if (target.is_admin) {
    throw new ModerationError('Admins cannot be suspended. Remove their admin rights first (node scripts/make-admin.js <username> revoke).');
  }
  if (target.suspended_at) throw new ModerationError('That account is already suspended.');

  const note = clean(reason, NOTE_MAX);
  db.prepare(
    `UPDATE users
     SET suspended_at = CURRENT_TIMESTAMP, suspended_reason = ?, session_epoch = session_epoch + 1
     WHERE id = ?`
  ).run(note || null, target.id);
  logAction.run(adminId, 'suspend', target.id, target.username, note);
  return { id: target.id, username: target.username };
});

const unsuspendTx = db.transaction((adminId, targetId, reason) => {
  requireAdmin(adminId);
  const target = loadTarget(targetId);
  if (!target.suspended_at) throw new ModerationError('That account is not suspended.');

  const note = clean(reason, NOTE_MAX);
  db.prepare('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?').run(target.id);
  logAction.run(adminId, 'unsuspend', target.id, target.username, note);
  return { id: target.id, username: target.username };
});

exports.ModerationError = ModerationError;
exports.NOTE_MAX = NOTE_MAX;
exports.suspend = (adminId, targetId, reason) => suspendTx(adminId, targetId, reason);
exports.unsuspend = (adminId, targetId, reason) => unsuspendTx(adminId, targetId, reason);

const ACCOUNT_COLUMNS =
  'id, username, display_name, is_admin, suspended_at, suspended_reason, created_at';

// Admin search by username or display name. Never selects email addresses or password hashes.
exports.searchUsers = (query, limit = 30) => {
  const text = clean(query, SEARCH_MAX);
  if (!text) return [];
  const pattern = `%${escapeLike(text)}%`;
  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM users
       WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
       ORDER BY username COLLATE NOCASE LIMIT ?`
    )
    .all(pattern, pattern, limit);
};

exports.listSuspended = (limit = 50) =>
  db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM users
       WHERE suspended_at IS NOT NULL ORDER BY suspended_at DESC, id DESC LIMIT ?`
    )
    .all(limit);

exports.recentActions = (limit = 50) =>
  db
    .prepare(
      `SELECT a.id, a.action, a.note, a.created_at, a.target_user_id, a.target_username, u.username AS admin_username
       FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
       ORDER BY a.id DESC LIMIT ?`
    )
    .all(limit);

// ---- Report decisions ----

const REPORT_ACTIONS = { resolve: 'report_resolve', dismiss: 'report_dismiss', remove: 'post_remove' };
const DELETED_ACCOUNT = '(deleted account)';

// Decides one open report and writes the log entry in the same transaction. The reporter is never
// recorded: the entry holds the report number and its reason only.
const handleReportTx = db.transaction((adminId, reportId, decision) => {
  requireAdmin(adminId);

  const report = Number.isInteger(reportId)
    ? db.prepare("SELECT id, post_id, post_author_id, reason FROM reports WHERE id = ? AND status = 'open'").get(reportId)
    : null;
  if (!report) throw new ModerationError('Report not found or already handled.');
  if (decision === 'remove' && !report.post_id) {
    throw new ModerationError('That post is already deleted. Resolve or dismiss the report instead.');
  }

  const author = report.post_author_id
    ? db.prepare('SELECT id, username FROM users WHERE id = ?').get(report.post_author_id)
    : null;

  // Removing a post also closes every other open report about it
  const openAboutPost =
    decision === 'remove'
      ? db.prepare("SELECT COUNT(*) AS n FROM reports WHERE post_id = ? AND status = 'open'").get(report.post_id).n
      : 1;

  if (decision === 'remove') safety.removeReportedPost(adminId, report.id);
  else safety.resolveReport(adminId, report.id, decision === 'resolve' ? 'resolved' : 'dismissed');

  const note =
    `Report #${report.id} (${report.reason})` +
    (openAboutPost > 1 ? ` and ${openAboutPost - 1} more on the same post` : '');
  logAction.run(
    adminId,
    REPORT_ACTIONS[decision],
    author ? author.id : null,
    author ? author.username : DELETED_ACCOUNT,
    note
  );

  return { reportId: report.id, decision, postRemoved: decision === 'remove' };
});

exports.DELETED_ACCOUNT = DELETED_ACCOUNT;
exports.handleReport = (adminId, reportId, decision) => {
  if (!Object.prototype.hasOwnProperty.call(REPORT_ACTIONS, decision)) throw new ModerationError('Unknown decision.');
  return handleReportTx(adminId, reportId, decision);
};
