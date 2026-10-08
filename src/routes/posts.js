const express = require('express');
const posts = require('../services/postService');
const engagement = require('../services/engagementService');

const router = express.Router();

const ensureAuth = (req, res, next) => (req.isAuthenticated() ? next() : res.redirect('/login'));

// Runs a service call; user-facing errors become flash messages, others hit the error handler
const action = (fn, redirectTo) => (req, res, next) => {
  try {
    const result = fn(req);
    res.redirect(redirectTo ? redirectTo(result, req) : 'back');
  } catch (err) {
    if (err instanceof posts.PostError) {
      req.flash('error', err.message);
      return res.redirect('back');
    }
    next(err);
  }
};

const viewerFor = (req, ...lists) =>
  engagement.viewerState(req.user && req.user.id, engagement.collectIds(...lists));

router.get('/', (req, res) => {
  const feed = posts.feed();
  res.render('posts/index', { title: 'Posts', feed, maxLength: posts.MAX_LENGTH, ...viewerFor(req, feed) });
});

router.get('/:id(\\d+)', (req, res) => {
  const thread = posts.getThread(Number(req.params.id));
  if (!thread) return res.status(404).render('404', { title: 'Not Found' });
  if (thread.post.repost_of_id) return res.redirect(`/posts/${thread.post.repost_of_id}`);
  res.render('posts/show', {
    title: 'Post',
    ...thread,
    maxLength: posts.MAX_LENGTH,
    ...viewerFor(req, thread.ancestors, [thread.post], thread.replies),
  });
});

router.post('/', ensureAuth, action((req) => posts.createPost(req.user.id, req.body.body), () => '/posts'));
router.post(
  '/:id(\\d+)/reply',
  ensureAuth,
  action((req) => posts.reply(req.user.id, Number(req.params.id), req.body.body), (_r, req) => `/posts/${req.params.id}`)
);
router.post(
  '/:id(\\d+)/quote',
  ensureAuth,
  action((req) => posts.quote(req.user.id, Number(req.params.id), req.body.body), (newId) => `/posts/${newId}`)
);
router.post('/:id(\\d+)/repost', ensureAuth, action((req) => posts.toggleRepost(req.user.id, Number(req.params.id))));
router.post('/:id(\\d+)/like', ensureAuth, action((req) => engagement.toggleLike(req.user.id, Number(req.params.id))));
router.post('/:id(\\d+)/bookmark', ensureAuth, action((req) => engagement.toggleBookmark(req.user.id, Number(req.params.id))));
router.post(
  '/:id(\\d+)/delete',
  ensureAuth,
  action((req) => posts.deletePost(req.user.id, Number(req.params.id)), () => '/posts')
);

module.exports = router;
