import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { pkgRoot } from '../lib/pkg-root.js';

export type InstallSkillsOptions = {
  dryRun?: boolean;
  force?: boolean;
  /** Override ~/.claude root (for tests). */
  claudeHome?: string;
  /** Override templates source (for tests). */
  templatesDir?: string;
};

export type InstallSkillsResult = {
  linked: string[];
  alreadyLinked: string[];
  skipped: string[];
  replaced: string[];
};

export function runInstallSkills(opts: InstallSkillsOptions = {}): InstallSkillsResult {
  const claudeHome = opts.claudeHome ?? join(homedir(), '.claude');
  const templatesDir = opts.templatesDir ?? join(pkgRoot(), 'templates');

  const result: InstallSkillsResult = {
    linked: [],
    alreadyLinked: [],
    skipped: [],
    replaced: [],
  };

  installFromDir(
    join(templatesDir, 'skills'),
    join(claudeHome, 'skills'),
    opts,
    result,
    'skill'
  );
  installFromDir(
    join(templatesDir, 'commands'),
    join(claudeHome, 'commands'),
    opts,
    result,
    'command'
  );

  return result;
}

function installFromDir(
  srcRoot: string,
  dstRoot: string,
  opts: InstallSkillsOptions,
  result: InstallSkillsResult,
  label: string
): void {
  if (!existsSync(srcRoot)) {
    console.warn(`[tokentrail] templates dir missing: ${srcRoot}`);
    return;
  }
  if (!opts.dryRun) mkdirSync(dstRoot, { recursive: true });

  for (const name of readdirSync(srcRoot)) {
    const src = join(srcRoot, name);
    const dst = join(dstRoot, name);
    installSymlink(src, dst, opts, result, label);
  }
}

function installSymlink(
  src: string,
  dst: string,
  opts: InstallSkillsOptions,
  result: InstallSkillsResult,
  label: string
): void {
  // lstat doesn't follow the link, so we can detect symlinks pointing nowhere.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(dst);
  } catch {
    /* no entry — proceed to create */
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      try {
        if (readlinkSync(dst) === src) {
          console.log(`[ok] ${label} already linked: ${dst}`);
          result.alreadyLinked.push(dst);
          return;
        }
      } catch {
        /* unreadable symlink — fall through to replace */
      }
    }
    if (!opts.force) {
      console.log(`[skip] ${dst} exists — pass --force to replace.`);
      result.skipped.push(dst);
      return;
    }
    if (!opts.dryRun) unlinkSync(dst);
    result.replaced.push(dst);
  }

  if (opts.dryRun) {
    console.log(`[dry] would link ${label}: ${dst} → ${src}`);
  } else {
    symlinkSync(src, dst);
    console.log(`[linked] ${label}: ${dst} → ${src}`);
  }
  result.linked.push(dst);
}
