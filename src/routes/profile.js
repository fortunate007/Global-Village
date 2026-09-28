const express = require('express');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { avatarUpload } = require('../config/upload');
const { isValidDisplayName, withinLength } = require('../utils/validators');

const router = express.Router();

router.get('/profile', ensureAuthenticated, (req, res) => {
  res.render('edit-profile', { title: 'Edit Profile', me: req.user });
});

router.post('/profile', ensureAuthenticated, avatarUpload.single('avatar'), (req, res) => {
  const { displayName, bio, statusMessage } = req.body;

  if (!isValidDisplayName(displayName)) {
    req.flash('error', 'Display name must be 1-40 characters.');
    return res.redirect('/profile');
  }
  if (!withinLength(bio, 500)) {
    req.flash('error', 'Bio must be 500 characters or fewer.');
    return res.redirect('/profile');
  }
  if (!withinLength(statusMessage, 80)) {
    req.flash('error', 'Status message must be 80 characters or fewer.');
    return res.redirect('/profile');
  }

  const avatarUrl = req.file ? `/uploads/avatars/${req.file.filename}` : req.user.avatar_url;

  db.prepare(
    `UPDATE users SET display_name = ?, bio = ?, status_message = ?, avatar_url = ? WHERE id = ?`
  ).run(
    displayName.trim(),
    (bio || '').trim(),
    (statusMessage || '').trim(),
    avatarUrl,
    req.user.id
  );

  req.flash('success', 'Profile updated!');
  res.redirect('/profile');
});

router.get('/profile/:id', ensureAuthenticated, (req, res) => {
  const user = db
    .prepare('SELECT id, username, display_name, bio, avatar_url, status_message, created_at FROM users WHERE id = ?')
    .get(req.params.id);
  if (!user) {
    req.flash('error', 'User not found.');
    return res.redirect('/users');
  }
  res.render('profile', { title: user.display_name, profileUser: user });
});

module.exports = router;
