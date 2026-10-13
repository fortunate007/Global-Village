const { disconnectOtherSockets } = require('../src/realtime/sessions');

const fakeSocket = (userId, sessionID) => ({ userId, request: { sessionID }, disconnect: jest.fn() });
const fakeIo = (...sockets) => ({ of: () => ({ sockets: new Map(sockets.map((s, i) => [String(i), s])) }) });

test('closes every connection of the account except the one that stays logged in', () => {
  const keep = fakeSocket('5', 'keep-me');
  const phone = fakeSocket('5', 'phone');
  const laptop = fakeSocket('5', 'laptop');
  const someoneElse = fakeSocket('6', 'phone');

  expect(disconnectOtherSockets(fakeIo(keep, phone, laptop, someoneElse), 5, 'keep-me')).toBe(2);
  expect(phone.disconnect).toHaveBeenCalledWith(true);
  expect(laptop.disconnect).toHaveBeenCalledWith(true);
  expect(keep.disconnect).not.toHaveBeenCalled();
  expect(someoneElse.disconnect).not.toHaveBeenCalled();
});

test('is safe without a socket server', () => {
  expect(disconnectOtherSockets(undefined, 5, 'x')).toBe(0);
  expect(disconnectOtherSockets({}, 5, 'x')).toBe(0);
});
