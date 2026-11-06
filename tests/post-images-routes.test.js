const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const safety = require('../src/services/safetyService');
const images = require('../src/services/postImageService');
const { PNG_1X1, GIF_1X1, makeJpeg, makePng, makeWebp } = require('./imageBuilders');
const { jpegOrientation } = require('../src/utils/imageFiles');

const DIR = images.POSTS_DIR;
const filesNow = () => fs.readdirSync(DIR).filter((name) => /^[0-9a-f]{32}\./.test(name));
const before = new Set(filesNow());
afterAll(() => filesNow().filter((name) => !before.has(name)).forEach((name) => fs.rmSync(path.join(DIR, name), { force: true })));

let counter = 0;
async function register() {
  counter += 1;
  const username = `pir_${counter}_u`;
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username,
      email: `${username}@example.com`,
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: username,
    })
    .expect(302);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return { id, username, agent };
}

const attach = (req, buffer, filename, contentType) => req.attach('images', buffer, { filename, contentType });
const postCount = () => db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
const lastPost = (authorId) => db.prepare('SELECT * FROM posts WHERE author_id = ? ORDER BY id DESC').get(authorId);
const rowsFor = (postId) => db.prepare('SELECT * FROM post_images WHERE post_id = ? ORDER BY position').all(postId);
const onDisk = (filename) => fs.existsSync(path.join(DIR, filename));
const png = (req) => attach(req, PNG_1X1, 'a.png', 'image/png');

describe('posting with pictures', () => {
  test('pictures and descriptions are saved, shown in the feed and served', async () => {
    const a = await register();
    const req = a.agent.post('/posts').field('body', 'look at these #photos').field('alt', 'A tiny red dot').field('alt', 'A tiny gif');
    attach(attach(req, PNG_1X1, 'dot.png', 'image/png'), GIF_1X1, 'anim.gif', 'image/gif');
    expect((await req.expect(302)).headers.location).toBe('/posts');

    const post = lastPost(a.id);
    const rows = rowsFor(post.id);
    expect(post.body).toBe('look at these #photos');
    expect(rows.map((r) => [r.position, r.mime, r.alt_text])).toEqual([
      [0, 'image/png', 'A tiny red dot'],
      [1, 'image/gif', 'A tiny gif'],
    ]);
    rows.forEach((row) => {
      expect(row.filename).toMatch(/^[0-9a-f]{32}\.(png|gif)$/);
      expect(onDisk(row.filename)).toBe(true);
    });

    const feed = (await a.agent.get('/posts').expect(200)).text;
    expect(feed).toContain(`src="/uploads/posts/${rows[0].filename}"`);
    expect(feed).toContain('alt="A tiny red dot"');
    expect(feed).toContain('post-images-2');

    const served = await request(app).get(`/uploads/posts/${rows[0].filename}`).expect(200);
    expect(served.headers['content-type']).toMatch(/image\/png/);

    const thread = (await a.agent.get(`/posts/${post.id}`).expect(200)).text;
    expect(thread).toContain(`/uploads/posts/${rows[1].filename}`);
  });

  test('descriptions are escaped', async () => {
    const a = await register();
    await png(a.agent.post('/posts').field('body', 'x').field('alt', '"><script>alert(1)</script>')).expect(302);
    const feed = (await a.agent.get('/posts').expect(200)).text;
    expect(feed).not.toContain('<script>alert(1)</script>');
    expect(feed).toContain('&lt;script&gt;');
  });

  test('pictures alone make a post, and plain text posts keep working', async () => {
    const a = await register();
    await png(a.agent.post('/posts')).expect(302);
    const onlyPicture = lastPost(a.id);
    expect(onlyPicture.body).toBe('');
    expect(rowsFor(onlyPicture.id)).toHaveLength(1);

    await a.agent.post('/posts').type('form').send({ body: 'just words' }).expect(302);
    const words = lastPost(a.id);
    expect(words.body).toBe('just words');
    expect(rowsFor(words.id)).toEqual([]);
  });

  test('an empty post, with or without the picture picker, is refused', async () => {
    const a = await register();
    const before = postCount();
    await a.agent.post('/posts').field('body', '   ').expect(302);
    await a.agent.post('/posts').type('form').send({ body: '' }).expect(302);
    expect(postCount()).toBe(before);
  });

  test('you must be logged in', async () => {
    const before = postCount();
    const res = await png(request(app).post('/posts').field('body', 'hello')).expect(302);
    expect(res.headers.location).toBe('/login');
    expect(postCount()).toBe(before);
  });

  test('cross-site uploads are refused', async () => {
    const a = await register();
    await png(a.agent.post('/posts').set('Sec-Fetch-Site', 'cross-site').field('body', 'x')).expect(403);
  });
});

describe('bad uploads leave nothing behind', () => {
  async function refused(build) {
    const a = await register();
    const posts = postCount();
    const files = filesNow().length;
    await build(a.agent).expect(302);
    expect(postCount()).toBe(posts);
    expect(filesNow().length).toBe(files);
  }

  test('more than four pictures', () =>
    refused((agent) => {
      const req = agent.post('/posts').field('body', 'too many');
      for (let i = 0; i < 5; i += 1) attach(req, PNG_1X1, `p${i}.png`, 'image/png');
      return req;
    }));

  test('a file that is not a picture, whatever it is called', () =>
    refused((agent) => attach(agent.post('/posts').field('body', 'x'), Buffer.from('not a picture at all'), 'fake.png', 'image/png')));

  test('a web page pretending to be a picture', () =>
    refused((agent) => attach(agent.post('/posts').field('body', 'x'), Buffer.from('<html><script>alert(1)</script></html>'), 'page.png', 'image/png')));

  test('a picture whose contents do not match its name', () =>
    refused((agent) => attach(agent.post('/posts').field('body', 'x'), PNG_1X1, 'wrong.jpg', 'image/jpeg')));

  test('an SVG', () =>
    refused((agent) => attach(agent.post('/posts').field('body', 'x'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg', 'image/svg+xml')));

  test('a picture over 5 MB', () =>
    refused((agent) => attach(agent.post('/posts').field('body', 'x'), Buffer.concat([PNG_1X1, Buffer.alloc(5 * 1024 * 1024)]), 'big.png', 'image/png')));

  test('one bad file among good ones takes the others with it', () =>
    refused((agent) => {
      const req = agent.post('/posts').field('body', 'mixed');
      attach(req, PNG_1X1, 'good.png', 'image/png');
      attach(req, Buffer.from('nope'), 'bad.png', 'image/png');
      return req;
    }));
});

describe('metadata', () => {
  test('location data is removed from the stored file, and the rotation flag is kept', async () => {
    const a = await register();
    await attach(a.agent.post('/posts').field('body', 'private photo'), makeJpeg({ orientation: 6, secret: 'GPS-SECRET-42' }), 'phone.jpg', 'image/jpeg').expect(302);

    const [row] = rowsFor(lastPost(a.id).id);
    const stored = fs.readFileSync(path.join(DIR, row.filename));
    expect(stored.includes(Buffer.from('GPS-SECRET-42'))).toBe(false);
    expect(stored.includes(Buffer.from('XMP-SECRET'))).toBe(false);
    expect(jpegOrientation(stored)).toBe(6);
    expect(row.size).toBe(stored.length);
  });

  test('PNG and WebP uploads are cleaned too', async () => {
    const a = await register();
    const req = a.agent.post('/posts').field('body', 'more photos');
    attach(attach(req, makePng({ secret: 'PNG-SECRET-42' }), 'a.png', 'image/png'), makeWebp({ secret: 'WEBP-SECRET' }), 'b.webp', 'image/webp');
    await req.expect(302);

    rowsFor(lastPost(a.id).id).forEach((row) => {
      const stored = fs.readFileSync(path.join(DIR, row.filename));
      expect(stored.includes(Buffer.from('PNG-SECRET-42'))).toBe(false);
      expect(stored.includes(Buffer.from('WEBP-SECRET'))).toBe(false);
    });
  });
});

describe('replies', () => {
  test('a reply can have pictures and goes back to the thread', async () => {
    const a = await register();
    const b = await register();
    await a.agent.post('/posts').type('form').send({ body: 'root post' }).expect(302);
    const root = lastPost(a.id);

    const res = await png(b.agent.post(`/posts/${root.id}/reply`).field('body', 'nice, here is mine')).expect(302);
    expect(res.headers.location).toBe(`/posts/${root.id}`);

    const reply = lastPost(b.id);
    expect(reply.parent_id).toBe(root.id);
    expect(rowsFor(reply.id)).toHaveLength(1);
    const thread = (await a.agent.get(`/posts/${root.id}`).expect(200)).text;
    expect(thread).toContain(`/uploads/posts/${rowsFor(reply.id)[0].filename}`);
  });

  test('a blocked person cannot reply with pictures, and their files are removed', async () => {
    const a = await register();
    const b = await register();
    await a.agent.post('/posts').type('form').send({ body: 'root post' }).expect(302);
    const root = lastPost(a.id);
    await a.agent.post(`/safety/block/${b.id}`).expect(302);
    const posts = postCount();
    const files = filesNow().length;

    await png(b.agent.post(`/posts/${root.id}/reply`).field('body', 'let me in')).expect(302);
    expect(postCount()).toBe(posts);
    expect(filesNow().length).toBe(files);
  });

  test('replying to a post that does not exist is refused', async () => {
    const a = await register();
    const posts = postCount();
    const files = filesNow().length;
    await png(a.agent.post('/posts/999999/reply').field('body', 'hello?')).expect(302);
    expect(postCount()).toBe(posts);
    expect(filesNow().length).toBe(files);
  });
});

describe('deleting', () => {
  test('the author deleting a post removes its pictures and those of its replies at once', async () => {
    const a = await register();
    const b = await register();
    await png(a.agent.post('/posts').field('body', 'will be deleted')).expect(302);
    const root = lastPost(a.id);
    await png(b.agent.post(`/posts/${root.id}/reply`).field('body', 'reply with picture')).expect(302);
    await png(a.agent.post('/posts').field('body', 'stays')).expect(302);
    const keep = lastPost(a.id);

    const gone = [...rowsFor(root.id), ...rowsFor(lastPost(b.id).id)].map((row) => row.filename);
    const kept = rowsFor(keep.id)[0].filename;
    gone.forEach((name) => expect(onDisk(name)).toBe(true));

    await a.agent.post(`/posts/${root.id}/delete`).expect(302);

    gone.forEach((name) => expect(onDisk(name)).toBe(false));
    expect(onDisk(kept)).toBe(true);
    expect(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(root.id)).toBeUndefined();
    expect(rowsFor(keep.id)).toHaveLength(1);
  });

  test('other people cannot delete your post or its pictures', async () => {
    const a = await register();
    const b = await register();
    await png(a.agent.post('/posts').field('body', 'mine')).expect(302);
    const post = lastPost(a.id);
    const filename = rowsFor(post.id)[0].filename;

    await b.agent.post(`/posts/${post.id}/delete`).expect(302);

    expect(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(post.id)).toBeDefined();
    expect(onDisk(filename)).toBe(true);
  });

  test('pictures of posts removed another way are swept up later', async () => {
    const a = await register();
    await png(a.agent.post('/posts').field('body', 'removed by a moderator')).expect(302);
    const post = lastPost(a.id);
    const filename = rowsFor(post.id)[0].filename;

    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    expect(onDisk(filename)).toBe(true);

    const { removed } = require('../src/services/uploadSweep').sweepOnce(db, { minAgeHours: 0 });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(onDisk(filename)).toBe(false);
  });
});

describe('everywhere a post card appears', () => {
  test('search results and bookmarks show the pictures too', async () => {
    const a = await register();
    await png(a.agent.post('/posts').field('body', 'zeppelinsearchword here')).expect(302);
    const post = lastPost(a.id);
    const filename = rowsFor(post.id)[0].filename;

    const found = (await a.agent.get('/search').query({ q: 'zeppelinsearchword', type: 'posts' }).expect(200)).text;
    expect(found).toContain(`/uploads/posts/${filename}`);

    await a.agent.post(`/posts/${post.id}/bookmark`).expect(302);
    expect((await a.agent.get('/bookmarks').expect(200)).text).toContain(`/uploads/posts/${filename}`);
  });

  test('a post without pictures shows no gallery', async () => {
    const a = await register();
    await a.agent.post('/posts').type('form').send({ body: 'only words here, nothing else' }).expect(302);
    const feed = (await a.agent.get('/posts').expect(200)).text;
    const card = feed.split('<article class="post">').find((part) => part.includes('only words here, nothing else'));
    expect(card).toBeDefined();
    expect(card.split('</article>')[0]).not.toContain('post-images');
  });

  test('a blocked person is still hidden, pictures and all', async () => {
    const a = await register();
    const b = await register();
    await png(b.agent.post('/posts').field('body', 'blockedauthorpost')).expect(302);
    const filename = rowsFor(lastPost(b.id).id)[0].filename;
    await a.agent.post(`/safety/block/${b.id}`).expect(302);

    const feed = (await a.agent.get('/posts').expect(200)).text;
    expect(feed).not.toContain(filename);
  });
});

describe('the forms', () => {
  test('the post and reply forms offer the picture picker', async () => {
    const a = await register();
    const feed = (await a.agent.get('/posts').expect(200)).text;
    expect(feed).toContain('action="/posts" enctype="multipart/form-data"');
    expect(feed).toContain('name="images"');
    expect(feed.match(/name="alt"/g)).toHaveLength(4);

    await a.agent.post('/posts').type('form').send({ body: 'a post to reply to' }).expect(302);
    const thread = (await a.agent.get(`/posts/${lastPost(a.id).id}`).expect(200)).text;
    expect(thread).toMatch(/action="\/posts\/\d+\/reply" enctype="multipart\/form-data"/);
    expect(thread).toContain('name="images"');
  });
});

test('the data export lists the pictures of your own posts only', async () => {
  const exportService = require('../src/services/exportService');
  const a = await register();
  const b = await register();
  await png(a.agent.post('/posts').field('body', 'mine').field('alt', 'my picture')).expect(302);
  await png(b.agent.post('/posts').field('body', 'theirs')).expect(302);
  const mine = rowsFor(lastPost(a.id).id)[0];
  const theirs = rowsFor(lastPost(b.id).id)[0];

  const data = exportService.buildExport(a.id);
  expect(data.post_images).toEqual([
    { post_id: mine.post_id, position: 0, image_url: `/uploads/posts/${mine.filename}`, alt_text: 'my picture' },
  ]);
  expect(JSON.stringify(data)).not.toContain(theirs.filename);
});
