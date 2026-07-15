import type DatabaseType from 'better-sqlite3';
import { readSettings } from '../../lib/settings.js';
import { bucketProject } from '../lib/project-bucket.js';
import { matchesHiddenPattern, normalizeProjectToken } from '../lib/hidden-projects.js';

export type SettingsViewModel = {
  llm: {
    backend: string;
    openrouter: { hasKey: boolean; keyTail: string | null; model: string };
    ollama: { baseUrl: string; model: string };
  };
  // Raw patterns from settings.json, in file order.
  hiddenProjects: string[];
  // Every project in the ledger with its current visibility, so the page
  // can offer a picker instead of asking the user to type a pattern.
  projects: Array<{ key: string; name: string; hidden: boolean }>;
};

export function buildSettingsVM(db?: DatabaseType.Database): SettingsViewModel {
  const s = readSettings();
  const key = s.llm.openrouter.apiKey ?? null;
  const patterns = s.hiddenProjects.map(normalizeProjectToken).filter((p) => p.length > 0);

  const projects: SettingsViewModel['projects'] = [];
  if (db) {
    const rows = db
      .prepare(`
        SELECT feature_key AS featureKey,
               MAX(feature_name) AS featureName,
               MAX(repo) AS repo
        FROM feature_rollups
        GROUP BY feature_key
      `)
      .all() as Array<{ featureKey: string; featureName: string; repo: string | null }>;
    const seen = new Map<string, { key: string; name: string; hidden: boolean }>();
    for (const r of rows) {
      const { projectKey, projectName } = bucketProject(r);
      if (seen.has(projectKey)) continue;
      seen.set(projectKey, {
        key: projectKey,
        name: projectName,
        hidden: matchesHiddenPattern(patterns, projectKey, projectName, r.repo, r.featureKey, r.featureName),
      });
    }
    projects.push(...[...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  return {
    llm: {
      backend: s.llm.backend,
      openrouter: {
        hasKey: !!key,
        keyTail: key ? key.slice(-4) : null,
        model: s.llm.openrouter.model,
      },
      ollama: { baseUrl: s.llm.ollama.baseUrl, model: s.llm.ollama.model },
    },
    hiddenProjects: s.hiddenProjects,
    projects,
  };
}
