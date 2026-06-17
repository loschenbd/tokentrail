import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, existsSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallSkills } from '../src/commands/install-skills.js';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tokentrail-install-skills-'));
  const claudeHome = join(root, 'claude');
  const templates = join(root, 'templates');
  mkdirSync(join(templates, 'skills', 'tokentrail-spend'), { recursive: true });
  mkdirSync(join(templates, 'commands'), { recursive: true });
  writeFileSync(join(templates, 'skills', 'tokentrail-spend', 'SKILL.md'), '# test\n');
  writeFileSync(join(templates, 'commands', 'today.md'), 'today body\n');
  writeFileSync(join(templates, 'commands', 'rollup.md'), 'rollup body\n');
  return { claudeHome, templates };
}

describe('runInstallSkills', () => {
  test('creates symlinks for skills and commands in ~/.claude', () => {
    const { claudeHome, templates } = makeFixture();
    const r = runInstallSkills({ claudeHome, templatesDir: templates });

    assert.equal(r.linked.length, 3, 'should link 1 skill + 2 commands');
    assert.equal(r.alreadyLinked.length, 0);
    assert.equal(r.skipped.length, 0);

    const skillLink = join(claudeHome, 'skills', 'tokentrail-spend');
    assert.ok(lstatSync(skillLink).isSymbolicLink());
    assert.equal(readlinkSync(skillLink), join(templates, 'skills', 'tokentrail-spend'));

    const todayLink = join(claudeHome, 'commands', 'today.md');
    assert.ok(lstatSync(todayLink).isSymbolicLink());
    assert.equal(readlinkSync(todayLink), join(templates, 'commands', 'today.md'));
  });

  test('is idempotent — re-running reports already-linked, not duplicates', () => {
    const { claudeHome, templates } = makeFixture();
    runInstallSkills({ claudeHome, templatesDir: templates });
    const r2 = runInstallSkills({ claudeHome, templatesDir: templates });

    assert.equal(r2.alreadyLinked.length, 3);
    assert.equal(r2.linked.length, 0);
    assert.equal(r2.skipped.length, 0);
  });

  test('skips existing non-symlink files unless --force', () => {
    const { claudeHome, templates } = makeFixture();
    mkdirSync(join(claudeHome, 'commands'), { recursive: true });
    writeFileSync(join(claudeHome, 'commands', 'today.md'), 'user-customized today\n');

    const r = runInstallSkills({ claudeHome, templatesDir: templates });
    assert.equal(r.skipped.length, 1);
    assert.ok(r.skipped[0]!.endsWith('today.md'));
    // The user's file is preserved
    assert.ok(existsSync(join(claudeHome, 'commands', 'today.md')));
  });

  test('--force replaces conflicting files', () => {
    const { claudeHome, templates } = makeFixture();
    mkdirSync(join(claudeHome, 'commands'), { recursive: true });
    writeFileSync(join(claudeHome, 'commands', 'today.md'), 'user-customized today\n');

    const r = runInstallSkills({ claudeHome, templatesDir: templates, force: true });
    assert.equal(r.replaced.length, 1);
    assert.ok(lstatSync(join(claudeHome, 'commands', 'today.md')).isSymbolicLink());
  });

  test('replaces a stale symlink pointing somewhere else', () => {
    const { claudeHome, templates } = makeFixture();
    mkdirSync(join(claudeHome, 'commands'), { recursive: true });
    const stale = '/nonexistent/old-tokentrail/today.md';
    symlinkSync(stale, join(claudeHome, 'commands', 'today.md'));

    // Without --force: skipped (preserves user intent if they were pointing elsewhere on purpose)
    const r1 = runInstallSkills({ claudeHome, templatesDir: templates });
    assert.equal(r1.skipped.length, 1);

    // With --force: replaced
    const r2 = runInstallSkills({ claudeHome, templatesDir: templates, force: true });
    assert.equal(r2.replaced.length, 1);
    assert.equal(
      readlinkSync(join(claudeHome, 'commands', 'today.md')),
      join(templates, 'commands', 'today.md')
    );
  });

  test('--dry-run touches nothing', () => {
    const { claudeHome, templates } = makeFixture();
    const r = runInstallSkills({ claudeHome, templatesDir: templates, dryRun: true });
    assert.equal(r.linked.length, 3);
    assert.equal(existsSync(join(claudeHome, 'skills', 'tokentrail-spend')), false);
    assert.equal(existsSync(join(claudeHome, 'commands', 'today.md')), false);
  });
});
