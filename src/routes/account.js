const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { createLimiter } = require('../middleware/security');
const accounts = require('../services/accountService');
const { removeChatImage } = require('../utils/chatFiles');
const { removeAvatar } = require('../utils/avatarFiles');

const router = express.Router();

// Guessing the password of a logged-in session is limited: 5 wrong attempts per 15 minutes
const passwordAttempts = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => !res.locals.passwordFailed,
  skip: () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS,
});

router.get('/account/delete', ensureAuthenticated, (req, res) => {
  res.render('account/delete', { title: 'Delete account', summary: accounts.summary(req.user.id) });
});

router.post('/account/delete', ensureAuthenticated, passwordAttempts, (req, res, next) => {
  const back = '/account/delete';
  const userId = req.user.id;

  if (req.body.confirm !== 'yes') {
    req.flash('error', 'Please tick the box to confirm.');
    return res.redirect(back);
  }

  // The session user never carries the password hash, so it is read from the database here
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    res.locals.passwordFailed = true;
    req.flash('error', 'Incorrect password.');
    return res.redirect(back);
  }

  let result;
  try {
    result = accounts.deleteAccount(userId);
  } catch (err) {
    if (err instanceof accounts.AccountError) {
      req.flash('error', err.message);
      return res.redirect(back);
    }
    return next(err);
  }

  // The database change is committed, so the picture files can go
  result.chat.forEach((url) => removeChatImage(url));
  result.avatars.forEach((url) => removeAvatar(url));

  // Close this person's open chat connections
  const io = req.app.get('io');
  if (io) io.in(`user:${userId}`).disconnectSockets(true);

  req.logout((err) => {
    if (err) return next(err);
    req.flash('success', 'Your account has been deleted.');
    res.redirect('/login');
  });
});

module.exports = router;
