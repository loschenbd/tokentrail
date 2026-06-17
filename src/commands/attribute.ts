import { attribute } from '../lib/attribution.js';
import { getConfig } from '../lib/config.js';

export type AttributeCommandOptions = {
  repo: string;
  branch: string;
  prTitle?: string;
  prLabels?: string;
};

export function runAttribute(opts: AttributeCommandOptions): void {
  const config = getConfig();
  const result = attribute(
    {
      repo: opts.repo,
      branch: opts.branch,
      prTitle: opts.prTitle ?? null,
      prLabels: opts.prLabels ? opts.prLabels.split(',').map((s) => s.trim()) : undefined,
    },
    config
  );
  console.log(`feature_key:  ${result.featureKey}`);
  console.log(`feature_name: ${result.featureName}`);
  console.log(`source:       ${result.source}`);
  console.log(`config:       ${config.source ?? '(defaults — no .tokentrail.json found)'}`);
}
