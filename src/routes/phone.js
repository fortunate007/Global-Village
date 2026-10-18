const express = require('express');
const { ensureGuest } = require('../middleware/auth');
const { createLimiter } = require('../middleware/security');
const phones = require('../services/phoneService');
const recovery = require('../services/recoveryService');

const router = express.Router();

const skip = () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS;
const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

// Guessing the password on the forms that need it: 5 wrong attempts per 15 minutes (correct ones do not count)
const passwordAttempts = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => !res.locals.passwordFailed,
  skip,
});
const sendLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 10, skip });
const verifyLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 30, skip });
const resetRequestLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 5, skip });
const resetCodeLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 20, skip });

// Pages with codes or numbers on them must never be stored by browsers or caches
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// ---- The account page ----

router.get('/account/phone', ensureAuth, noStore, (req, res) => {
  res.render('phone/status', {
    title: 'Phone number',
    phone: req.user.phone || null,
    verified: Boolean(req.user.phone_verified_at),
    minutes: phones.CODE_MINUTES,
  });
});

// Runs a change, shows its result as a message and returns to the account page
function handle(change, successMessage) {
  return (req, res, next) => {
    try {
      change(req);
      req.flash('success', successMessage);
    } catch (err) {
      if (!(err instanceof phones.PhoneError)) return next(err);
      if (err.code === 'wrong_password') res.locals.passwordFailed = true;
      req.flash('error', err.message);
    }
    return res.redirect('/account/phone');
  };
}

router.post(
  '/account/phone',
  ensureAuth,
  passwordAttempts,
  sendLimit,
  handle((req) => phones.setPhone(req.user.id, req.body.password, req.body.phone, req.body.phoneCountry), 'We texted a code to that number. Enter it below.')
);
router.post('/account/phone/verify', ensureAuth, verifyLimit, handle((req) => phones.confirm(req.user.id, req.body.code), 'Your phone number is verified.'));
router.post('/account/phone/resend', ensureAuth, sendLimit, handle((req) => phones.resend(req.user.id), 'We sent a new code.'));
router.post('/account/phone/remove', ensureAuth, passwordAttempts, handle((req) => phones.remove(req.user.id, req.body.password), 'Your phone number was removed.'));

// ---- Password reset by text message ----

router.get('/forgot-password/phone', ensureGuest, (req, res) => {
  res.render('phone/reset-request', { title: 'Reset by text message' });
});

// The same answer whether or not the number belongs to an account
router.post('/forgot-password/phone', ensureGuest, resetRequestLimit, (req, res) => {
  const phone = phones.normalizePhone(req.body.phone, req.body.phoneCountry);
  if (!phone) {
    req.flash('error', 'Enter a valid phone number for the selected country, or type the full number starting with + and the country code.');
    return res.redirect('/forgot-password/phone');
  }

  phones.requestResetCode(phone);
  req.session.phoneReset = { phone };
  req.flash('success', `If that number is verified on an account, we sent a code to it. It works for ${phones.CODE_MINUTES} minutes.`);
  return res.redirect('/forgot-password/phone/code');
});

router.get('/forgot-password/phone/code', ensureGuest, noStore, (req, res) => {
  const pending = req.session.phoneReset;
  if (!pending) return res.redirect('/forgot-password/phone');
  return res.render('phone/reset-code', { title: 'Enter your code', masked: phones.mask(pending.phone) });
});

router.post('/forgot-password/phone/code', ensureGuest, resetCodeLimit, noStore, (req, res, next) => {
  const pending = req.session.phoneReset;
  if (!pending) return res.redirect('/forgot-password/phone');

  try {
    const userId = phones.verifyResetCode(pending.phone, req.body.code);
    delete req.session.phoneReset;
    // The code proved the number, so the normal reset page takes over: set the new password, end old sessions
    return res.redirect(`/reset-password/${recovery.issueTokenForUser(userId)}`);
  } catch (err) {
    if (!(err instanceof phones.PhoneError)) return next(err);
    req.flash('error', err.message);
    return res.redirect('/forgot-password/phone/code');
  }
});

module.exports = router;
