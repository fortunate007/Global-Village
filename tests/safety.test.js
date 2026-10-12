const db = require('../src/db');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');
const notifications = require('../src/services/notificationService');
const safety = require('../src/services/safetyService');

let counter = 0;
const makeUser = (name) => {
  counter += 1;
  const username = `${name}${counter}`;
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(username, `${username}@example.com`, 'x', name).lastInsertRowid
  );
  return { id, username };
};

const isBlocked = (fn) => {
  try {
    fn();
  } catch (err) {
    return safety.isBlockError(err);
  }
  return false;
};

const row = (postId) => posts.getThread(postId).post;

describe('block and mute', () => {
  test('block and unblock, with validation', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    safety.block(a.id, b.id);
    expect(safety.listBlocked(a.id).map((u) => u.id)).toEqual([b.id]);
    expect(() => safety.block(a.id, a.id)).toThrow(safety.SafetyError);
    expect(() => safety.block(a.id, 999999)).toThrow(safety.SafetyError);
    safety.unblock(a.id, b.id);
    expect(safety.listBlocked(a.id)).toEqual([]);
  });

  test('mute and unmute', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    safety.mute(a.id, b.id);
    expect(safety.listMuted(a.id).map((u) => u.id)).toEqual([b.id]);
    safety.unmute(a.id, b.id);
    expect(safety.listMuted(a.id)).toEqual([]);
  });

  test('blocking removes friendships and pending requests without generating notifications', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const c = makeUser('carol');
    const addFriend = db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)');
    addFriend.run(a.id, b.id);
    addFriend.run(b.id, a.id);
    db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)').run(c.id, a.id);

    safety.block(a.id, b.id);
    safety.block(a.id, c.id);

    expect(db.prepare('SELECT COUNT(*) AS n FROM friends WHERE user_id IN (?, ?)').get(a.id, b.id).n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE recipient_id = ?').get(a.id).n).toBe(0);
    expect(notifications.list(a.id)).toEqual([]);
    expect(notifications.list(b.id)).toEqual([]);
  });

  test('blocked people cannot reply, quote, repost or like, in either direction', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const c = makeUser('carol');
    const pa = posts.createPost(a.id, 'from alice');
    const pb = posts.createPost(b.id, 'from bob');
    safety.block(a.id, b.id);

    expect(isBlocked(() => posts.reply(b.id, pa, 'hi'))).toBe(true);
    expect(isBlocked(() => posts.quote(b.id, pa, 'hi'))).toBe(true);
    expect(isBlocked(() => posts.toggleRepost(b.id, pa))).toBe(true);
    expect(isBlocked(() => engagement.toggleLike(b.id, pa))).toBe(true);
    expect(isBlocked(() => posts.reply(a.id, pb, 'hi'))).toBe(true);
    expect(isBlocked(() => engagement.toggleLike(a.id, pb))).toBe(true);

    expect(() => posts.reply(c.id, pa, 'fine')).not.toThrow();

    safety.unblock(a.id, b.id);
    expect(() => posts.reply(b.id, pa, 'allowed again')).not.toThrow();
  });

  test('friend requests between blocked people are silently ignored', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    safety.block(a.id, b.id);
    const insert = db.prepare('INSERT INTO friend_requests (sender_id, recipient_id) VALUES (?, ?)');
    expect(insert.run(b.id, a.id).changes).toBe(0);
    expect(insert.run(a.id, b.id).changes).toBe(0);
    expect(notifications.list(a.id)).toEqual([]);
  });
});

describe('visibility filters', () => {
  test('muted, blocked and blocking users are hidden; logged-out visitors see everything', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const c = makeUser('carol');
    const d = makeUser('dave');
    const rows = [b, c, d].map((u) => row(posts.createPost(u.id, `post by ${u.username}`)));

    safety.mute(a.id, b.id);
    safety.block(c.id, a.id); // carol blocked alice

    const visible = safety.filterPosts(a.id, rows).map((r) => r.author_id);
    expect(visible).toEqual([d.id]);
    expect(safety.filterPosts(null, rows)).toHaveLength(3);
  });

  test('reposts of hidden authors are hidden, and hidden quoted posts are removed from quotes', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const c = makeUser('carol');
    const original = posts.createPost(b.id, 'bob original');
    posts.toggleRepost(c.id, original);
    const repostRow = posts.feed(500).find((r) => r.repost_of_id === original && r.author_id === c.id);
    const quoteRow = row(posts.quote(c.id, original, 'my take'));

    safety.mute(a.id, b.id);
    expect(safety.filterPosts(a.id, [repostRow])).toEqual([]);

    const [kept] = safety.filterPosts(a.id, [quoteRow]);
    expect(kept.id).toBe(quoteRow.id);
    expect(kept.quoted).toBeNull();
  });

  test('threads: blocked either way is not found, muted authors lose their replies', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const c = makeUser('carol');
    const root = posts.createPost(b.id, 'bob root');
    posts.reply(c.id, root, 'carol reply');

    safety.mute(a.id, c.id);
    const thread = safety.filterThread(a.id, posts.getThread(root));
    expect(thread.post.id).toBe(root);
    expect(thread.replies).toEqual([]);

    safety.block(a.id, b.id);
    expect(safety.filterThread(a.id, posts.getThread(root))).toBeNull();
    expect(safety.filterThread(b.id, posts.getThread(posts.createPost(a.id, 'alice post')))).toBeNull();
  });

  test('people results exclude hidden accounts', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const c = makeUser('carol');
    safety.block(a.id, b.id);
    const people = [{ id: b.id }, { id: c.id }];
    expect(safety.filterPeople(a.id, people).map((u) => u.id)).toEqual([c.id]);
  });

  test('notifications from muted or blocked people are hidden, uncounted and not pushed', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const post = posts.createPost(a.id, 'hello');
    engagement.toggleLike(b.id, post);
    expect(notifications.unreadCount(a.id)).toBe(1);

    safety.mute(a.id, b.id);
    expect(notifications.unreadCount(a.id)).toBe(0);
    expect(notifications.list(a.id)).toEqual([]);
    expect(notifications.listAfter(0).some((n) => n.user_id === a.id)).toBe(false);

    safety.unmute(a.id, b.id);
    expect(notifications.unreadCount(a.id)).toBe(1);
  });
});

describe('reports and admin', () => {
  test('reporting creates one open report per reporter and post', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const post = posts.createPost(b.id, 'bad stuff');

    expect(safety.report(a.id, post, 'spam', '  twice a day  ')).toEqual({ created: true });
    expect(safety.report(a.id, post, 'spam', 'again')).toEqual({ created: false });

    const [report] = safety.openReports().filter((r) => r.post_id === post);
    expect(report).toMatchObject({
      reason: 'spam',
      details: 'twice a day',
      post_body: 'bad stuff',
      reporter_username: a.username,
      author_username: b.username,
    });
  });

  test('reports validate reason, post and ownership', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const post = posts.createPost(b.id, 'something');
    expect(() => safety.report(a.id, post, 'nonsense', '')).toThrow(safety.SafetyError);
    expect(() => safety.report(a.id, 999999, 'spam', '')).toThrow(safety.SafetyError);
    expect(() => safety.report(b.id, post, 'spam', '')).toThrow(safety.SafetyError);
  });

  test('reporting a repost reports the original post', () => {
    const a = makeUser('alice');
    const b = makeUser('bob');
    const c = makeUser('carol');
    const original = posts.createPost(b.id, 'original text');
    posts.toggleRepost(c.id, original);
    const repostId = posts.feed(500).find((r) => r.repost_of_id === original && r.author_id === c.id).id;

    safety.report(a.id, repostId, 'abuse', '');
    expect(db.prepare('SELECT post_id FROM reports WHERE reporter_id = ?').get(a.id).post_id).toBe(original);
  });

  test('admins can dismiss or resolve a report once', () => {
    const admin = makeUser('admin');
    const a = makeUser('alice');
    const b = makeUser('bob');
    expect(safety.isAdmin(admin.id)).toBe(false);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
    expect(safety.isAdmin(admin.id)).toBe(true);

    const post = posts.createPost(b.id, 'meh');
    safety.report(a.id, post, 'other', '');
    const id = safety.openReports().find((r) => r.post_id === post).id;

    safety.resolveReport(admin.id, id, 'dismissed');
    expect(safety.openReports().some((r) => r.id === id)).toBe(false);
    expect(() => safety.resolveReport(admin.id, id, 'dismissed')).toThrow(safety.SafetyError);
    expect(() => safety.resolveReport(admin.id, id, 'bogus')).toThrow(safety.SafetyError);
  });

  test('removing a reported post deletes it, resolves every report about it and keeps the snapshot', () => {
    const admin = makeUser('admin');
    const a = makeUser('alice');
    const c = makeUser('carol');
    const b = makeUser('bob');
    const post = posts.createPost(b.id, 'remove me');
    safety.report(a.id, post, 'abuse', '');
    safety.report(c.id, post, 'spam', '');
    const id = safety.openReports().find((r) => r.post_id === post).id;

    safety.removeReportedPost(admin.id, id);

    expect(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(post)).toBeUndefined();
    const rows = db.prepare('SELECT status, post_id, post_body, resolved_by FROM reports WHERE reporter_id IN (?, ?)').all(a.id, c.id);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => expect(r).toMatchObject({ status: 'resolved', post_id: null, post_body: 'remove me', resolved_by: admin.id }));
  });
});
