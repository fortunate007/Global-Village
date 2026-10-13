const db = require('../src/db');
const follows = require('../src/services/followService');
const notifications = require('../src/services/notificationService');
const safety = require('../src/services/safetyService');

const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
let counter = 0;
const makeUser = (label) => {
  counter += 1;
  const name = `f${label}${stamp}${counter}`;
  return Number(
    db
      .prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(name, `${name}@example.com`, 'x', `User ${label}`).lastInsertRowid
  );
};
const notesFor = (userId) => notifications.list(userId);

describe('follows', () => {
  test('following creates a follow and notifies the followed user', () => {
    const a = makeUser('a');
    const b = makeUser('b');
    expect(follows.follow(a, b).changed).toBe(true);
    expect(follows.isFollowing(a, b)).toBe(true);
    expect(follows.isFollowing(b, a)).toBe(false);

    const note = notesFor(b).find((n) => n.type === 'follow' && n.username.startsWith('fa'));
    expect(note).toBeTruthy();
    expect(note.verb).toBe('started following you');
    expect(note.href).toBe(`/profile/${a}`);

    expect(follows.follow(a, b).changed).toBe(false);
    expect(follows.counts(b, a).followers).toBe(1);
    expect(follows.counts(a, a).following).toBe(1);
  });

  test('following back sends a follow_back notification', () => {
    const a = makeUser('a');
    const b = makeUser('b');
    follows.follow(a, b);
    follows.follow(b, a);
    const note = notesFor(a).find((n) => n.type === 'follow_back');
    expect(note).toBeTruthy();
    expect(note.verb).toBe('followed you back');
    const state = follows.profileState(a, b);
    expect(state.iFollow).toBe(true);
    expect(state.followsMe).toBe(true);
  });

  test('unfollowing removes the follow and its notification', () => {
    const a = makeUser('a');
    const b = makeUser('b');
    follows.follow(a, b);
    expect(follows.unfollow(a, b).changed).toBe(true);
    expect(follows.isFollowing(a, b)).toBe(false);
    expect(notesFor(b).some((n) => n.type === 'follow')).toBe(false);
  });

  test('you cannot follow yourself or someone who does not exist', () => {
    const a = makeUser('a');
    expect(() => follows.follow(a, a)).toThrow(follows.FollowError);
    expect(() => follows.follow(a, 987654321)).toThrow(follows.FollowError);
    expect(() => follows.follow(a, 'abc')).toThrow(follows.FollowError);
  });

  test('blocking removes follows both ways and prevents new ones', () => {
    const a = makeUser('a');
    const b = makeUser('b');
    follows.follow(a, b);
    follows.follow(b, a);
    safety.block(a, b);
    expect(follows.isFollowing(a, b)).toBe(false);
    expect(follows.isFollowing(b, a)).toBe(false);
    expect(() => follows.follow(b, a)).toThrow(follows.FollowError);
  });

  test('lists show followers and following with follow-back state', () => {
    const a = makeUser('a');
    const b = makeUser('b');
    const c = makeUser('c');
    follows.follow(b, a);
    follows.follow(c, a);
    follows.follow(a, b);
    const followers = follows.list('followers', a, a);
    expect(followers.map((u) => u.id).sort()).toEqual([b, c].sort());
    expect(followers.find((u) => u.id === b).i_follow).toBe(1);
    expect(followers.find((u) => u.id === c).i_follow).toBe(0);
    expect(follows.list('following', a, a).map((u) => u.id)).toEqual([b]);
  });
});
