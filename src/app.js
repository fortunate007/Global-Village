require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const flash = require('connect-flash');

const db = require('./db');
const configurePassport = require('./config/passport');
const { touchLastSeen } = require('./middleware/auth');

configurePassport(passport);

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, '..', 'data') }),
    secret: process.env.SESSION_SECRET || 'global-village-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
  })
);

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
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/profile'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/messages'));
app.use('/', require('./routes/groups'));

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err.message && err.message.includes('Only image files')) {
    req.flash('error', err.message);
    return res.redirect('back');
  }
  res.status(500).send('Something went wrong.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Global Village running at http://localhost:${PORT}`);
});

module.exports = app;
