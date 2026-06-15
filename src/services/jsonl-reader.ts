import { existsSync, readdirSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type AssistantUsage = {
  // Unique event id — prefer message.id (msg_…), fall back to event uuid.
  eventId: string;
  sessionId: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Encoded project directory string from the path under ~/.claude/projects/<this>.
  projectDirEncoded: string;
};

export function claudeProjectsDir(): string {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir) return join(envDir, 'projects');
  return join(homedir(), '.claude', 'projects');
}

export function listSessionFiles(root = claudeProjectsDir()): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const projectName of safeReaddir(root)) {
    const projectPath = join(root, projectName);
    if (!safeIsDir(projectPath)) continue;
    for (const file of safeReaddir(projectPath)) {
      if (!file.endsWith('.jsonl')) continue;
      out.push(join(projectPath, file));
    }
  }
  return out;
}

export async function* readUsageEvents(
  files: string[]
): AsyncGenerator<AssistantUsage> {
  for (const file of files) {
    const projectDirEncoded = basename(dirname(file));
    const sessionIdFromName = basename(file, '.jsonl');
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const raw of lines) {
      if (!raw.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(raw);
      } catch {
        continue;
      }
      const usage = extractAssistantUsage(row, sessionIdFromName, projectDirEncoded);
      if (usage) yield usage;
    }
  }
}

function extractAssistantUsage(
  row: unknown,
  sessionFallback: string,
  projectDirEncoded: string
): AssistantUsage | null {
  if (!isRecord(row)) return null;
  if (row.type !== 'assistant') return null;
  const msg = row.message;
  if (!isRecord(msg)) return null;
  const usage = msg.usage;
  if (!isRecord(usage)) return null;

  const eventId =
    asString(msg.id) ?? asString(row.uuid) ?? `${asString(row.timestamp)}-${Math.random()}`;
  const sessionId = asString(row.sessionId) ?? sessionFallback;
  const timestamp = asString(row.timestamp) ?? new Date().toISOString();
  const model = asString(msg.model) ?? 'unknown';

  return {
    eventId,
    sessionId,
    timestamp,
    model,
    projectDirEncoded,
    inputTokens: asNumber(usage.input_tokens) ?? 0,
    outputTokens: asNumber(usage.output_tokens) ?? 0,
    cacheReadTokens: asNumber(usage.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: asNumber(usage.cache_creation_input_tokens) ?? 0,
  };
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
