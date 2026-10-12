const fs = require('fs');
const path = require('path');
const { removeChatImage, CHAT_DIR } = require('../src/utils/chatFiles');

const NAME = '0123456789abcdef0123456789abcdef.png';

test('removes exactly the named upload and nothing else', () => {
  fs.writeFileSync(path.join(CHAT_DIR, NAME), 'x');
  expect(removeChatImage(`/uploads/chat/${NAME}`)).toBe(true);
  expect(fs.existsSync(path.join(CHAT_DIR, NAME))).toBe(false);
});

test('ignores anything that is not an upload filename', () => {
  expect(removeChatImage(null)).toBe(false);
  expect(removeChatImage('')).toBe(false);
  expect(removeChatImage('/uploads/chat/not-an-upload.png')).toBe(false);
  expect(removeChatImage('../../../package.json')).toBe(false);
  expect(fs.existsSync(path.join(__dirname, '..', 'package.json'))).toBe(true);
  expect(removeChatImage(`/uploads/chat/${NAME}`)).toBe(false); // already gone
});
