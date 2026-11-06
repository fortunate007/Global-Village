const fs = require('fs');
const path = require('path');

// Safe to show to the user
class ImageError extends Error {}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const EXTENSION_TYPE = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.gif': 'gif', '.webp': 'webp' };
const DAMAGED = 'One of the pictures is damaged.';

// The real type of a picture, from its first bytes (never from its name), or null
function detectType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// ---- JPEG: drop EXIF (location, camera, time), XMP, IPTC and comments; keep the rotation flag ----

// The rotation flag (1 to 8) inside an EXIF block (the bytes after "Exif\0\0"), or 0
function readExifOrientation(tiff) {
  try {
    if (tiff.length < 8) return 0;
    const little = tiff[0] === 0x49 && tiff[1] === 0x49;
    const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
    if (!little && !big) return 0;
    const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return 0;

    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : 0;
      }
    }
  } catch (err) {
    return 0;
  }
  return 0;
}

// A tiny EXIF block that holds only the rotation flag
function orientationSegment(value) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(value, 18);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

// Walks the segments before the picture data. Kept: JFIF (APP0), colour profile (APP2), Adobe (APP14) and every
// segment the picture needs. Dropped: all other application segments (EXIF, XMP, IPTC...) and comments.
function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new ImageError(DAMAGED);

  const kept = [buf.subarray(0, 2)];
  let orientation = 0;
  let pos = 2;

  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) throw new ImageError(DAMAGED);
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // picture data (or the end): copied unchanged below
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      kept.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }

    const length = buf.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > buf.length) throw new ImageError(DAMAGED);
    const segment = buf.subarray(pos, pos + 2 + length);

    if (marker === 0xe1 && segment.toString('latin1', 4, 10) === 'Exif\0\0') {
      orientation = orientation || readExifOrientation(segment.subarray(10));
    } else if (marker === 0xe0 || marker === 0xe2 || marker === 0xee) {
      kept.push(segment);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      // dropped
    } else {
      kept.push(segment);
    }
    pos += 2 + length;
  }

  if (orientation > 1) kept.splice(1, 0, orientationSegment(orientation));
  kept.push(buf.subarray(pos));
  return Buffer.concat(kept);
}

// The rotation flag of a JPEG (0 when it has none)
function jpegOrientation(buf) {
  let pos = 2;
  while (pos + 4 <= buf.length && buf[pos] === 0xff) {
    const marker = buf[pos + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2);
    if (marker === 0xe1 && buf.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
      return readExifOrientation(buf.subarray(pos + 10, pos + 2 + length));
    }
    pos += 2 + length;
  }
  return 0;
}

// ---- PNG: drop text, EXIF and time chunks ----
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(buf) {
  const kept = [buf.subarray(0, 8)];
  let pos = 8;
  let sawEnd = false;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > buf.length) throw new ImageError(DAMAGED);
    if (!PNG_DROP.has(type)) kept.push(buf.subarray(pos, end));
    pos = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new ImageError(DAMAGED);
  return Buffer.concat(kept);
}

// ---- WebP: drop the EXIF and XMP chunks and clear their flags ----
function stripWebp(buf) {
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const type = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (pos + 8 + size > buf.length) throw new ImageError(DAMAGED);
    const end = pos + 8 + size + (size % 2);
    if (type !== 'EXIF' && type !== 'XMP ') {
      let chunk = buf.subarray(pos, Math.min(end, buf.length));
      if (type === 'VP8X' && size >= 1) {
        chunk = Buffer.from(chunk);
        chunk[8] &= 0xf3; // EXIF (0x08) and XMP (0x04) flags
      }
      chunks.push(chunk);
    }
    pos = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

function stripMetadata(type, buf) {
  if (type === 'jpeg') return stripJpeg(buf);
  if (type === 'png') return stripPng(buf);
  if (type === 'webp') return stripWebp(buf);
  return buf; // GIFs carry no location data
}

// Checks an uploaded file by its real contents, removes its metadata (rewriting the file) and returns its type.
// Throws ImageError (safe to show) for anything that is not a picture of the type its name says.
function cleanUploadedImage(filePath, filename = filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    throw new ImageError('Could not read one of the pictures.');
  }

  const type = detectType(buf);
  if (!type) throw new ImageError('One of the files is not a valid picture.');
  const ext = path.extname(String(filename)).toLowerCase();
  if (!Object.hasOwn(EXTENSION_TYPE, ext) || EXTENSION_TYPE[ext] !== type) {
    throw new ImageError('One of the pictures does not match its file type.');
  }

  let cleaned;
  try {
    cleaned = stripMetadata(type, buf);
  } catch (err) {
    if (err instanceof ImageError) throw err;
    throw new ImageError(DAMAGED);
  }
  fs.writeFileSync(filePath, cleaned);
  return { type, mime: MIME[type], size: cleaned.length };
}

module.exports = { ImageError, detectType, stripMetadata, cleanUploadedImage, jpegOrientation, readExifOrientation };
