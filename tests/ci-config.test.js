const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('the GitHub workflow installs from the lockfile and runs the tests on Node 22', () => {
  const workflow = read('.github', 'workflows', 'test.yml');
  expect(workflow).toContain('branches: [main]');
  expect(workflow).toContain('pull_request:');
  expect(workflow).toContain('actions/checkout@v4');
  expect(workflow).toContain('actions/setup-node@v4');
  expect(workflow).toContain('node-version: 22');
  expect(workflow).toContain('npm ci');
  expect(workflow).toContain('npm test');
  expect(workflow).toContain('contents: read');
});

test('Dependabot watches npm packages and the workflow actions every week', () => {
  const dependabot = read('.github', 'dependabot.yml');
  expect(dependabot).toContain('package-ecosystem: "npm"');
  expect(dependabot).toContain('package-ecosystem: "github-actions"');
  expect(dependabot.match(/interval: "weekly"/g)).toHaveLength(2);
});

test('package.json offers the migration status shortcut', () => {
  const pkg = JSON.parse(read('package.json'));
  expect(pkg.scripts['migrate:status']).toBe('node scripts/migrate.js status');
  expect(pkg.scripts.test).toContain('jest');
});
