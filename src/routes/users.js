const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const safety = require('../services/safetyService');

const router = express.Router();
const ONLINE_WINDOW_MINUTES = 3;

// Friendships are normally made through friend requests (src/routes/friends.js).
// Set to true only if an older screen or test still relies on adding a friend instantly.
const ALLOW_DIRECT_FRIEND = false;

function withOnlineFlag(users) {
  return users.map((u) => ({
    ...u,
    isOnline:
      (Date.now() - new Date(u.last_seen + 'Z').getTime()) / 60000 < ONLINE_WINDOW_MINUTES,
  }));
}

// People you blocked, and people who blocked you, never show up
function visibleTo(viewerId, users) {
  const blocked = safety.blockedIds(viewerId);
  return users.filter((u) => !blocked.has(u.id));
}

router.get('/users', ensureAuthenticated, (req, res) => {
  const users = visibleTo(
    req.user.id,
    db
      .prepare('SELECT id, username, display_name, avatar_url, status_message, last_seen FROM users WHERE id != ? ORDER BY display_name COLLATE NOCASE')
      .all(req.user.id)
  );

  const friendRows = db
    .prepare('SELECT friend_id FROM friends WHERE user_id = ?')
    .all(req.user.id);
  const friendIds = new Set(friendRows.map((f) => f.friend_id));

  const groups = db
    .prepare(
      `SELECT g.id, g.name, g.avatar_url FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = ? ORDER BY g.name COLLATE NOCASE`
    )
    .all(req.user.id);

  res.render('users', {
    title: 'People',
    users: withOnlineFlag(users).map((u) => ({ ...u, isFriend: friendIds.has(u.id) })),
    groups,
  });
});

// Lightweight polling endpoint for live-ish online status
router.get('/api/users/online', ensureAuthenticated, (req, res) => {
  const users = visibleTo(
    req.user.id,
    db.prepare('SELECT id, last_seen FROM users WHERE id != ?').all(req.user.id)
  );
  res.json(withOnlineFlag(users).map((u) => ({ id: u.id, isOnline: u.isOnline })));
});

router.post('/users/:id/friend', ensureAuthenticated, (req, res) => {
  const friendId = Number(req.params.id);
  if (friendId === req.user.id) return res.redirect('/users');

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(friendId);
  // Blocked either way looks exactly like a missing account
  if (!target || safety.blockedEitherWay(req.user.id, friendId)) {
    req.flash('error', 'User not found.');
    return res.redirect('/users');
  }

  // A friendship needs the other person's consent, so hand over to the request flow
  if (!ALLOW_DIRECT_FRIEND) return res.redirect(307, `/friends/request/${friendId}`);

  db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').run(
    req.user.id,
    friendId
  );
  db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').run(
    friendId,
    req.user.id
  );

  req.flash('success', 'Friend added!');
  res.redirect('/users');
});

router.post('/users/:id/unfriend', ensureAuthenticated, (req, res) => {
  const friendId = Number(req.params.id);
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(req.user.id, friendId);
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(friendId, req.user.id);
  req.flash('success', 'Friend removed.');
  res.redirect('/users');
});

module.exports = router;
module.exports.allowsDirectFriending = ALLOW_DIRECT_FRIEND;
