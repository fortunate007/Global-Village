const express = require('express');
const { ensureGuest } = require('../middleware/auth');
const { createLimiter } = require('../middleware/security');
const recovery = require('../services/recoveryService');
const { disconnectOtherSockets } = require('../realtime/sessions');

const router = express.Router();

const skip = () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS;
const requestLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 5, skip });
const resetLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 20, skip });

// Reset links must never be stored by browsers or caches
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

const invalidLink = (res) => res.status(400).render('recovery/invalid', { title: 'Link expired' });

router.get('/forgot-password', ensureGuest, (req, res) => {
  res.render('recovery/forgot', { title: 'Forgot password' });
});

// Always the same answer, whether or not the email belongs to an account
router.post('/forgot-password', ensureGuest, requestLimit, (req, res) => {
  recovery.requestReset(req.body.email);
  req.flash(
    'success',
    `If that email address belongs to an account, a reset link is on its way. It works for ${recovery.TOKEN_MINUTES} minutes.`
  );
  res.redirect('/login');
});

router.get('/reset-password/:token', ensureGuest, noStore, (req, res) => {
  if (!recovery.checkToken(req.params.token)) return invalidLink(res);
  res.render('recovery/reset', { title: 'Choose a new password', token: req.params.token });
});

router.post('/reset-password/:token', ensureGuest, resetLimit, noStore, (req, res, next) => {
  try {
    const userId = recovery.resetPassword(req.params.token, req.body.password, req.body.confirmPassword);
    // Close every live chat connection of the account (no session is kept)
    disconnectOtherSockets(req.app.get('io'), userId, null);
    req.flash('success', 'Password updated. Log in with your new password.');
    return res.redirect('/login');
  } catch (err) {
    if (!(err instanceof recovery.RecoveryError)) return next(err);
    if (err.code === 'invalid_link') return invalidLink(res);
    // The token passed validation above, so it is safe to place in the address
    req.flash('error', err.message);
    return res.redirect(`/reset-password/${req.params.token}`);
  }
});

module.exports = router;
