const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { createLimiter } = require('../middleware/security');
const credentials = require('../services/credentialService');
const { disconnectOtherSockets } = require('../realtime/sessions');

const router = express.Router();

// Guessing the current password from a logged-in session: 5 wrong attempts per 15 minutes (shared by both forms)
const passwordAttempts = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => !res.locals.passwordFailed,
  skip: () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS,
});

router.get('/account/security', ensureAuthenticated, (req, res) => {
  res.render('account/security', { title: 'Password and devices' });
});

// Runs a change that bumps the account counter, keeps this session logged in and closes the others
function handle(change, successMessage) {
  return (req, res, next) => {
    try {
      req.session.authEpoch = change(req);
      disconnectOtherSockets(req.app.get('io'), req.user.id, req.sessionID);
      req.flash('success', successMessage);
    } catch (err) {
      if (!(err instanceof credentials.CredentialError)) return next(err);
      if (err.code === 'wrong_password') res.locals.passwordFailed = true;
      req.flash('error', err.message);
    }
    return res.redirect('/account/security');
  };
}

router.post(
  '/account/password',
  ensureAuthenticated,
  passwordAttempts,
  handle(
    (req) =>
      credentials.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword, req.body.confirmPassword),
    'Password changed. Your other devices were logged out.'
  )
);

router.post(
  '/account/sessions/revoke',
  ensureAuthenticated,
  passwordAttempts,
  handle((req) => credentials.revokeOtherSessions(req.user.id, req.body.currentPassword), 'Your other devices were logged out.')
);

module.exports = router;
