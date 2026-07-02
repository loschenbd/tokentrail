import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Guard: the CLI's `--version` MUST match package.json. Past releases shipped
// with a hardcoded version literal in src/index.ts that drifted from
// package.json — the Homebrew formula's `brew test` block caught it, but only
// after a failed release. This test catches drift before tagging.
describe('CLI --version', () => {
  test('matches package.json version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const stdout = execSync('node dist/src/index.js --version', { encoding: 'utf8' }).trim();
    assert.equal(stdout, pkg.version);
  });

  // Guard: the version lookup must also work when running from SOURCE via
  // tsx. A hardcoded ../../package.json resolves correctly from the compiled
  // dist/src/ layout but escapes the checkout entirely from src/ (it lands on
  // <parent-of-repo>/package.json) — which silently broke `npm run dev` and
  // the launchd daemon on every dev checkout and git worktree.
  test('resolves package.json when run from source via tsx', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const stdout = execSync('npx tsx src/index.ts --version', { encoding: 'utf8' }).trim();
    assert.equal(stdout, pkg.version);
  });
});
