const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { imageFilter } = require('./upload');

const POSTS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'posts');
const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(POSTS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: POSTS_DIR,
  filename: (req, file, cb) =>
    cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
});

// The extension and declared type are checked here; the real contents are checked afterwards (utils/imageFiles.js)
const postImageUpload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: MAX_FILES, fields: 20, fieldSize: 4096, parts: 40 },
  fileFilter: imageFilter,
}).array('images', MAX_FILES);

module.exports = { postImageUpload, POSTS_DIR, MAX_FILES, MAX_BYTES };
