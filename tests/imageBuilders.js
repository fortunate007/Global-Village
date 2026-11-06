// Small pictures for tests. The real ones are tiny valid files; the synthetic ones have the right structure
// (and a secret hidden where metadata lives) but are not meant to be displayed.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function segment(marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

const JPEG_TAIL = Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]);

// A JPEG with JFIF, EXIF (rotation flag plus a hidden "GPS" text), XMP and a comment before its picture data
function makeJpeg({ orientation = 6, secret = 'GPS-SECRET-42', withExif = true } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(segment(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1')));
  if (withExif) {
    const tiff = Buffer.alloc(38 + secret.length);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(2, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    tiff.writeUInt16BE(0x8825, 22);
    tiff.writeUInt16BE(4, 24);
    tiff.writeUInt32BE(1, 26);
    tiff.writeUInt32BE(38, 30);
    tiff.writeUInt32BE(0, 34);
    tiff.write(secret, 38, 'latin1');
    parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])));
  }
  parts.push(segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>XMP-SECRET</x:xmpmeta>', 'latin1')));
  parts.push(segment(0xfe, Buffer.from('COMMENT-SECRET', 'latin1')));
  parts.push(segment(0xdb, Buffer.alloc(65, 1)));
  parts.push(segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])));
  parts.push(segment(0xc4, Buffer.alloc(20, 2)));
  parts.push(segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])));
  parts.push(JPEG_TAIL);
  return Buffer.concat(parts);
}

const pngChunk = (type, data = Buffer.alloc(0)) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};

// A PNG with a text chunk and a time chunk hiding a secret
function makePng({ secret = 'PNG-SECRET-42' } = {}) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from(`Comment\0${secret}`, 'latin1')),
    pngChunk('tIME', Buffer.from([7, 234, 1, 1, 0, 0, 0])),
    pngChunk('IDAT', Buffer.from([1, 2, 3, 4])),
    pngChunk('IEND'),
  ]);
}

const webpChunk = (type, data) => {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

// A WebP with EXIF and XMP chunks hiding a secret, and the matching flags set
function makeWebp({ secret = 'WEBP-SECRET' } = {}) {
  const flags = Buffer.alloc(10);
  flags[0] = 0x0c;
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    webpChunk('VP8X', flags),
    webpChunk('VP8 ', Buffer.from([1, 2, 3, 4])),
    webpChunk('EXIF', Buffer.from(secret, 'latin1')),
    webpChunk('XMP ', Buffer.from(`<x>${secret}</x>`, 'latin1')),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

module.exports = { PNG_1X1, GIF_1X1, JPEG_TAIL, makeJpeg, makePng, makeWebp };
