const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { chatImageUpload } = require('../config/upload');
const { withinLength } = require('../utils/validators');

const MAX_MESSAGE_LENGTH = 2000;

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
    if (!withinLength(body, MAX_MESSAGE_LENGTH)) {
      req.flash('error', `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
      return res.redirect(`/messages/${otherId}`);
    }

    const other = db.prepare('SELECT id FROM users WHERE id = ?').get(otherId);
    if (!other) return res.redirect('/users');

    const result = db
      .prepare(
        `INSERT INTO messages (sender_id, recipient_id, body, image_url) VALUES (?, ?, ?, ?)`
      )
      .run(req.user.id, otherId, body, imageUrl);

    // Push the new message over each user's private socket room so open chat
    // views update instantly instead of waiting for the next poll tick.
    const saved = db
      .prepare(
        `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`
      )
      .get(result.lastInsertRowid);

    const io = req.app.get('io');
    if (io && saved) {
      io.to(`user:${otherId}`).emit('dm:new', saved);
      io.to(`user:${req.user.id}`).emit('dm:new', saved);
    }

    res.redirect(`/messages/${otherId}`);
  }
);

router.post('/messages/:userId/:messageId/edit', ensureAuthenticated, (req, res) => {
  const otherId = Number(req.params.userId);
  const messageId = Number(req.params.messageId);
  const body = (req.body.body || '').trim();

  if (!body) {
    req.flash('error', 'Message cannot be empty.');
    return res.redirect(`/messages/${otherId}`);
  }
  if (!withinLength(body, MAX_MESSAGE_LENGTH)) {
    req.flash('error', `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
    return res.redirect(`/messages/${otherId}`);
  }

  const message = db.prepare('SELECT sender_id, deleted_at FROM messages WHERE id = ?').get(messageId);
  if (!message || message.sender_id !== req.user.id || message.deleted_at) {
    req.flash('error', 'You can only edit your own messages.');
    return res.redirect(`/messages/${otherId}`);
  }

  db.prepare('UPDATE messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    body,
    messageId
  );

  const io = req.app.get('io');
  if (io) {
    io.to(`user:${otherId}`).emit('dm:edited', { id: messageId, body });
    io.to(`user:${req.user.id}`).emit('dm:edited', { id: messageId, body });
  }

  res.redirect(`/messages/${otherId}`);
});

router.post('/messages/:userId/:messageId/delete', ensureAuthenticated, (req, res) => {
  const otherId = Number(req.params.userId);
  const messageId = Number(req.params.messageId);

  const message = db.prepare('SELECT sender_id FROM messages WHERE id = ?').get(messageId);
  if (!message || message.sender_id !== req.user.id) {
    req.flash('error', 'You can only delete your own messages.');
    return res.redirect(`/messages/${otherId}`);
  }

  db.prepare(
    `UPDATE messages SET body = '', image_url = NULL, deleted_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(messageId);

  const io = req.app.get('io');
  if (io) {
    io.to(`user:${otherId}`).emit('dm:deleted', { id: messageId });
    io.to(`user:${req.user.id}`).emit('dm:deleted', { id: messageId });
  }

  res.redirect(`/messages/${otherId}`);
});

// Fallback polling endpoint. Kept so older cached clients don't break; the
// chat view now uses sockets for DMs. Groups still poll until commit 3.
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
