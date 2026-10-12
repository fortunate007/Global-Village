const express = require('express');
const safety = require('../services/safetyService');

const router = express.Router();

// Non-admins get the normal 404 page, so the admin area is not advertised
const requireAdmin = (req, res, next) =>
  req.isAuthenticated() && safety.isAdmin(req.user.id)
    ? next()
    : res.status(404).render('404', { title: 'Not Found' });

router.get('/admin/reports', requireAdmin, (req, res) => {
  res.render('admin/reports', { title: 'Reports', reports: safety.openReports(), reasons: safety.REASONS });
});

router.post('/admin/reports/:id(\\d+)/:action(resolve|dismiss|remove)', requireAdmin, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { action } = req.params;
    if (action === 'remove') safety.removeReportedPost(req.user.id, id);
    else safety.resolveReport(req.user.id, id, action === 'resolve' ? 'resolved' : 'dismissed');
    req.flash('success', 'Report handled.');
  } catch (err) {
    if (!(err instanceof safety.SafetyError)) return next(err);
    req.flash('error', err.message);
  }
  res.redirect('/admin/reports');
});

module.exports = router;
