const db = require('../src/db');
const posts = require('../src/services/postService');
const profiles = require('../src/services/profileService');

let counter = 0;
function makeUser(name) {
  counter += 1;
  const username = `${name}_${counter}_ps`;
  const id = Number(
    db
      .prepare(
        'INSERT INTO users (username, email, password_hash, display_name, bio, status_message) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(username, `${username}@example.com`, 'HASH-X', name, 'my bio', 'my status').lastInsertRowid
  );
  return { id, username };
}

const ids = (rows) => rows.map((r) => r.id);
const repostIdOf = (authorId, postId) =>
  db.prepare('SELECT id FROM posts WHERE author_id = ? AND repost_of_id = ?').get(authorId, postId).id;

describe('finding a profile', () => {
  test('matches any letter case and returns only public columns', () => {
    const a = makeUser('alice');
    const found = profiles.findByUsername(a.username.toUpperCase());

    expect(found).toMatchObject({ id: a.id, username: a.username, display_name: 'alice', bio: 'my bio' });
    expect(Object.keys(found).sort()).toEqual(
      ['avatar_url', 'bio', 'created_at', 'display_name', 'id', 'status_message', 'username']
    );
    expect(JSON.stringify(found)).not.toContain('HASH-X');
    expect(JSON.stringify(found)).not.toContain('@example.com');
  });

  test('anything that is not a valid username finds nothing', () => {
    makeUser('alice');
    ['', 'ab', 'a'.repeat(21), 'bad-name', 'with space', "x' OR '1'='1", 'nobody_here', undefined, null, 5, ['alice_1_ps']].forEach(
      (value) => expect(profiles.findByUsername(value)).toBeNull()
    );
  });
});

describe('a person\'s posts', () => {
  test('the posts tab holds posts, quotes and reposts, and the replies tab holds replies', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const bobPost = posts.createPost(b.id, 'bob post');
    const aliceRoot = posts.createPost(a.id, 'alice root');
    const reply = posts.reply(a.id, bobPost, 'alice reply');
    const quote = posts.quote(a.id, bobPost, 'alice quote');
    posts.toggleRepost(a.id, bobPost);
    const repost = repostIdOf(a.id, bobPost);

    const main = profiles.postsByAuthor(a.id);
    expect(ids(main.rows)).toEqual([repost, quote, aliceRoot]);
    expect(main.rows[0].original.id).toBe(bobPost);
    expect(main.rows[1].quoted.id).toBe(bobPost);
    expect(main.hasMore).toBe(false);

    const replies = profiles.postsByAuthor(a.id, { kind: 'replies' });
    expect(ids(replies.rows)).toEqual([reply]);

    expect(ids(profiles.postsByAuthor(a.id, { kind: 'whatever' }).rows)).toEqual([repost, quote, aliceRoot]);
    expect(profiles.postsByAuthor(makeUser('carol').id)).toEqual({ rows: [], hasMore: false, lastId: null });
  });

  test('pages of 20 follow each other without gaps or repeats', () => {
    const a = makeUser('alice');
    const created = [];
    for (let i = 0; i < 25; i += 1) created.push(posts.createPost(a.id, `page item ${i}`));
    const newestFirst = [...created].reverse();

    const first = profiles.postsByAuthor(a.id);
    expect(first.rows).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.lastId).toBe(newestFirst[19]);

    const second = profiles.postsByAuthor(a.id, { before: first.lastId });
    expect(second.rows).toHaveLength(5);
    expect(second.hasMore).toBe(false);
    expect([...ids(first.rows), ...ids(second.rows)]).toEqual(newestFirst);
  });

  test('a cursor that is not a positive whole number is ignored', () => {
    const a = makeUser('alice');
    const id = posts.createPost(a.id, 'only post');
    [0, -1, 1.5, null, 'x', undefined, NaN].forEach((before) => {
      expect(ids(profiles.postsByAuthor(a.id, { before }).rows)).toEqual([id]);
    });
    expect(profiles.postsByAuthor(a.id, { before: id }).rows).toEqual([]);
  });

  test('the post count includes only a person\'s own top-level posts', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const bobPost = posts.createPost(b.id, 'bob post');
    posts.createPost(a.id, 'one');
    posts.createPost(a.id, 'two');
    posts.reply(a.id, bobPost, 'a reply');
    posts.toggleRepost(a.id, bobPost);

    expect(profiles.postCount(a.id)).toBe(2);
    expect(profiles.postCount(makeUser('carol').id)).toBe(0);
  });
});

describe('how the viewer stands with a person', () => {
  test('tracks requests in both directions, friendship and muting', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const none = { isFriend: false, requestSent: false, requestReceived: false, isMuted: false };
    expect(profiles.relationship(a.id, b.id)).toEqual(none);

    db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(a.id, b.id);
    expect(profiles.relationship(a.id, b.id)).toMatchObject({ requestSent: true, requestReceived: false });
    expect(profiles.relationship(b.id, a.id)).toMatchObject({ requestSent: false, requestReceived: true });
    db.prepare('DELETE FROM friend_requests WHERE sender_id = ?').run(a.id);

    const addFriend = db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)');
    addFriend.run(a.id, b.id);
    addFriend.run(b.id, a.id);
    expect(profiles.relationship(a.id, b.id)).toMatchObject({ isFriend: true, requestSent: false });
    expect(profiles.relationship(b.id, a.id)).toMatchObject({ isFriend: true });

    db.prepare('INSERT INTO mutes (muter_id, muted_id) VALUES (?, ?)').run(a.id, b.id);
    expect(profiles.relationship(a.id, b.id).isMuted).toBe(true);
    expect(profiles.relationship(b.id, a.id).isMuted).toBe(false);
  });
});
