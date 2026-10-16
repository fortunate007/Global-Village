const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { createLimiter } = require('../middleware/security');
const verification = require('../services/emailVerificationService');

const router = express.Router();

const skip = () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS;
const sendLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 10, skip });
const confirmLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 20, skip });
// Guessing the password on the change form: 5 wrong attempts per 15 minutes (correct ones do not count)
const passwordAttempts = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => !res.locals.passwordFailed,
  skip,
});

// Confirmation links must never be stored by browsers or caches
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

const invalidLink = (res) => res.status(400).render('verification/invalid', { title: 'Link expired' });

// Opening the link changes nothing: email security scanners open links automatically, so the
// confirmation itself needs a button press (a POST).
router.get('/verify-email/:token', noStore, (req, res) => {
  if (!verification.checkToken(req.params.token)) return invalidLink(res);
  res.render('verification/confirm', { title: 'Confirm your email address', token: req.params.token });
});

router.post('/verify-email/:token', confirmLimit, noStore, (req, res, next) => {
  try {
    verification.confirm(req.params.token);
    req.flash('success', 'Your email address is confirmed. Thank you!');
    return res.redirect(req.isAuthenticated() ? '/users' : '/login');
  } catch (err) {
    if (!(err instanceof verification.VerificationError)) return next(err);
    return invalidLink(res);
  }
});

router.get('/account/verify-email', ensureAuthenticated, (req, res) => {
  res.render('verification/status', {
    title: 'Email address',
    email: req.user.email,
    pending: Boolean(req.user.email_pending_verification),
  });
});

// Runs a change, shows its result as a message and returns to the status page
function handle(change, successMessage) {
  return (req, res, next) => {
    try {
      change(req);
      req.flash('success', successMessage);
    } catch (err) {
      if (!(err instanceof verification.VerificationError)) return next(err);
      if (err.code === 'wrong_password') res.locals.passwordFailed = true;
      req.flash('error', err.message);
    }
    return res.redirect('/account/verify-email');
  };
}

router.post(
  '/account/verify-email/resend',
  ensureAuthenticated,
  sendLimit,
  handle((req) => verification.resend(req.user.id), 'We sent a new link. It can take a minute to arrive.')
);

router.post(
  '/account/email',
  ensureAuthenticated,
  passwordAttempts,
  sendLimit,
  handle(
    (req) => verification.changeEmail(req.user.id, req.body.password, req.body.newEmail),
    'Address updated. We sent a confirmation link to the new address.'
  )
);

module.exports = router;
