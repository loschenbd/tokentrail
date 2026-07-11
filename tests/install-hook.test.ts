import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findGitRoot, runInstallHook } from '../src/commands/install-hook.js';

const FAKE_HOOK = '/abs/path/to/tokentrail/src/hooks/session-end.sh';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'tokentrail-install-hook-'));
}

function readSettings(repo: string): any {
  return JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf-8'));
}

describe('runInstallHook', () => {
  test('creates .claude/settings.json with the Stop hook when none exists', () => {
    const repo = makeRepo();
    const r = runInstallHook({ repo, hookPath: FAKE_HOOK });

    assert.equal(r.action, 'added');
    const s = readSettings(repo);
    assert.equal(s.hooks.Stop[0].matcher, '*');
    assert.equal(s.hooks.Stop[0].hooks[0].type, 'command');
    assert.equal(s.hooks.Stop[0].hooks[0].command, FAKE_HOOK);
  });

  test('merges into an existing settings.json without clobbering other keys', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/script.sh' }] }],
        },
      })
    );

    runInstallHook({ repo, hookPath: FAKE_HOOK });
    const s = readSettings(repo);

    assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, '/other/script.sh');
    assert.equal(s.hooks.Stop[0].hooks[0].command, FAKE_HOOK);
  });

  test('is idempotent — re-running with the same hook path reports noop', () => {
    const repo = makeRepo();
    runInstallHook({ repo, hookPath: FAKE_HOOK });
    const r2 = runInstallHook({ repo, hookPath: FAKE_HOOK });

    assert.equal(r2.action, 'noop');
    const s = readSettings(repo);
    assert.equal(s.hooks.Stop[0].hooks.length, 1, 'should not stack duplicate hooks');
  });

  test('updates an existing tokentrail hook path when the repo moved', () => {
    const repo = makeRepo();
    runInstallHook({ repo, hookPath: '/old/location/tokentrail/src/hooks/session-end.sh' });

    const r = runInstallHook({ repo, hookPath: FAKE_HOOK });
    assert.equal(r.action, 'updated');

    const s = readSettings(repo);
    assert.equal(s.hooks.Stop[0].hooks.length, 1, 'should rewrite, not append');
    assert.equal(s.hooks.Stop[0].hooks[0].command, FAKE_HOOK);
  });

  test('appends to an existing Stop matcher="*" group alongside unrelated hooks', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/other/stop.sh' }] }],
        },
      })
    );

    runInstallHook({ repo, hookPath: FAKE_HOOK });
    const s = readSettings(repo);

    assert.equal(s.hooks.Stop.length, 1, 'should reuse the existing Stop group');
    assert.equal(s.hooks.Stop[0].hooks.length, 2);
    assert.deepEqual(
      s.hooks.Stop[0].hooks.map((h: any) => h.command).sort(),
      [FAKE_HOOK, '/other/stop.sh'].sort()
    );
  });

  test('--dry-run does not write the file', () => {
    const repo = makeRepo();
    const r = runInstallHook({ repo, hookPath: FAKE_HOOK, dryRun: true });
    assert.equal(r.action, 'added');
    assert.equal(existsSync(join(repo, '.claude', 'settings.json')), false);
  });
});

describe('findGitRoot', () => {
  test('finds the repo root from a nested directory', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.git'));
    const nested = join(repo, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    assert.equal(findGitRoot(nested), repo);
  });

  test('returns null outside any git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokentrail-no-repo-'));
    assert.equal(findGitRoot(dir), null);
  });
});
