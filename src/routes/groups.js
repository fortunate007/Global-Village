const express = require('express');
const fs = require('fs');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { chatImageUpload } = require('../config/upload');
const { withinLength } = require('../utils/validators');
const safety = require('../services/safetyService');
const { broadcastGroupMessage } = require('../services/groupRealtime');

const MAX_MESSAGE_LENGTH = 2000;
const MAX_GROUP_MEMBERS = 50;

const router = express.Router();

// Removes a file that was uploaded for a request that ended up being rejected
function discardUpload(req) {
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
}

function isMember(groupId, userId) {
  return !!db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
}

// The group and all its members are created together or not at all
const createGroup = db.transaction((creatorId, name, memberIds) => {
  const groupId = Number(
    db.prepare('INSERT INTO groups (name, created_by) VALUES (?, ?)').run(name, creatorId).lastInsertRowid
  );
  const addMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
  addMember.run(groupId, creatorId);
  memberIds.forEach((id) => addMember.run(groupId, id));
  return groupId;
});

router.get('/groups/new', ensureAuthenticated, (req, res) => {
  const blocked = safety.blockedIds(req.user.id);
  const users = db
    .prepare('SELECT id, username, display_name, avatar_url FROM users WHERE id != ? ORDER BY display_name COLLATE NOCASE')
    .all(req.user.id)
    .filter((u) => !blocked.has(u.id));
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

  const requested = [...new Set(memberIds)];
  if (requested.length + 1 > MAX_GROUP_MEMBERS) {
    req.flash('error', `Groups are limited to ${MAX_GROUP_MEMBERS} members.`);
    return res.redirect('/groups/new');
  }

  // Only real accounts, and never anyone who blocked you or whom you blocked
  const blocked = safety.blockedIds(req.user.id);
  const existing = new Set(
    db
      .prepare(`SELECT id FROM users WHERE id IN (${requested.map(() => '?').join(',')})`)
      .all(...requested)
      .map((r) => r.id)
  );
  const allowed = requested.filter((id) => existing.has(id) && !blocked.has(id));

  if (allowed.length === 0) {
    req.flash('error', 'Pick at least one other member.');
    return res.redirect('/groups/new');
  }

  const groupId = createGroup(req.user.id, name, allowed);

  const skipped = requested.length - allowed.length;
  if (skipped > 0) {
    req.flash('error', `${skipped} ${skipped === 1 ? 'person was' : 'people were'} not added.`);
  }
  res.redirect(`/groups/${groupId}`);
});

router.get('/groups/:id', ensureAuthenticated, (req, res) => {
  const groupId = Number(req.params.id);
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group || !isMember(groupId, req.user.id)) {
    req.flash('error', 'Group not found.');
    return res.redirect('/users');
  }

  // Messages from people you blocked, or who blocked you, are not shown
  const blocked = safety.blockedIds(req.user.id);
  const messages = db
    .prepare(
      `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = ? ORDER BY m.created_at ASC`
    )
    .all(groupId)
    .filter((m) => !blocked.has(m.sender_id));

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
  if (!isMember(groupId, req.user.id)) {
    discardUpload(req);
    return res.redirect('/users');
  }

  const body = (req.body.body || '').trim();
  const imageUrl = req.file ? `/uploads/chat/${req.file.filename}` : null;
  if (!body && !imageUrl) return res.redirect(`/groups/${groupId}`);

  if (!withinLength(body, MAX_MESSAGE_LENGTH)) {
    discardUpload(req);
    req.flash('error', `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
    return res.redirect(`/groups/${groupId}`);
  }

  const inserted = db
    .prepare('INSERT INTO messages (sender_id, group_id, body, image_url) VALUES (?, ?, ?, ?)')
    .run(req.user.id, groupId, body, imageUrl);

  // Live delivery to every current member who is not blocked either way
  broadcastGroupMessage(req.app.get('io'), Number(inserted.lastInsertRowid));

  res.redirect(`/groups/${groupId}`);
});

router.get('/api/groups/:id/since/:lastId', ensureAuthenticated, (req, res) => {
  const groupId = Number(req.params.id);
  const lastId = Number(req.params.lastId) || 0;
  if (!isMember(groupId, req.user.id)) return res.status(403).json([]);

  const blocked = safety.blockedIds(req.user.id);
  const messages = db
    .prepare(
      `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.group_id = ? AND m.id > ? ORDER BY m.created_at ASC`
    )
    .all(groupId, lastId)
    .filter((m) => !blocked.has(m.sender_id));

  res.json(messages);
});

// Leaving removes you from the group but keeps the messages you sent.
// When the last member leaves, the group and its messages are deleted.
const leaveGroup = db.transaction((groupId, userId) => {
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(groupId).n;
  if (remaining === 0) db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
});

router.post('/groups/:id/leave', ensureAuthenticated, (req, res) => {
  const groupId = Number(req.params.id);
  if (!isMember(groupId, req.user.id)) {
    req.flash('error', 'Group not found.');
    return res.redirect('/users');
  }
  leaveGroup(groupId, req.user.id);
  req.flash('success', 'You left the group.');
  res.redirect('/users');
});

module.exports = router;
