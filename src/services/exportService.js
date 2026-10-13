const db = require('../db');

const DEFAULT_LIMIT = 50000;

// Collects everything that belongs to one person. Other people's content is only included where it
// is part of the person's own conversations (the other side of a direct message). Never selects
// password hashes, other people's emails or private flags. Lists longer than the limit are cut and
// named in "truncated". Returns null if the account does not exist.
exports.buildExport = (userId, { limit = DEFAULT_LIMIT } = {}) => {
  const profile = db
    .prepare(
      `SELECT id, username, email, display_name, bio, avatar_url, status_message, created_at, last_seen
       FROM users WHERE id = ?`
    )
    .get(userId);
  if (!profile) return null;

  const truncated = [];
  const list = (name, sql, ...params) => {
    const found = db.prepare(`${sql} LIMIT ?`).all(...params, limit + 1);
    if (found.length > limit) truncated.push(name);
    return found.slice(0, limit);
  };

  const posts = list(
    'posts',
    `SELECT id, body, parent_id, quote_of_id, created_at, edited_at
     FROM posts WHERE author_id = ? AND repost_of_id IS NULL ORDER BY id`,
    userId
  );
  const postEditHistory = list(
    'post_edit_history',
    `SELECT pe.post_id, pe.body, pe.edited_at
     FROM post_edits pe JOIN posts p ON p.id = pe.post_id
     WHERE p.author_id = ? ORDER BY pe.id`,
    userId
  );
  const reposts = list(
    'reposts',
    'SELECT repost_of_id AS post_id, created_at FROM posts WHERE author_id = ? AND repost_of_id IS NOT NULL ORDER BY id',
    userId
  );
  const likes = list('likes', 'SELECT post_id, created_at FROM likes WHERE user_id = ? ORDER BY created_at, post_id', userId);
  const bookmarks = list(
    'bookmarks',
    'SELECT post_id, created_at FROM bookmarks WHERE user_id = ? ORDER BY created_at, post_id',
    userId
  );

  const friends = list(
    'friends',
    `SELECT u.username, u.display_name, f.created_at AS since
     FROM friends f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? ORDER BY u.username COLLATE NOCASE`,
    userId
  );
  const requestsSent = list(
    'friend_requests_sent',
    `SELECT u.username AS to_username, r.created_at
     FROM friend_requests r JOIN users u ON u.id = r.recipient_id
     WHERE r.sender_id = ? ORDER BY r.id`,
    userId
  );
  const requestsReceived = list(
    'friend_requests_received',
    `SELECT u.username AS from_username, r.created_at
     FROM friend_requests r JOIN users u ON u.id = r.sender_id
     WHERE r.recipient_id = ? ORDER BY r.id`,
    userId
  );
  const blocked = list(
    'blocked_accounts',
    `SELECT u.username, b.created_at
     FROM blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ? ORDER BY b.created_at, u.username`,
    userId
  );
  const muted = list(
    'muted_accounts',
    `SELECT u.username, m.created_at
     FROM mutes m JOIN users u ON u.id = m.muted_id
     WHERE m.muter_id = ? ORDER BY m.created_at, u.username`,
    userId
  );

  const directMessages = list(
    'direct_messages',
    `SELECT m.id,
            CASE WHEN m.sender_id = ? THEN 'sent' ELSE 'received' END AS direction,
            CASE WHEN m.sender_id = ? THEN ru.username ELSE su.username END AS other_username,
            m.body, m.image_url, m.created_at, m.edited_at, m.deleted_at
     FROM messages m
     JOIN users su ON su.id = m.sender_id
     JOIN users ru ON ru.id = m.recipient_id
     WHERE m.group_id IS NULL AND (m.sender_id = ? OR m.recipient_id = ?)
     ORDER BY m.id`,
    userId,
    userId,
    userId,
    userId
  );

  const groups = list(
    'groups',
    `SELECT g.id, g.name, g.created_at, gm.joined_at
     FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id = ? ORDER BY g.id`,
    userId
  );
  const memberNames = db.prepare(
    `SELECT u.username FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY u.username COLLATE NOCASE`
  );
  groups.forEach((group) => {
    group.members = memberNames.all(group.id).map((row) => row.username);
  });

  const groupMessages = list(
    'group_messages_sent',
    `SELECT m.id, m.group_id, g.name AS group_name, m.body, m.image_url, m.created_at, m.edited_at, m.deleted_at
     FROM messages m LEFT JOIN groups g ON g.id = m.group_id
     WHERE m.sender_id = ? AND m.group_id IS NOT NULL ORDER BY m.id`,
    userId
  );

  const notifications = list(
    'notifications',
    `SELECT n.type, u.username AS from_username, n.post_id, n.created_at, n.read_at
     FROM notifications n JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = ? ORDER BY n.id`,
    userId
  );
  const reportsFiled = list(
    'reports_filed',
    `SELECT id, post_id, post_body, reason, details, status, created_at
     FROM reports WHERE reporter_id = ? ORDER BY id`,
    userId
  );

  return {
    format_version: 1,
    exported_at: new Date().toISOString(),
    notes: [
      'Pictures are listed as links (image_url and avatar_url). The picture files are not inside this file.',
      'Direct messages include both sides of your conversations.',
      'Group messages include only the ones you sent.',
      'Blocked and muted lists show only the accounts you chose to block or mute.',
    ],
    truncated,
    profile,
    posts,
    post_edit_history: postEditHistory,
    reposts,
    likes,
    bookmarks,
    friends,
    friend_requests_sent: requestsSent,
    friend_requests_received: requestsReceived,
    blocked_accounts: blocked,
    muted_accounts: muted,
    direct_messages: directMessages,
    groups,
    group_messages_sent: groupMessages,
    notifications,
    reports_filed: reportsFiled,
  };
};

exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
