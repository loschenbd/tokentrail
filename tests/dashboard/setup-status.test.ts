import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSetupStatus } from '../../src/dashboard/data/setup-status.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'tokentrail-status-home-'));
  const apps = mkdtempSync(join(tmpdir(), 'tokentrail-status-apps-'));
  return { home, apps };
}

describe('readSetupStatus', () => {
  test('returns all false on a clean home', () => {
    const { home, apps } = fixture();
    const s = readSetupStatus({ home, appsDir: apps });
    assert.deepEqual(s, {
      menubarApp: false,
      daemon: false,
      skills: false,
      hook: false,
    });
  });

  test('detects each artifact independently', () => {
    const { home, apps } = fixture();

    const agentDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agentDir, { recursive: true });
    // Native menu-bar app: its LaunchAgent is the install signal.
    writeFileSync(join(agentDir, 'com.benjaminloschen.tokentrail.menubar.plist'), '<plist/>');
    writeFileSync(join(agentDir, 'com.tokentrail.daemon.plist'), '<plist/>');

    mkdirSync(join(home, '.claude', 'skills', 'tokentrail-spend'), { recursive: true });

    const projDir = join(home, '.claude', 'projects', 'some-project');
    mkdirSync(projDir, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), 'tokentrail-status-repo-'));
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/path/to/tokentrail/src/hooks/session-end.sh' }] }] },
      }),
    );
    writeFileSync(join(projDir, 'cwd'), repo);

    const s = readSetupStatus({ home, appsDir: apps });
    assert.equal(s.menubarApp, true);
    assert.equal(s.daemon, true);
    assert.equal(s.skills, true);
    assert.equal(s.hook, true);
  });

  test('hook detector ignores tokentrail-mentioning hooks whose command is something else', () => {
    const { home, apps } = fixture();
    const projDir = join(home, '.claude', 'projects', 'noisy-project');
    mkdirSync(projDir, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), 'tokentrail-status-repo-'));
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: 'tokentrail-spend',
              hooks: [{ type: 'command', command: '/usr/local/bin/some-other-tool' }],
            },
          ],
        },
      }),
    );
    writeFileSync(join(projDir, 'cwd'), repo);

    assert.equal(readSetupStatus({ home, appsDir: apps }).hook, false);
  });

  test('hook detector ignores malformed settings.json', () => {
    const { home, apps } = fixture();
    const projDir = join(home, '.claude', 'projects', 'bad-project');
    mkdirSync(projDir, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), 'tokentrail-status-repo-'));
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), '{ not valid json');
    writeFileSync(join(projDir, 'cwd'), repo);

    assert.equal(readSetupStatus({ home, appsDir: apps }).hook, false);
  });
});
