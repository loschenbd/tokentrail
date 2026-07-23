import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOpenPath } from '../src/commands/dashboard.js';
import type { SetupStatus } from '../src/dashboard/data/setup-status.js';

function status(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    menubarApp: false,
    daemon: false,
    skills: false,
    hook: false,
    ...overrides,
  };
}

describe('pickOpenPath', () => {
  test('a genuinely fresh setup lands on the onboarding wizard', () => {
    assert.equal(pickOpenPath(status()), '/welcome');
  });

  test('any completed setup step lands on the Overview', () => {
    for (const step of ['menubarApp', 'daemon', 'skills', 'hook'] as const) {
      assert.equal(pickOpenPath(status({ [step]: true })), '/', `${step} alone should open Overview`);
    }
  });
});
