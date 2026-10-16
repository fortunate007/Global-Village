const express = require('express');
const safety = require('../services/safetyService');
const moderation = require('../services/moderationService');

const router = express.Router();

// Non-admins get the normal 404 page, so the admin area is not advertised
const requireAdmin = (req, res, next) =>
  req.isAuthenticated() && safety.isAdmin(req.user.id)
    ? next()
    : res.status(404).render('404', { title: 'Not Found' });

const MESSAGES = {
  resolve: 'Report resolved.',
  dismiss: 'Report dismissed.',
  remove: 'Post removed and its reports resolved.',
};

router.get('/admin/reports', requireAdmin, (req, res) => {
  res.render('admin/reports', { title: 'Reports', reports: safety.openReports(), reasons: safety.REASONS });
});

router.post('/admin/reports/:id(\\d+)/:action(resolve|dismiss|remove)', requireAdmin, (req, res, next) => {
  const { action } = req.params;
  try {
    moderation.handleReport(req.user.id, Number(req.params.id), action);
    req.flash('success', MESSAGES[action]);
  } catch (err) {
    if (!(err instanceof moderation.ModerationError) && !(err instanceof safety.SafetyError)) return next(err);
    req.flash('error', err.message);
  }
  res.redirect('/admin/reports');
});

module.exports = router;
