const express = require('express');
const { ensureGuest } = require('../middleware/auth');
const { createLimiter } = require('../middleware/security');
const signup = require('../services/signupService');

const router = express.Router();

const skip = () => process.env.NODE_ENV === 'test' && !process.env.TEST_RATE_LIMITS;
const sendLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 10, skip });
const codeLimit = createLimiter({ windowMs: 60 * 60 * 1000, limit: 30, skip });

// Pages with codes or contact details must never be stored by browsers or caches
const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// Verification is required, but codes only appear in the server log until email or SMS sending is set up
const transports = [process.env.MAIL_TRANSPORT, process.env.SMS_TRANSPORT].map((value) => String(value || 'log').trim().toLowerCase());
if (signup.enabled() && (process.env.NODE_ENV === 'production' || process.env.RENDER) && transports.every((t) => t === 'log')) {
  console.warn(
    '[signup] Verification is required, but neither MAIL_TRANSPORT nor SMS_TRANSPORT is set up, so codes only appear in this log ' +
      'and new people cannot finish signing up. Set up email or SMS sending, or set REQUIRE_SIGNUP_VERIFICATION=false until you have.'
  );
}

router.post('/register', ensureGuest, (req, res, next) => {
  if (!signup.enabled()) return next();

  const body = req.body || {};
  try {
    const id = signup.startSignup({
      username: body.username,
      email: body.email,
      password: body.password,
      confirmPassword: body.confirmPassword,
      displayName: body.displayName,
      phone: body.phone,
      phoneCountry: body.phoneCountry,
      verifyBy: body.verifyBy,
      replaceId: req.session.signupId,
    });
    req.session.signupId = id;
    return res.redirect('/register/verify');
  } catch (err) {
    if (!(err instanceof signup.SignupError)) return next(err);
    return res.render('register', {
      title: 'Register',
      errors: err.errors,
      formData: { username: body.username, email: body.email, displayName: body.displayName },
    });
  }
});

router.get('/register/verify', ensureGuest, noStore, (req, res) => {
  const pending = signup.getPending(req.session.signupId);
  if (!pending) {
    delete req.session.signupId;
    return res.redirect('/register');
  }
  return res.render('signup/verify', {
    title: 'Verify to finish signing up',
    method: pending.method,
    destination: signup.maskDestination(pending),
    minutes: signup.CODE_MINUTES,
    canResend: pending.sends < signup.MAX_SENDS,
  });
});

router.post('/register/verify', ensureGuest, codeLimit, noStore, (req, res, next) => {
  try {
    const { userId } = signup.verify(req.session.signupId, req.body.code);
    delete req.session.signupId;
    return req.login({ id: userId }, (err) => {
      if (err) {
        req.flash('error', 'Your account was created. Please log in.');
        return res.redirect('/login');
      }
      req.flash('success', 'Your account is ready. Welcome to Global Village!');
      return res.redirect('/users');
    });
  } catch (err) {
    if (!(err instanceof signup.SignupError)) return next(err);
    req.flash('error', err.message);
    if (['expired', 'locked', 'taken'].includes(err.code)) {
      delete req.session.signupId;
      return res.redirect('/register');
    }
    return res.redirect('/register/verify');
  }
});

router.post('/register/resend', ensureGuest, sendLimit, (req, res, next) => {
  try {
    signup.resend(req.session.signupId);
    req.flash('success', 'We sent a new code.');
  } catch (err) {
    if (!(err instanceof signup.SignupError)) return next(err);
    req.flash('error', err.message);
    if (err.code === 'expired') {
      delete req.session.signupId;
      return res.redirect('/register');
    }
  }
  return res.redirect('/register/verify');
});

router.post('/register/cancel', ensureGuest, (req, res) => {
  signup.cancel(req.session.signupId);
  delete req.session.signupId;
  res.redirect('/register');
});

module.exports = router;
