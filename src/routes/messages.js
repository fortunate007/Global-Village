const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { chatImageUpload } = require('../config/upload');

const router = express.Router();

router.get('/messages/:userId', ensureAuthenticated, (req, res) => {
  const otherId = Number(req.params.userId);
  if (otherId === req.user.id) return res.redirect('/users');

  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (!other) {
    req.flash('error', 'User not found.');
    return res.redirect('/users');
  }

  const messages = db
    .prepare(
      `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.group_id IS NULL AND
         ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
       ORDER BY m.created_at ASC`
    )
    .all(req.user.id, otherId, otherId, req.user.id);

  res.render('chat', {
    title: `Chat with ${other.display_name}`,
    other,
    group: null,
    messages,
    chatType: 'dm',
    chatTargetId: otherId,
  });
});

router.post(
  '/messages/:userId',
  ensureAuthenticated,
  chatImageUpload.single('image'),
  (req, res) => {
    const otherId = Number(req.params.userId);
    const body = (req.body.body || '').trim();
    const imageUrl = req.file ? `/uploads/chat/${req.file.filename}` : null;

    if (!body && !imageUrl) {
      return res.redirect(`/messages/${otherId}`);
    }

    const other = db.prepare('SELECT id FROM users WHERE id = ?').get(otherId);
    if (!other) return res.redirect('/users');

    db.prepare(
      `INSERT INTO messages (sender_id, recipient_id, body, image_url) VALUES (?, ?, ?, ?)`
    ).run(req.user.id, otherId, body, imageUrl);

    res.redirect(`/messages/${otherId}`);
  }
);

// Polling endpoint: fetch messages newer than a given id (used by frontend JS)
router.get('/api/messages/:userId/since/:lastId', ensureAuthenticated, (req, res) => {
  const otherId = Number(req.params.userId);
  const lastId = Number(req.params.lastId) || 0;

  const messages = db
    .prepare(
      `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.group_id IS NULL AND m.id > ? AND
         ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
       ORDER BY m.created_at ASC`
    )
    .all(lastId, req.user.id, otherId, otherId, req.user.id);

  res.json(messages);
});

module.exports = router;
