import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readSettings, writeSettings, settingsPath } from '../lib/settings.js';
import { getLLMClient } from '../lib/llm.js';

export async function runLlmStatus(): Promise<void> {
  const s = readSettings();
  const c = getLLMClient();
  console.log(`Settings: ${settingsPath()}`);
  console.log(`Backend setting:  ${s.llm.backend}`);
  console.log(`Effective backend: ${c?.backend ?? 'none'}`);
  if (c) console.log(`Model: ${c.model}`);
  if (s.llm.openrouter.apiKey || process.env.OPENROUTER_API_KEY) {
    console.log('OpenRouter API key: set');
  } else {
    console.log('OpenRouter API key: (none)');
  }
  console.log(`Ollama URL: ${s.llm.ollama.baseUrl}`);
}

export async function runLlmTest(): Promise<void> {
  const c = getLLMClient();
  if (!c) {
    console.error('No LLM backend configured. Run `tokentrail llm setup`.');
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  try {
    const r = await c.client.chat.completions.create({
      model: c.model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 5,
    });
    const ms = Date.now() - t0;
    console.log(`OK ${c.backend}/${c.model} in ${ms}ms → ${r.choices[0]?.message?.content?.trim()}`);
  } catch (e) {
    console.error(`FAIL ${c.backend}/${c.model}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export async function runLlmSetup(): Promise<void> {
  const s = readSettings();
  const rl = createInterface({ input: stdin, output: stdout });
  console.log('\nLLM backend for topic inference + clustering.');
  console.log('  ollama     local, free, private');
  console.log('  openrouter cloud (third-party LLM); sends commit subjects + session titles off-device');
  console.log('  none       deterministic rules only');
  const choice = (await rl.question(`Choose [ollama/openrouter/none] (current: ${s.llm.backend}): `)).trim() || s.llm.backend;
  if (!['ollama', 'openrouter', 'none', 'auto'].includes(choice)) {
    console.error(`Invalid choice: ${choice}`);
    process.exitCode = 1;
    rl.close();
    return;
  }
  s.llm.backend = choice as typeof s.llm.backend;

  if (choice === 'openrouter') {
    const cur = s.llm.openrouter.apiKey ? '(stored)' : '(none)';
    const key = (await rl.question(`OpenRouter API key ${cur}: `)).trim();
    if (key) s.llm.openrouter.apiKey = key;
    const model = (await rl.question(`Model (current: ${s.llm.openrouter.model}): `)).trim();
    if (model) s.llm.openrouter.model = model;
  }
  if (choice === 'ollama') {
    const url = (await rl.question(`Ollama base URL (current: ${s.llm.ollama.baseUrl}): `)).trim();
    if (url) s.llm.ollama.baseUrl = url;
    const model = (await rl.question(`Model (current: ${s.llm.ollama.model}): `)).trim();
    if (model) s.llm.ollama.model = model;
  }
  rl.close();
  writeSettings(s);
  console.log(`\nSaved → ${settingsPath()}`);
  await runLlmStatus();
}
