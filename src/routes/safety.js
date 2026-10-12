const express = require('express');
const safety = require('../services/safetyService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

const run = (message, fn, redirectTo = 'back') => (req, res, next) => {
  try {
    fn(req);
    req.flash('success', message);
    res.redirect(redirectTo);
  } catch (err) {
    if (err instanceof safety.SafetyError) {
      req.flash('error', err.message);
      return res.redirect('back');
    }
    next(err);
  }
};

const target = (req) => Number(req.params.id);

router.get('/safety', ensureAuth, (req, res) => {
  res.render('safety/index', {
    title: 'Blocked and muted',
    blocked: safety.listBlocked(req.user.id),
    muted: safety.listMuted(req.user.id),
  });
});

router.post('/safety/block/:id(\\d+)', ensureAuth,
  run('User blocked.', (req) => safety.block(req.user.id, target(req)), '/posts'));
router.post('/safety/unblock/:id(\\d+)', ensureAuth,
  run('User unblocked.', (req) => safety.unblock(req.user.id, target(req)), '/safety'));
router.post('/safety/mute/:id(\\d+)', ensureAuth,
  run('User muted. Their posts and notifications are now hidden from you.', (req) => safety.mute(req.user.id, target(req)), '/posts'));
router.post('/safety/unmute/:id(\\d+)', ensureAuth,
  run('User unmuted.', (req) => safety.unmute(req.user.id, target(req)), '/safety'));

router.get('/safety/report/:id(\\d+)', ensureAuth, (req, res) => {
  const post = safety.getReportablePost(Number(req.params.id));
  if (!post) return res.status(404).render('404', { title: 'Not Found' });
  res.render('safety/report', { title: 'Report post', post, reasons: safety.REASONS, reportedId: Number(req.params.id) });
});

router.post('/safety/report/:id(\\d+)', ensureAuth, (req, res, next) => {
  try {
    safety.report(req.user.id, Number(req.params.id), req.body.reason, req.body.details);
    req.flash('success', 'Thanks. Your report was sent to the moderators.');
    res.redirect('/posts');
  } catch (err) {
    if (err instanceof safety.SafetyError) {
      req.flash('error', err.message);
      return res.redirect('back');
    }
    next(err);
  }
});

module.exports = router;
