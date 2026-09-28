const request = require('supertest');
const app = require('../src/app');

let userCounter = 0;

// Registers a fresh user and returns a supertest agent that stays logged in
// as that user (the agent keeps the session cookie between requests).
async function registerAndLogin(overrides = {}) {
  userCounter += 1;
  const username = overrides.username || `user${userCounter}`;
  const email = overrides.email || `${username}@example.com`;
  const displayName = overrides.displayName || username;
  const password = overrides.password || 'Passw0rd!x';

  const agent = request.agent(app);
  await agent.post('/register').type('form').send({
    username,
    email,
    displayName,
    password,
    confirmPassword: password,
  });

  return { agent, username, email, displayName, password };
}

// User ids are a shared auto-incrementing counter for the whole test file
// (the in-memory db persists across tests in the same file, so /users often
// lists more than the two people in the current test), so this parses each
// list tile individually rather than doing one loose match across the page.
async function findUserId(agent, username) {
  const page = await agent.get('/users');
  const tiles = page.text.match(/<li class="tile" data-user-id="\d+">[\s\S]*?<\/li>/g) || [];
  for (const tile of tiles) {
    if (new RegExp(`@${username}\\b`).test(tile)) {
      const idMatch = tile.match(/data-user-id="(\d+)"/);
      return idMatch ? idMatch[1] : null;
    }
  }
  return null;
}

module.exports = { app, registerAndLogin, findUserId };
