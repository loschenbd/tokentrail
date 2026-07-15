export function bucketProject(r: { featureKey: string; featureName: string; repo: string | null }): {
  projectKey: string;
  projectName: string;
} {
  if (r.repo && r.repo.trim()) {
    // CSV-resilient: prefer the first slug-style entry; a local/ alias of
    // the same project only wins when no remote slug was ever observed.
    const entries = r.repo.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const firstRepo = entries.find((s) => !s.startsWith('local/')) ?? entries[0] ?? r.repo;
    const owner = firstRepo.includes('/') ? firstRepo.split('/')[0] : '';
    const name = firstRepo.split('/').pop() ?? firstRepo;
    // local/<basename> reads better as just the basename; GitHub-style
    // slugs keep the owner stripped so the eye lands on the project.
    return {
      projectKey: owner === 'local' ? `local:${name}` : `repo:${firstRepo}`,
      projectName: name,
    };
  }
  // No repo: the feature itself is its own project. Strip the "outside:"
  // prefix from the key so the URL stays human-readable.
  return {
    projectKey: `feature:${r.featureKey}`,
    projectName: r.featureName || r.featureKey,
  };
}
