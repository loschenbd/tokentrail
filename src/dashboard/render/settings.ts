import type { SettingsViewModel } from '../data/settings.js';

export function renderSettings(vm: SettingsViewModel): string {
  return `
<section class="settings">
  <h1>Settings</h1>
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
      <label>Model    <input name="ollama.model" value="${escapeHtml(vm.llm.ollama.model)}"></label>
      <button type="button" data-test="ollama">Test</button>
    </fieldset>

    <fieldset>
      <legend>OpenRouter</legend>
      <label>API key  <input name="openrouter.apiKey" type="password" placeholder="${vm.llm.openrouter.hasKey ? '••• …' + vm.llm.openrouter.keyTail : '(none)'}"></label>
      <label>Model    <input name="openrouter.model" value="${escapeHtml(vm.llm.openrouter.model)}"></label>
      <button type="button" data-test="openrouter">Test</button>
    </fieldset>

    <button type="submit">Save</button>
  </form>
  <script src="/static/settings.js"></script>
</section>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
