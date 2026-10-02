'use strict';

const { Server } = require('socket.io');

/**
 * Create and configure the Socket.IO server.
 *
 * @param {import('http').Server} httpServer
 * @param {import('express').RequestHandler} sessionMiddleware
 * @param {object} [options]
 * @returns {import('socket.io').Server}
 */
function createSocketServer(httpServer, sessionMiddleware, options = {}) {
  if (!httpServer) throw new Error('createSocketServer: httpServer is required');
  if (typeof sessionMiddleware !== 'function') {
    throw new Error('createSocketServer: sessionMiddleware is required');
  }

  const io = new Server(httpServer, {
    cors: options.cors || { origin: false },
    ...options,
  });

  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const session = socket.request.session;
    const userId = session && session.passport && session.passport.user;
    if (!userId) return next(new Error('Unauthorized'));
    socket.userId = String(userId);
    next();
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.userId}`);
    socket.emit('realtime:ready', { userId: socket.userId });

    socket.on('disconnect', (reason) => {
      if (process.env.NODE_ENV !== 'test') {
        console.log(`[socket] user ${socket.userId} disconnected (${reason})`);
      }
    });
  });

  return io;
}

module.exports = { createSocketServer };
