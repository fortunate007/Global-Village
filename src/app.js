require('dotenv').config();
const express = require('express');
const path = require('path');
const passport = require('passport');
const flash = require('connect-flash');
const http = require('http');
const { createSessionMiddleware } = require('./config/session');
const { createSocketServer } = require('./realtime');

const db = require('./db');
const configurePassport = require('./config/passport');
const { touchLastSeen } = require('./middleware/auth');

configurePassport(passport);

const app = express();

app.set('view engine', 'ejs');
app.locals.linkify = require('./utils/linkify').linkify;
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = createSessionMiddleware();
app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());
app.use(flash());
app.use(touchLastSeen);

// Make current user & flash messages available in every view
app.use((req, res, next) => {
  res.locals.currentUser = req.user || null;
  res.locals.successMsg = req.flash('success');
  res.locals.errorMsg = req.flash('error');
  res.locals.appName = 'Global Village';
  res.locals.pendingRequests = req.user
    ? db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE recipient_id = ?').get(req.user.id).n
    : 0;
  next();
});

app.use((req, res, next) => { res.locals.unreadNotifications = req.user ? require('./services/notificationService').unreadCount(req.user.id) : 0; next(); });
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/profile'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/friends'));
app.use('/', require('./routes/messages'));
app.use('/', require('./routes/groups'));
app.use('/posts', require('./routes/posts'));
app.use('/', require('./routes/bookmarks'));
app.use('/', require('./routes/entities'));
app.use('/', require('./routes/search'));
app.use('/', require('./routes/notifications'));

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    req.flash('error', 'That file is too large. Images must be under 5MB.');
    return res.redirect('back');
  }
  if (err.message && err.message.includes('Only image files')) {
    req.flash('error', err.message);
    return res.redirect('back');
  }
  res.status(500).send('Something went wrong.');
});

const server = http.createServer(app);
const io = createSocketServer(server, sessionMiddleware);
app.set('io', io);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Global Village running at http://localhost:${PORT}`);
  });
}
module.exports = app;
