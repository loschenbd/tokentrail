import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute } from '../src/lib/attribution.js';
import type { TokentrailConfig } from '../src/lib/config.js';

const EMPTY_CONFIG: TokentrailConfig = {
  extraMainlineBranches: [],
  extraBranchPatterns: [],
  extraProjectsParentDirs: [],
  featureOverrides: {},
  cursorTrackingDbPath: null,
  cursorStateDbPath: null,
  cursorSessionCookie: null,
  cursorCloudSpend: true,
  copilotStorePath: null,
  source: null,
  monthlyBudgetUsd: null,
  budgetCycleStartDay: 1,
};

describe('attribute()', () => {
  test('mainline branch is scoped by repo so different projects do not collapse', () => {
    const a = attribute({ repo: 'octo/anamnesis', branch: 'main' }, EMPTY_CONFIG);
    const b = attribute({ repo: 'octo/tokentrail', branch: 'main' }, EMPTY_CONFIG);
    assert.notEqual(a.featureKey, b.featureKey);
    assert.equal(a.source, 'mainline');
    assert.equal(b.source, 'mainline');
    assert.match(a.featureKey, /anamnesis/);
    assert.match(b.featureKey, /tokentrail/);
    assert.equal(a.featureName, 'anamnesis (main)');
    assert.equal(b.featureName, 'tokentrail (main)');
  });

  test('feature/ branch prefix still produces a feature-scoped key', () => {
    const a = attribute({ repo: 'octo/x', branch: 'feature/cool-thing' }, EMPTY_CONFIG);
    assert.equal(a.source, 'branch-prefix');
    assert.equal(a.featureKey, 'cool-thing');
  });

  test('global mainline fallback when repo is missing', () => {
    const a = attribute({ repo: '', branch: 'main' }, EMPTY_CONFIG);
    assert.equal(a.featureKey, 'mainline-main');
    assert.equal(a.featureName, 'Mainline (main)');
  });

  test('extraMainlineBranches from config recognizes user-defined defaults like "trunk"', () => {
    const config: TokentrailConfig = { ...EMPTY_CONFIG, extraMainlineBranches: ['trunk'] };
    const a = attribute({ repo: 'octo/x', branch: 'trunk' }, config);
    assert.equal(a.source, 'mainline');
    assert.equal(a.featureKey, 'mainline-octo-x-trunk');
    assert.equal(a.featureName, 'x (trunk)');
  });

  test('extraBranchPatterns from config matches and prefixes correctly', () => {
    const config: TokentrailConfig = {
      ...EMPTY_CONFIG,
      extraBranchPatterns: [
        { pattern: /^release\/(.+)$/, keyPrefix: 'release-', namePrefix: 'Release: ' },
      ],
    };
    const a = attribute({ repo: 'octo/x', branch: 'release/v2.1' }, config);
    assert.equal(a.source, 'branch-prefix');
    assert.equal(a.featureKey, 'release-v2-1');
    assert.equal(a.featureName, 'Release: V2.1');
  });

  test('featureOverrides from config beat everything else, including PR title', () => {
    const config: TokentrailConfig = {
      ...EMPTY_CONFIG,
      featureOverrides: {
        'octo/x:feat/cryptic': { featureKey: 'better-name', featureName: 'Better Name' },
      },
    };
    const a = attribute(
      { repo: 'octo/x', branch: 'feat/cryptic', prTitle: 'PR title that would have won' },
      config
    );
    assert.equal(a.source, 'override');
    assert.equal(a.featureKey, 'better-name');
    assert.equal(a.featureName, 'Better Name');
  });

  test('default branch patterns take priority over extra patterns when both could match', () => {
    // Custom pattern claims `^feat/(.+)$` too, but the default already
    // handles `^(?:feature|feat)/(.+)$` and should win.
    const config: TokentrailConfig = {
      ...EMPTY_CONFIG,
      extraBranchPatterns: [
        { pattern: /^feat\/(.+)$/, keyPrefix: 'SHOULD-NOT-MATCH-', namePrefix: 'wrong: ' },
      ],
    };
    const a = attribute({ repo: 'octo/x', branch: 'feat/thing' }, config);
    assert.equal(a.featureKey, 'thing');
    assert.equal(a.featureName, 'Thing');
  });
});
