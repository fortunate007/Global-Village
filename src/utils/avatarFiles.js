const fs = require('fs');
const path = require('path');

const AVATAR_DIR = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
const UPLOAD_NAME = /^[0-9a-f]{32}\.(jpg|jpeg|png|gif|webp)$/;

// Deletes the file behind a stored avatar URL such as /uploads/avatars/<name>.png.
// Anything that is not exactly an upload name (the default avatar, odd paths) is ignored.
function removeAvatar(url) {
  if (!url) return false;
  const name = path.basename(String(url));
  if (!UPLOAD_NAME.test(name)) return false;
  try {
    fs.unlinkSync(path.join(AVATAR_DIR, name));
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { removeAvatar, AVATAR_DIR };
