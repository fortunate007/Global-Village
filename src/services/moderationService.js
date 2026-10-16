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
