const fs = require('fs');
const path = require('path');

const CHAT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'chat');
const UPLOAD_NAME = /^[0-9a-f]{32}\.(jpg|jpeg|png|gif|webp)$/;

// Deletes the file behind a stored image URL such as /uploads/chat/<name>.png.
// Anything that is not exactly an upload name is ignored. Returns true if a file was removed.
function removeChatImage(url) {
  if (!url) return false;
  const name = path.basename(String(url));
  if (!UPLOAD_NAME.test(name)) return false;
  try {
    fs.unlinkSync(path.join(CHAT_DIR, name));
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { removeChatImage, CHAT_DIR };
