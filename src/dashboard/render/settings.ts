import { escapeHtml } from './shell.js';
import type { SettingsViewModel } from '../data/settings.js';

export function renderSettings(vm: SettingsViewModel): string {
  const orHasKey = vm.llm.openrouter.hasKey;
  const keyTail = orHasKey ? escapeHtml(vm.llm.openrouter.keyTail ?? '') : '';

  const removeKeyUI = orHasKey ? `
      <div class="remove-key-row">
        <button type="button" id="remove-key-btn">Remove key</button>
      </div>
      <div id="remove-key-confirm" data-key-tail="${keyTail}" hidden>
        <p class="remove-key-hint">Type the last 4 characters of the key (<code>••••${keyTail}</code>) to confirm removal.</p>
        <input id="remove-key-input" type="text" maxlength="4" autocomplete="off" placeholder="${keyTail}">
        <button type="button" id="remove-key-submit" disabled>Remove</button>
        <button type="button" id="remove-key-cancel">Cancel</button>
      </div>` : '';

  // Picker options: visible projects, deduped by display name (hiding a
  // name hides every identity that shares it — repo slug, local alias,
  // worktrees — which is what the eye expects).
  const visibleNames = [...new Set(
    vm.projects.filter((p) => !p.hidden).map((p) => p.name)
  )].sort((a, b) => a.localeCompare(b));
  const hideOptions = visibleNames
    .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
    .join('');
  const hiddenChips = vm.hiddenProjects
    .map((p) => `
      <span class="hidden-chip" data-pattern="${escapeHtml(p)}">${escapeHtml(p)}<button
        type="button" class="hidden-chip-remove" aria-label="Show ${escapeHtml(p)} again">×</button></span>`)
    .join('');

  const hiddenProjectsUI = `
    <fieldset class="hidden-projects">
      <legend>Hidden projects</legend>
      <p class="hidden-projects-hint">Hidden projects stay in the ledger and keep recording — they're just left off the trail. Matching is by name, so worktrees and local aliases hide together.</p>
      <div class="hidden-chip-row" id="hidden-chip-row">
        ${vm.hiddenProjects.length > 0 ? hiddenChips : '<span class="hidden-none">Nothing hidden.</span>'}
      </div>
      <div class="hide-project-row">
        <label>Hide <select id="hide-project-select">
          <option value="" selected disabled>Choose a project…</option>
          ${hideOptions}
        </select></label>
        <button type="button" id="hide-project-btn" disabled>Hide</button>
      </div>
    </fieldset>`;

  return `
<section class="settings">
  <h1>Settings</h1>
  ${hiddenProjectsUI}
  <form id="llm-form">
    <fieldset>
      <legend>LLM backend</legend>
      <label><input type="radio" name="backend" value="auto" ${vm.llm.backend === 'auto' ? 'checked' : ''}> Auto</label>
      <label><input type="radio" name="backend" value="ollama" ${vm.llm.backend === 'ollama' ? 'checked' : ''}> Ollama (local, private)</label>
      <label><input type="radio" name="backend" value="openrouter" ${vm.llm.backend === 'openrouter' ? 'checked' : ''}> OpenRouter (cloud)</label>
      <label><input type="radio" name="backend" value="none" ${vm.llm.backend === 'none' ? 'checked' : ''}> Off</label>
    </fieldset>

    <fieldset>
      <legend>Ollama</legend>
      <label>Base URL <input name="ollama.baseUrl" value="${escapeHtml(vm.llm.ollama.baseUrl)}"></label>
      <label>Model    <select name="ollama.model" id="ollama-model-select"><option value="${escapeHtml(vm.llm.ollama.model)}" selected>${escapeHtml(vm.llm.ollama.model)}</option></select></label>
      <button type="button" data-test="ollama">Test</button>
    </fieldset>

    <fieldset>
      <legend>OpenRouter</legend>
      <label>API key  <input name="openrouter.apiKey" type="password" placeholder="${orHasKey ? '••• …' + keyTail : '(none)'}"></label>
      <label>Model    <input name="openrouter.model" value="${escapeHtml(vm.llm.openrouter.model)}"></label>
      <button type="button" data-test="openrouter">Test</button>
      ${removeKeyUI}
    </fieldset>

    <button type="submit">Save</button>
  </form>
  <script src="/static/settings.js"></script>
</section>`;
}
