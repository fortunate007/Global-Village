const fs = require('fs');
const os = require('os');
const path = require('path');
const images = require('../src/utils/imageFiles');
const { PNG_1X1, GIF_1X1, JPEG_TAIL, makeJpeg, makePng, makeWebp } = require('./imageBuilders');

const { detectType, stripMetadata, cleanUploadedImage, jpegOrientation, ImageError } = images;
const has = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'images-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function saved(name, contents) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('recognising pictures by their contents', () => {
  test('real pictures are recognised whatever they are called', () => {
    expect(detectType(PNG_1X1)).toBe('png');
    expect(detectType(GIF_1X1)).toBe('gif');
    expect(detectType(makeJpeg())).toBe('jpeg');
    expect(detectType(makeWebp())).toBe('webp');
    expect(detectType(makePng())).toBe('png');
  });

  test('everything else is not a picture', () => {
    [
      Buffer.alloc(0),
      Buffer.from('plain text'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from([0xff, 0xd8]),
      Buffer.from('RIFF....WAVE'),
    ].forEach((buf) => expect(detectType(buf)).toBeNull());
  });
});

describe('JPEG metadata', () => {
  test('location, XMP and comments are removed, the rotation flag and the picture are kept', () => {
    const original = makeJpeg({ orientation: 6 });
    expect(has(original, 'GPS-SECRET-42')).toBe(true);
    expect(jpegOrientation(original)).toBe(6);

    const cleaned = stripMetadata('jpeg', original);
    ['GPS-SECRET-42', 'XMP-SECRET', 'COMMENT-SECRET', 'xmpmeta'].forEach((secret) => expect(has(cleaned, secret)).toBe(false));
    expect(jpegOrientation(cleaned)).toBe(6);
    expect(has(cleaned, 'JFIF')).toBe(true);
    expect(cleaned.subarray(cleaned.length - JPEG_TAIL.length).equals(JPEG_TAIL)).toBe(true);
    expect(detectType(cleaned)).toBe('jpeg');
    expect(cleaned.length).toBeLessThan(original.length);
  });

  test('every rotation flag survives, and a picture without one gets none', () => {
    for (let flag = 2; flag <= 8; flag += 1) {
      expect(jpegOrientation(stripMetadata('jpeg', makeJpeg({ orientation: flag })))).toBe(flag);
    }
    expect(jpegOrientation(stripMetadata('jpeg', makeJpeg({ orientation: 1 })))).toBe(0);
    const plain = stripMetadata('jpeg', makeJpeg({ withExif: false }));
    expect(jpegOrientation(plain)).toBe(0);
    expect(has(plain, 'Exif')).toBe(false);
  });

  test('damaged files are refused', () => {
    const original = makeJpeg();
    expect(() => stripMetadata('jpeg', original.subarray(0, 30))).toThrow(ImageError);
    expect(() => stripMetadata('jpeg', Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('garbage-bytes-here')]))).toThrow(ImageError);
  });
});

describe('PNG, WebP and GIF', () => {
  test('PNG text and time chunks are removed and the picture chunks stay', () => {
    const cleaned = stripMetadata('png', makePng({ secret: 'PNG-SECRET-42' }));
    expect(has(cleaned, 'PNG-SECRET-42')).toBe(false);
    ['tEXt', 'tIME'].forEach((type) => expect(has(cleaned, type)).toBe(false));
    ['IHDR', 'IDAT', 'IEND'].forEach((type) => expect(has(cleaned, type)).toBe(true));
    expect(detectType(cleaned)).toBe('png');
    expect(stripMetadata('png', PNG_1X1).equals(PNG_1X1)).toBe(true);
  });

  test('a truncated PNG is refused', () => {
    expect(() => stripMetadata('png', makePng().subarray(0, 40))).toThrow(ImageError);
  });

  test('WebP EXIF and XMP chunks are removed, the flags cleared and the size updated', () => {
    const original = makeWebp({ secret: 'WEBP-SECRET' });
    const cleaned = stripMetadata('webp', original);

    expect(has(cleaned, 'WEBP-SECRET')).toBe(false);
    expect(has(cleaned, 'EXIF')).toBe(false);
    expect(has(cleaned, 'XMP ')).toBe(false);
    expect(has(cleaned, 'VP8 ')).toBe(true);
    expect(cleaned.readUInt32LE(4)).toBe(cleaned.length - 8);
    const vp8x = cleaned.indexOf(Buffer.from('VP8X', 'latin1'));
    expect(cleaned[vp8x + 8] & 0x0c).toBe(0);
    expect(detectType(cleaned)).toBe('webp');
  });

  test('GIFs are left as they are', () => {
    expect(stripMetadata('gif', GIF_1X1).equals(GIF_1X1)).toBe(true);
  });
});

describe('cleaning an uploaded file', () => {
  test('rewrites the file without its metadata and reports its type and size', () => {
    const file = saved('0123456789abcdef0123456789abcdef.jpg', makeJpeg());
    const result = cleanUploadedImage(file, file);

    expect(result.type).toBe('jpeg');
    expect(result.mime).toBe('image/jpeg');
    const stored = fs.readFileSync(file);
    expect(result.size).toBe(stored.length);
    expect(has(stored, 'GPS-SECRET-42')).toBe(false);
  });

  test('accepts each real type under its own extension', () => {
    expect(cleanUploadedImage(saved('a.png', PNG_1X1), 'a.png').mime).toBe('image/png');
    expect(cleanUploadedImage(saved('a.gif', GIF_1X1), 'a.gif').mime).toBe('image/gif');
    expect(cleanUploadedImage(saved('a.webp', makeWebp()), 'a.webp').mime).toBe('image/webp');
    expect(cleanUploadedImage(saved('a.jpeg', makeJpeg()), 'A.JPEG').mime).toBe('image/jpeg');
  });

  test('files that are not pictures, or do not match their name, are refused and left untouched', () => {
    const text = saved('x.png', 'this is not a picture');
    expect(() => cleanUploadedImage(text, 'x.png')).toThrow(/not a valid picture/);

    const svg = saved('y.png', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect(() => cleanUploadedImage(svg, 'y.png')).toThrow(/not a valid picture/);

    const png = saved('z.jpg', PNG_1X1);
    expect(() => cleanUploadedImage(png, 'z.jpg')).toThrow(/does not match its file type/);
    expect(fs.readFileSync(png).equals(PNG_1X1)).toBe(true);

    ['q.svg', 'q.html', 'q', 'q.__proto__'].forEach((name) => {
      expect(() => cleanUploadedImage(saved('w', PNG_1X1), name)).toThrow(ImageError);
    });
    expect(() => cleanUploadedImage(path.join(dir, 'missing.png'), 'missing.png')).toThrow(/Could not read/);
  });
});
