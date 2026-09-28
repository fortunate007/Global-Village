const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { chatImageUpload } = require('../config/upload');
const { withinLength } = require('../utils/validators');

const router = express.Router();

function isMember(groupId, userId) {
  return !!db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

router.get('/groups/new', ensureAuthenticated, (req, res) => {
  const users = db
    .prepare('SELECT id, username, display_name, avatar_url FROM users WHERE id != ? ORDER BY display_name COLLATE NOCASE')
    .all(req.user.id);
  res.render('create-group', { title: 'New Group', users });
});

router.post('/groups', ensureAuthenticated, (req, res) => {
  const name = (req.body.name || '').trim();
  let memberIds = req.body.memberIds || [];
  if (!Array.isArray(memberIds)) memberIds = [memberIds];
  memberIds = memberIds.map(Number).filter((id) => id && id !== req.user.id);

  if (!name) {
    req.flash('error', 'Group needs a name.');
    return res.redirect('/groups/new');
  }
  if (!withinLength(name, 60)) {
    req.flash('error', 'Group name must be 60 characters or fewer.');
    return res.redirect('/groups/new');
  }
  if (memberIds.length === 0) {
    req.flash('error', 'Pick at least one other member.');
    return res.redirect('/groups/new');
  }

  const info = db
    .prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)')
    .run(name, req.user.id);
  const groupId = info.lastInsertRowid;

  const addMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
  addMember.run(groupId, req.user.id);
  for (const id of memberIds) addMember.run(groupId, id);

  res.redirect(`/groups/${groupId}`);
});

router.get('/groups/:id', ensureAuthenticated, (req, res) => {
  const groupId = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group || !isMember(groupId, req.user.id)) {
    req.flash('error', 'Group not found.');
    return res.redirect('/users');
  }

  const messages = db
    .prepare(
      `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = ? ORDER BY m.created_at ASC`
    )
    .all(groupId);

  const members = db
    .prepare(
      `SELECT u.id, u.display_name, u.avatar_url FROM group_members gm
       JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`
    )
    .all(groupId);

  res.render('chat', {
    title: group.name,
    other: null,
    group: { ...group, members },
    messages,
    chatType: 'group',
    chatTargetId: groupId,
  });
});

router.post('/groups/:id', ensureAuthenticated, chatImageUpload.single('image'), (req, res) => {
  const groupId = Number(req.params.id);
  if (!isMember(groupId, req.user.id)) return res.redirect('/users');

  const body = (req.body.body || '').trim();
  const imageUrl = req.file ? `/uploads/chat/${req.file.filename}` : null;
  if (!body && !imageUrl) return res.redirect(`/groups/${groupId}`);

  db.prepare(
    `INSERT INTO messages (sender_id, group_id, body, image_url) VALUES (?, ?, ?, ?)`
  ).run(req.user.id, groupId, body, imageUrl);

  res.redirect(`/groups/${groupId}`);
});

router.get('/api/groups/:id/since/:lastId', ensureAuthenticated, (req, res) => {
  const groupId = Number(req.params.id);
  const lastId = Number(req.params.lastId) || 0;
  if (!isMember(groupId, req.user.id)) return res.status(403).json([]);

  const messages = db
    .prepare(
      `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = ? AND m.id > ? ORDER BY m.created_at ASC`
    )
    .all(groupId, lastId);

  res.json(messages);
});

module.exports = router;
