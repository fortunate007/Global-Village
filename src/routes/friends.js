const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();
const ONLINE_WINDOW_MINUTES = 3;

function isOnline(lastSeen) {
  return (Date.now() - new Date(lastSeen + 'Z').getTime()) / 60000 < ONLINE_WINDOW_MINUTES;
}

function areFriends(a, b) {
  return !!db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(a, b);
}

function findPending(from, to) {
  return db
    .prepare('SELECT id FROM friend_requests WHERE sender_id = ? AND recipient_id = ?')
    .get(from, to);
}

// Friendship is stored as two rows (a->b and b->a) so lookups stay simple.
const makeFriends = db.transaction((a, b) => {
  const insert = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)');
  insert.run(a, b);
  insert.run(b, a);
  db.prepare(
    `DELETE FROM friend_requests
     WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`
  ).run(a, b, b, a);
});

// ---- Pages ----

router.get('/friends', ensureAuthenticated, (req, res) => {
  const friends = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status_message, u.last_seen
       FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? ORDER BY u.display_name COLLATE NOCASE`
    )
    .all(req.user.id)
    .map((u) => ({ ...u, isOnline: isOnline(u.last_seen) }));

  res.render('friends', { title: 'Friends', friends });
});

router.get('/friends/requests', ensureAuthenticated, (req, res) => {
  const incoming = db
    .prepare(
      `SELECT r.id AS request_id, u.id, u.username, u.display_name, u.avatar_url
       FROM friend_requests r JOIN users u ON u.id = r.sender_id
       WHERE r.recipient_id = ? ORDER BY r.created_at DESC`
    )
    .all(req.user.id);

  const outgoing = db
    .prepare(
      `SELECT r.id AS request_id, u.id, u.username, u.display_name, u.avatar_url
       FROM friend_requests r JOIN users u ON u.id = r.recipient_id
       WHERE r.sender_id = ? ORDER BY r.created_at DESC`
    )
    .all(req.user.id);

  res.render('friend-requests', { title: 'Friend requests', incoming, outgoing });
});

// ---- Actions ----

router.post('/friends/request/:id', ensureAuthenticated, (req, res) => {
  const targetId = Number(req.params.id);
  const me = req.user.id;

  if (!Number.isInteger(targetId) || targetId === me) return res.redirect('/users');

  const target = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(targetId);
  if (!target) {
    req.flash('error', 'User not found.');
    return res.redirect('/users');
  }

  if (areFriends(me, targetId)) {
    req.flash('error', `You and ${target.display_name} are already friends.`);
    return res.redirect('/users');
  }

  // They already asked us, so sending one back just accepts theirs.
  if (findPending(targetId, me)) {
    makeFriends(me, targetId);
    req.flash('success', `You are now friends with ${target.display_name}!`);
    return res.redirect('/users');
  }

  if (findPending(me, targetId)) {
    req.flash('error', 'Friend request already sent.');
    return res.redirect('/users');
  }

  db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(
    me,
    targetId
  );
  req.flash('success', `Friend request sent to ${target.display_name}.`);
  res.redirect('/users');
});

router.post('/friends/requests/:id/accept', ensureAuthenticated, (req, res) => {
  const request = db
    .prepare('SELECT sender_id FROM friend_requests WHERE id = ? AND recipient_id = ?')
    .get(Number(req.params.id), req.user.id);

  if (!request) {
    req.flash('error', 'That friend request no longer exists.');
    return res.redirect('/friends/requests');
  }

  makeFriends(req.user.id, request.sender_id);
  req.flash('success', 'Friend request accepted.');
  res.redirect('/friends/requests');
});

router.post('/friends/requests/:id/decline', ensureAuthenticated, (req, res) => {
  const result = db
    .prepare('DELETE FROM friend_requests WHERE id = ? AND recipient_id = ?')
    .run(Number(req.params.id), req.user.id);

  req.flash(result.changes ? 'success' : 'error', result.changes ? 'Friend request declined.' : 'That friend request no longer exists.');
  res.redirect('/friends/requests');
});

router.post('/friends/requests/:id/cancel', ensureAuthenticated, (req, res) => {
  const result = db
    .prepare('DELETE FROM friend_requests WHERE id = ? AND sender_id = ?')
    .run(Number(req.params.id), req.user.id);

  req.flash(result.changes ? 'success' : 'error', result.changes ? 'Friend request cancelled.' : 'That friend request no longer exists.');
  res.redirect('/friends/requests');
});

module.exports = router;
