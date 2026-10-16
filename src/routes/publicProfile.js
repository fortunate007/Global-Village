const express = require('express');
const profiles = require('../services/profileService');
const engagement = require('../services/engagementService');
const safety = require('../services/safetyService');

const router = express.Router();

const notFound = (res) => res.status(404).render('404', { title: 'Not Found' });

router.get('/users/:username', (req, res) => {
  const viewer = req.user ? req.user.id : null;
  const profile = profiles.findByUsername(req.params.username);

  // Blocked either way looks exactly like a missing account
  if (!profile || (viewer && safety.blockedEitherWay(viewer, profile.id))) return notFound(res);

  // /users/ALICE goes to the correctly capitalised address, keeping ?tab= and ?before=
  if (profile.username !== req.params.username) {
    const url = req.originalUrl;
    const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    return res.redirect(`/users/${profile.username}${query}`);
  }

  // Anything unexpected in the query string falls back to the first page of posts
  const tab = req.query.tab === 'replies' ? 'replies' : 'posts';
  const before = /^\d{1,15}$/.test(String(req.query.before || '')) ? Number(req.query.before) : null;

  const isSelf = viewer === profile.id;
  const relation = viewer && !isSelf ? profiles.relationship(viewer, profile.id) : {};
  const muted = Boolean(relation.isMuted);

  let items = [];
  let hasMore = false;
  let lastId = null;
  if (!muted) {
    const page = profiles.postsByAuthor(profile.id, { kind: tab, before });
    hasMore = page.hasMore;
    lastId = page.lastId;
    items = safety.filterPosts(viewer, page.rows);
  }

  res.render('user-profile', {
    title: profile.display_name,
    profileUser: profile,
    tab,
    items,
    hasMore,
    lastId,
    isSelf,
    relation,
    muted,
    postCount: profiles.postCount(profile.id),
    ...engagement.viewerState(viewer, engagement.collectIds(items)),
  });
});

module.exports = router;
