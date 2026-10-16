const request = require('supertest');
const db = require('../src/db');
const app = require('../src/app');
const posts = require('../src/services/postService');
const { PROFILE_PATH } = require('../src/utils/linkify');

let counter = 0;
async function makeAccount(name) {
  counter += 1;
  const username = `${name}_${counter}_pr`;
  const agent = request.agent(app);
  await agent
    .post('/register')
    .type('form')
    .send({
      username,
      email: `${username}@example.com`,
      password: 'secret123',
      confirmPassword: 'secret123',
      displayName: name,
    })
    .expect(302);
  const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  return { id, username, email: `${username}@example.com`, agent };
}

const visit = (username, query = '') => request(app).get(`/users/${username}${query}`);
// The page header has an account menu that also says "Edit profile", so these checks look at the profile block only
const profileSection = (html) => { const m = html.match(/<section class="profile-header">[\s\S]*?<\/section>/); return m ? m[0] : ''; };
const articles = (html) => (html.match(/<article class="post">/g) || []).length;

test('mention and search links point at the profile route', () => {
  expect(PROFILE_PATH).toBe('/users/');
});

describe('who can see what', () => {
  test('a visitor who is not logged in sees the name and posts, but not the bio, status or email', async () => {
    const a = await makeAccount('alice');
    db.prepare('UPDATE users SET bio = ?, status_message = ? WHERE id = ?').run('private bio text', 'private status text', a.id);
    posts.createPost(a.id, 'hello from the profile page');

    const page = (await visit(a.username).expect(200)).text;
    expect(page).toContain('alice');
    expect(page).toContain(`@${a.username}`);
    expect(page).toContain('hello from the profile page');
    expect(page).not.toContain('private bio text');
    expect(page).not.toContain('private status text');
    expect(page).not.toContain(a.email);
    expect(page).toContain('/login');
  });

  test('a logged-in person also sees the bio and status', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    db.prepare('UPDATE users SET bio = ?, status_message = ? WHERE id = ?').run('private bio text', 'private status text', a.id);

    const page = (await b.agent.get(`/users/${a.username}`).expect(200)).text;
    expect(page).toContain('private bio text');
    expect(page).toContain('private status text');
    expect(page).not.toContain(a.email);
  });

  test('unknown and invalid names give the not-found page', async () => {
    await visit('nobody_at_all_1').expect(404);
    for (const bad of ['ab', 'bad-name', 'x'.repeat(21), 'with%20space', 'online']) {
      await visit(bad).expect(404);
    }
  });

  test('profile text is escaped', async () => {
    const a = await makeAccount('alice');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run('<script>alert(1)</script>', a.id);

    const page = (await visit(a.username).expect(200)).text;
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>alert(1)</script>');
  });
});

describe('addresses', () => {
  test('another letter case redirects to the proper address and keeps the query', async () => {
    const a = await makeAccount('alice');
    const res = await visit(a.username.toUpperCase(), '?tab=replies&before=7').expect(302);
    expect(res.headers.location).toBe(`/users/${a.username}?tab=replies&before=7`);

    const plain = await visit(a.username.toUpperCase()).expect(302);
    expect(plain.headers.location).toBe(`/users/${a.username}`);
  });

  test('odd query values fall back to the first page of posts', async () => {
    const a = await makeAccount('alice');
    posts.createPost(a.id, 'still shown despite odd queries');

    for (const query of ['?before=abc&tab=weird', '?before=1&before=2', '?tab[]=replies', '?before=-5']) {
      const page = (await visit(a.username, query).expect(200)).text;
      expect(page).toContain('still shown despite odd queries');
    }
  });

  test('profiles are linked from mentions and from search results', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    posts.createPost(a.id, `hello @${b.username}`);

    const feed = (await request(app).get('/posts').expect(200)).text;
    expect(feed).toContain(`href="/users/${b.username}"`);
    await visit(b.username).expect(200);

    const results = (await request(app).get('/search').query({ q: b.username, type: 'people' }).expect(200)).text;
    expect(results).toContain(`/users/${b.username}`);
  });

  test('older pages of the people list and profile routes still work', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    await a.agent.get('/users').expect(200);
    await a.agent.get(`/profile/${b.id}`).expect(200);
    await a.agent.get('/profile').expect(200);
  });
});

describe('posts and tabs', () => {
  test('the posts tab shows posts and reposts, and the replies tab shows replies', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    const bobPost = posts.createPost(b.id, 'bob original words');
    posts.createPost(a.id, 'alice main post');
    posts.reply(a.id, bobPost, 'alice reply words');
    posts.toggleRepost(a.id, bobPost);

    const main = (await visit(a.username).expect(200)).text;
    expect(main).toContain('alice main post');
    expect(main).toContain('bob original words');
    expect(main).toContain('reposted');
    expect(main).not.toContain('alice reply words');

    const replies = (await visit(a.username, '?tab=replies').expect(200)).text;
    expect(replies).toContain('alice reply words');
    expect(replies).not.toContain('alice main post');
  });

  test('long histories are split into pages of 20 with an "Older" link', async () => {
    const a = await makeAccount('alice');
    for (let i = 0; i < 25; i += 1) posts.createPost(a.id, `pagepost-${String(i).padStart(3, '0')}`);

    const first = (await visit(a.username).expect(200)).text;
    expect(articles(first)).toBe(20);
    expect(first).toContain('pagepost-024');
    expect(first).not.toContain('pagepost-004');

    const cursor = first.match(/tab=posts&before=(\d+)/)[1];
    const second = (await visit(a.username, `?tab=posts&before=${cursor}`).expect(200)).text;
    expect(articles(second)).toBe(5);
    expect(second).toContain('pagepost-004');
    expect(second).toContain('pagepost-000');
    expect(second).not.toContain('pagepost-024');
    expect(second).not.toContain('before=');
  });

  test('a profile without posts says so', async () => {
    const a = await makeAccount('alice');
    expect((await visit(a.username).expect(200)).text).toContain('No posts to show.');
    expect((await visit(a.username, '?tab=replies').expect(200)).text).toContain('No replies to show.');
  });
});

describe('blocking and muting', () => {
  test('blocked either way looks exactly like a missing account, and others are unaffected', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    const c = await makeAccount('carol');
    await a.agent.post(`/safety/block/${b.id}`).expect(302);

    await a.agent.get(`/users/${b.username}`).expect(404);
    await b.agent.get(`/users/${a.username}`).expect(404);
    await c.agent.get(`/users/${a.username}`).expect(200);
    await visit(a.username).expect(200);
  });

  test('a muted profile explains itself, offers Unmute and hides the posts', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    posts.createPost(a.id, 'words you should not see');
    await b.agent.post(`/safety/mute/${a.id}`).expect(302);

    const page = (await b.agent.get(`/users/${a.username}`).expect(200)).text;
    expect(page).toContain('You muted');
    expect(page).toContain(`/safety/unmute/${a.id}`);
    expect(page).not.toContain('words you should not see');

    const other = await makeAccount('carol');
    expect((await other.agent.get(`/users/${a.username}`).expect(200)).text).toContain('words you should not see');
  });

  test('posts by people the viewer has hidden do not show up inside someone else\'s reposts', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    const c = await makeAccount('carol');
    const original = posts.createPost(b.id, 'bob words hidden from carol');
    posts.toggleRepost(a.id, original);
    await c.agent.post(`/safety/mute/${b.id}`).expect(302);

    const page = (await c.agent.get(`/users/${a.username}`).expect(200)).text;
    expect(page).not.toContain('bob words hidden from carol');
  });
});

describe('buttons', () => {
  test('your own page offers editing and no actions against yourself', async () => {
    const a = await makeAccount('alice');
    const page = (await a.agent.get(`/users/${a.username}`).expect(200)).text;

    expect(profileSection(page)).toContain('Edit profile');
    expect(page).not.toContain(`/safety/block/${a.id}`);
    expect(page).not.toContain(`/friends/request/${a.id}`);
    expect(page).not.toContain(`/messages/${a.id}`);
  });

  test('another person\'s page offers message, friend, mute and block', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    const page = (await b.agent.get(`/users/${a.username}`).expect(200)).text;

    expect(page).toContain(`/messages/${a.id}`);
    expect(page).toContain(`/friends/request/${a.id}`);
    expect(page).toContain(`/safety/mute/${a.id}`);
    expect(page).toContain(`/safety/block/${a.id}`);
    expect(profileSection(page)).not.toContain('Edit profile');
  });

  test('the friend button follows the current state', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    const view = async () => (await b.agent.get(`/users/${a.username}`).expect(200)).text;

    db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(b.id, a.id);
    let page = await view();
    expect(page).toContain('Friend request sent');
    expect(page).not.toContain(`/friends/request/${a.id}`);
    db.prepare('DELETE FROM friend_requests WHERE sender_id = ?').run(b.id);

    db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(a.id, b.id);
    page = await view();
    expect(page).toContain('href="/friends/requests"');
    expect(page).not.toContain(`/friends/request/${a.id}`);
    db.prepare('DELETE FROM friend_requests WHERE sender_id = ?').run(a.id);

    const addFriend = db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)');
    addFriend.run(a.id, b.id);
    addFriend.run(b.id, a.id);
    page = await view();
    expect(page).toContain(`/users/${a.id}/unfriend`);
    expect(page).not.toContain(`/friends/request/${a.id}`);
  });

  test('the add-friend button really starts a friend request', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    await b.agent.post(`/friends/request/${a.id}`).expect(302);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE sender_id = ? AND recipient_id = ?').get(b.id, a.id).n
    ).toBe(1);
    expect((await b.agent.get(`/users/${a.username}`).expect(200)).text).toContain('Friend request sent');
  });
});

describe('post cards', () => {
  test('author names link to their profile, in the feed and in quotes', async () => {
    const a = await makeAccount('alice');
    const b = await makeAccount('bob');
    const original = posts.createPost(a.id, 'a post that gets quoted');
    posts.quote(b.id, original, 'my take');

    const feed = (await request(app).get('/posts').expect(200)).text;
    expect(feed).toContain(`href="/users/${a.username}"`);
    expect(feed).toContain(`href="/users/${b.username}"`);
  });
});
