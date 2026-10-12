const { imageFilter } = require('../src/config/upload');

const check = (originalname, mimetype) =>
  new Promise((resolve) => imageFilter({}, { originalname, mimetype }, (err, ok) => resolve({ err, ok })));

test('real images are accepted, whatever the letter case', async () => {
  expect((await check('photo.jpg', 'image/jpeg')).ok).toBe(true);
  expect((await check('photo.JPEG', 'image/jpeg')).ok).toBe(true);
  expect((await check('Logo.PNG', 'image/png')).ok).toBe(true);
  expect((await check('anim.gif', 'image/gif')).ok).toBe(true);
  expect((await check('pic.webp', 'image/webp')).ok).toBe(true);
});

test('svg, scripts and lookalike extensions are rejected', async () => {
  for (const [name, type] of [
    ['x.svg', 'image/svg+xml'],
    ['x.pnghtml', 'image/png'],
    ['x.png.html', 'text/html'],
    ['x.html', 'text/html'],
    ['x.js', 'application/javascript'],
    ['noextension', 'image/png'],
    ['x.png', 'text/html'],
    ['x.png', 'image/jpeg'],
  ]) {
    const result = await check(name, type);
    expect(result.ok).toBeUndefined();
    expect(result.err.message).toMatch(/Only image files/);
  }
});
