const express = require('express');
const fs = require('fs');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { avatarUpload } = require('../config/upload');
const { isValidDisplayName, withinLength } = require('../utils/validators');
const safety = require('../services/safetyService');
const { removeAvatar } = require('../utils/avatarFiles');

const router = express.Router();

// Removes a file that was uploaded for a request that ended up being rejected
function discardUpload(req) {
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
}

router.get('/profile', ensureAuthenticated, (req, res) => {
  res.render('edit-profile', { title: 'Edit Profile', me: req.user });
});

router.post('/profile', ensureAuthenticated, avatarUpload.single('avatar'), (req, res) => {
  const { displayName, bio, statusMessage } = req.body;

  if (!isValidDisplayName(displayName)) {
    discardUpload(req);
    req.flash('error', 'Display name must be 1-40 characters.');
    return res.redirect('/profile');
  }
  if (!withinLength(bio, 500)) {
    discardUpload(req);
    req.flash('error', 'Bio must be 500 characters or fewer.');
    return res.redirect('/profile');
  }
  if (!withinLength(statusMessage, 80)) {
    discardUpload(req);
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

  // The previous picture is no longer used, so its file is removed
  if (req.file && req.user.avatar_url !== avatarUrl) removeAvatar(req.user.avatar_url);

  req.flash('success', 'Profile updated!');
  res.redirect('/profile');
});

router.get('/profile/:id', ensureAuthenticated, (req, res) => {
  const user = db
    .prepare('SELECT id, username, display_name, bio, avatar_url, status_message, created_at FROM users WHERE id = ?')
    .get(req.params.id);
  // Blocked either way looks exactly like a missing account
  if (!user || safety.blockedEitherWay(req.user.id, user.id)) {
    req.flash('error', 'User not found.');
    return res.redirect('/users');
  }
  res.render('profile', { title: user.display_name, profileUser: user });
});

module.exports = router;
