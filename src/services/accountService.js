const db = require('../db');

// Errors safe to show to the user
class AccountError extends Error {}

const imagesOf = (sql, ...params) => db.prepare(sql).all(...params).map((row) => row.image_url);

// Removes the account and everything tied to it in one transaction. Returns the upload files
// (chat pictures and avatars) that are no longer needed, so the caller can delete them from disk
// after the database change has been committed.
const removeAccount = db.transaction((userId) => {
  const user = db.prepare('SELECT id, avatar_url, is_admin FROM users WHERE id = ?').get(userId);
  if (!user) throw new AccountError('Account not found.');

  if (user.is_admin) {
    const otherAdmins = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?').get(userId).n;
    if (otherAdmins === 0) {
      throw new AccountError(
        'You are the only admin. Make another admin first (node scripts/make-admin.js <username>), then delete this account.'
      );
    }
  }

  // Pictures in every message they sent or received (those messages are deleted with the account)
  const chat = new Set(
    imagesOf(
      'SELECT image_url FROM messages WHERE image_url IS NOT NULL AND (sender_id = ? OR recipient_id = ?)',
      userId,
      userId
    )
  );
  const avatars = new Set([user.avatar_url]);

  // Groups the account created or belongs to. A group created by this account would be deleted for
  // everyone by the database, so it is handed to the longest-standing other member instead.
  // Groups nobody else is in are deleted together with their pictures.
  const groups = db
    .prepare(
      `SELECT id, avatar_url, created_by FROM groups
       WHERE created_by = ? OR id IN (SELECT group_id FROM group_members WHERE user_id = ?)`
    )
    .all(userId, userId);
  const heirOf = db.prepare(
    `SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?
     ORDER BY joined_at ASC, user_id ASC LIMIT 1`
  );

  for (const group of groups) {
    const heir = heirOf.get(group.id, userId);
    if (!heir) {
      imagesOf('SELECT image_url FROM messages WHERE group_id = ? AND image_url IS NOT NULL', group.id).forEach((url) =>
        chat.add(url)
      );
      avatars.add(group.avatar_url);
      db.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
    } else if (group.created_by === userId) {
      db.prepare('UPDATE groups SET created_by = ? WHERE id = ?').run(heir.user_id, group.id);
    }
  }

  // Everything else (posts, likes, bookmarks, friends, blocks, mutes, mentions, notifications,
  // reports, messages) is removed by the database's cascading rules.
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  return { chat: [...chat], avatars: [...avatars].filter(Boolean) };
});

exports.AccountError = AccountError;
exports.deleteAccount = (userId) => removeAccount(userId);

// What the confirmation page tells the person they are about to lose
exports.summary = (userId) =>
  db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM posts WHERE author_id = ? AND repost_of_id IS NULL) AS posts,
         (SELECT COUNT(*) FROM messages WHERE sender_id = ?) AS messages,
         (SELECT COUNT(*) FROM friends WHERE user_id = ?) AS friends`
    )
    .get(userId, userId, userId);
