const { EventEmitter } = require('events');
const db = require('../src/db');
const posts = require('../src/services/postService');
const engagement = require('../src/services/engagementService');
const { relay, middleware } = require('../src/realtime/notificationRelay');

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

const fakeIo = () => {
  const emit = jest.fn();
  return { emit, io: { to: jest.fn(() => ({ emit })) } };
};

test('relay pushes a new notification to the owner room only, once', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'hello');
  engagement.toggleLike(b.id, post);

  const { io, emit } = fakeIo();
  expect(relay(io)).toBe(1);
  expect(io.to).toHaveBeenCalledWith(`user:${a.id}`);
  expect(emit).toHaveBeenCalledWith(
    'notification:new',
    expect.objectContaining({
      type: 'like',
      href: `/posts/${post}`,
      unread: 1,
      text: expect.stringContaining('liked your post'),
    })
  );

  expect(relay(io)).toBe(0); // nothing is pushed twice
});

test('relay does nothing without a socket server', () => {
  expect(relay(undefined)).toBe(0);
});

test('middleware relays after a POST finishes but ignores GET requests', () => {
  const a = makeUser('alice');
  const b = makeUser('bob');
  const post = posts.createPost(a.id, 'hello again');
  const { io, emit } = fakeIo();
  const app = { get: () => io };

  const getRes = new EventEmitter();
  const next = jest.fn();
  middleware({ method: 'GET', app }, getRes, next);
  getRes.emit('finish');
  expect(next).toHaveBeenCalled();

  posts.reply(b.id, post, 'a reply');
  expect(emit).not.toHaveBeenCalled();

  const postRes = new EventEmitter();
  middleware({ method: 'POST', app }, postRes, jest.fn());
  postRes.emit('finish');
  expect(emit).toHaveBeenCalledWith('notification:new', expect.objectContaining({ type: 'reply' }));
});
