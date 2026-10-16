const express = require('express');
const safety = require('../services/safetyService');
const moderation = require('../services/moderationService');
const { disconnectOtherSockets } = require('../realtime/sessions');

const router = express.Router();

// Non-admins get the normal 404 page, so the admin area is not advertised
const requireAdmin = (req, res, next) =>
  req.isAuthenticated() && safety.isAdmin(req.user.id)
    ? next()
    : res.status(404).render('404', { title: 'Not Found' });

// Only these two places can be returned to (never an address taken from the form)
const backTo = (req) => (req.body && req.body.from === 'reports' ? '/admin/reports' : '/admin/users');

router.get('/admin/users', requireAdmin, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 50) : '';
  res.render('admin/users', {
    title: 'Accounts',
    q,
    results: q ? moderation.searchUsers(q) : [],
    suspended: moderation.listSuspended(),
  });
});

router.get('/admin/actions', requireAdmin, (req, res) => {
  res.render('admin/actions', { title: 'Moderation log', actions: moderation.recentActions() });
});

function handle(change, message) {
  return (req, res, next) => {
    try {
      const account = change(req);
      // Close the chat connections that are open right now (new ones are refused automatically)
      if (req.path.endsWith('/suspend')) disconnectOtherSockets(req.app.get('io'), account.id, null);
      req.flash('success', message(account));
    } catch (err) {
      if (!(err instanceof moderation.ModerationError)) return next(err);
      req.flash('error', err.message);
    }
    return res.redirect(backTo(req));
  };
}

router.post(
  '/admin/users/:id(\\d+)/suspend',
  requireAdmin,
  handle((req) => moderation.suspend(req.user.id, Number(req.params.id), req.body.reason), (a) => `@${a.username} was suspended and logged out.`)
);

router.post(
  '/admin/users/:id(\\d+)/unsuspend',
  requireAdmin,
  handle((req) => moderation.unsuspend(req.user.id, Number(req.params.id), req.body.reason), (a) => `@${a.username} was unsuspended. They can log in again.`)
);

module.exports = router;
