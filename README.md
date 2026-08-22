# Global Village

A messaging web app built for [The Odin Project's Node.js Messaging App](https://www.theodinproject.com/lessons/nodejs-messaging-app) assignment.

**Author / Developer:** Newton Miriti

Global Village lets users create an account, customize their profile, message
other users directly, see who's currently online, add friends, send images in
chat, and start group chats.

## Features

- **Authorization** — register/login with hashed passwords (Passport.js local
  strategy + bcrypt), persistent sessions stored in SQLite.
- **Direct messaging** — one-on-one conversations, updated live via lightweight
  polling (no WebSockets, per the assignment's scope).
- **Profile customization** — display name, bio, status message, and avatar
  upload.
- **Online users list** — see everyone in the village and whether they're
  currently online (based on recent activity).
- **Friends list** — add/remove friends from the people list.
- **Image sharing in chat** — attach an image to any direct message or group
  message.
- **Group chats** — create a named group with multiple members and chat
  together.

## Tech stack

- **Backend:** Node.js, Express
- **Auth:** Passport.js (local strategy), bcryptjs, express-session
  (SQLite-backed session store)
- **Database:** SQLite via `better-sqlite3` (zero config, file-based)
- **Views:** EJS templates, hand-written CSS (no frontend framework/build step)
- **File uploads:** Multer (avatars + chat images)

Real-time updates are done via short-interval polling from the browser
(`fetch` every few seconds), since the assignment explicitly doesn't expect
WebSocket/SSE implementations.

## Data model

```
users            id, username, email, password_hash, display_name, bio,
                 avatar_url, status_message, last_seen, created_at

messages         id, sender_id, recipient_id (nullable), group_id (nullable),
                 body, image_url, created_at
                 -- exactly one of recipient_id / group_id is set

groups           id, name, avatar_url, created_by, created_at

group_members    group_id, user_id, joined_at

friends          user_id, friend_id, created_at
```

## Local setup

```bash
git clone <your-repo-url>
cd global-village
npm install
cp .env.example .env   # then edit SESSION_SECRET
npm start
```

The app runs at `http://localhost:3000`. A SQLite database file is created
automatically at `data/global-village.db` on first run — no separate database
server needed.

## Project structure

```
src/
  app.js              Express app entry point
  db.js               SQLite connection + schema
  config/
    passport.js       Passport local strategy
    upload.js         Multer config for avatars/chat images
  middleware/
    auth.js            ensureAuthenticated / ensureGuest / touchLastSeen
  routes/
    auth.js            register, login, logout
    profile.js          view/edit profile
    users.js            people list, online status, friends
    messages.js          direct messages + polling API
    groups.js            group chats + polling API
  public/               static assets (css, default avatars, uploads)
views/                  EJS templates
data/                   SQLite files (gitignored, created at runtime)
```

## Deploying

This app needs a host that supports persistent disk (for the SQLite file and
uploaded images) and lets you run a long-lived Node process — e.g.
**Render**, **Railway**, or a small VPS/**Fly.io** volume. Plain serverless
platforms (like Vercel's default functions) won't work well here because the
filesystem isn't persistent and `better-sqlite3` needs a native build step.

General steps (Render as an example):

1. Push this repo to GitHub.
2. Create a new **Web Service** on Render, pointing at the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add an environment variable `SESSION_SECRET` with a long random string.
6. Add a **persistent disk** mounted at `/opt/render/project/src/data` (and
   optionally `/opt/render/project/src/src/public/uploads`) so the database
   and uploaded images survive deploys/restarts.

## Extra credit implemented

- ✅ Sending images in chat
- ✅ Friends list + online status
- ✅ Group chats
