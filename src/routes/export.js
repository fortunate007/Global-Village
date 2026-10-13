const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { ensureAuthenticated } = require('../middleware/auth');
const { createLimiter } = require('../middleware/security');
const exportService = require('../services/exportService');

const router = express.Router();

const skip = () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS;
const passwordFailed = (req, res) => !res.locals.passwordFailed;

// Wrong passwords: 5 per 15 minutes (correct ones do not count)
const passwordAttempts = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  requestWasSuccessful: passwordFailed,
  skip,
});

// Successful downloads: 5 per hour (wrong passwords do not count)
const downloads = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  skipFailedRequests: true,
  requestWasSuccessful: passwordFailed,
  skip,
});

router.get('/account/export', ensureAuthenticated, (req, res) => {
  res.render('account/export', { title: 'Download your data' });
});

router.post('/account/export', ensureAuthenticated, passwordAttempts, downloads, (req, res) => {
  // The session user never carries the password hash, so it is read from the database here
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    res.locals.passwordFailed = true;
    req.flash('error', 'Incorrect password.');
    return res.redirect('/account/export');
  }

  const data = exportService.buildExport(req.user.id);
  if (!data) return res.redirect('/login');

  const day = new Date().toISOString().slice(0, 10);
  const name = String(data.profile.username).replace(/[^A-Za-z0-9_-]/g, '');
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="global-village-data-${name}-${day}.json"`,
    'Cache-Control': 'no-store',
  });
  res.send(JSON.stringify(data, null, 2));
});

module.exports = router;
