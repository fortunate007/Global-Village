// Disconnects every live chat connection of one account except those from the session that is staying
// logged in. Returns how many were closed. Safe to call without a socket server.
function disconnectOtherSockets(io, userId, keepSessionId) {
  if (!io || typeof io.of !== 'function') return 0;
  let closed = 0;
  for (const socket of io.of('/').sockets.values()) {
    if (socket.userId !== String(userId)) continue;
    if (socket.request && socket.request.sessionID === keepSessionId) continue;
    socket.disconnect(true);
    closed += 1;
  }
  return closed;
}

module.exports = { disconnectOtherSockets };
