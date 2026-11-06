const fs = require('fs');
const path = require('path');
const db = require('../db');
const entities = require('./entityService');
const { PostError, MAX_LENGTH } = require('./postService');

const POSTS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'posts');
const UPLOAD_NAME = /^[0-9a-f]{32}\.(jpg|jpeg|png|gif|webp)$/;
const MAX_IMAGES = 4;
const MAX_ALT = 420;

const imagesStatement = db.prepare(
  'SELECT filename, mime, size, alt_text FROM post_images WHERE post_id = ? ORDER BY position'
);
const insertPost = db.prepare('INSERT INTO posts (author_id, body, parent_id) VALUES (?, ?, ?)');
const insertImage = db.prepare(
  'INSERT INTO post_images (post_id, position, filename, mime, size, alt_text) VALUES (?, ?, ?, ?, ?, ?)'
);

exports.MAX_IMAGES = MAX_IMAGES;
exports.MAX_ALT = MAX_ALT;
exports.POSTS_DIR = POSTS_DIR;

// A picture description: no control characters, trimmed, at most 420 characters
exports.cleanAlt = (value) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_ALT) : '';

// The pictures of one post, in order (used by the page templates)
exports.imagesFor = (postId) => imagesStatement.all(postId);

// Creates a post or reply together with its pictures, hashtags and mentions in one step.
// A post may have no text if it has at least one picture. images: [{ filename, mime, size, alt }]
const createTx = db.transaction(({ authorId, body, parentId, images }) => {
  const text = typeof body === 'string' ? body.trim() : '';
  if (images.length > MAX_IMAGES) throw new PostError(`You can attach up to ${MAX_IMAGES} pictures.`);
  if (!text && images.length === 0) throw new PostError('Post cannot be empty.');
  if (text.length > MAX_LENGTH) throw new PostError(`Posts are limited to ${MAX_LENGTH} characters.`);
  if (parentId !== null && !db.prepare('SELECT 1 FROM posts WHERE id = ?').get(parentId)) throw new PostError('Post not found.');

  const id = Number(insertPost.run(authorId, text, parentId).lastInsertRowid);
  entities.sync(id, text);
  images.forEach((image, position) => {
    insertImage.run(id, position, image.filename, image.mime, image.size, exports.cleanAlt(image.alt));
  });
  return id;
});

exports.createPostWithImages = ({ authorId, body, parentId = null, images = [] }) =>
  createTx({ authorId, body, parentId, images });

// File names of the pictures of a post and of every reply below it
exports.collectThreadFilenames = (postId) =>
  db
    .prepare(
      `WITH RECURSIVE thread(id) AS (
         SELECT id FROM posts WHERE id = ?
         UNION ALL
         SELECT p.id FROM posts p JOIN thread t ON p.parent_id = t.id
       )
       SELECT filename FROM post_images WHERE post_id IN (SELECT id FROM thread)`
    )
    .all(postId)
    .map((row) => row.filename);

// Like collectThreadFilenames, but only if the post belongs to this person (so only they trigger a cleanup)
exports.deletableFilenames = (postId, userId) =>
  db.prepare('SELECT 1 FROM posts WHERE id = ? AND author_id = ?').get(postId, userId)
    ? exports.collectThreadFilenames(postId)
    : [];

// Deletes picture files by name. Only names that look exactly like uploads are touched. Returns how many were removed.
exports.removeFiles = (filenames, dir = POSTS_DIR) => {
  let removed = 0;
  for (const name of filenames) {
    if (typeof name !== 'string' || !UPLOAD_NAME.test(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch (err) {
      // already gone
    }
  }
  return removed;
};
