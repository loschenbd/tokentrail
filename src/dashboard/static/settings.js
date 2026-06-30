const form = document.getElementById('llm-form');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const body = {
    llm: {
      backend: fd.get('backend'),
      openrouter: {
        apiKey: fd.get('openrouter.apiKey') || null,
        model: fd.get('openrouter.model') || 'anthropic/claude-haiku-4.5',
      },
      ollama: {
        baseUrl: fd.get('ollama.baseUrl') || 'http://localhost:11434/v1',
        model: fd.get('ollama.model') || 'qwen2.5:3b',
      },
    },
  };
  // Preserve existing key if user left the field blank.
  if (!body.llm.openrouter.apiKey) {
    const cur = await (await fetch('/api/settings')).json();
    if (cur.llm.openrouter.hasKey) body.llm.openrouter.apiKey = '__KEEP__';
  }
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) location.reload();
  else alert('Save failed: ' + r.status);
});

document.querySelectorAll('button[data-test]').forEach((b) => {
  b.addEventListener('click', async () => {
    const backend = b.getAttribute('data-test');
    const model = backend === 'ollama'
      ? form.querySelector('input[name="ollama.model"]').value
      : form.querySelector('input[name="openrouter.model"]').value;
    const r = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend, model }),
    });
    const out = await r.json();
    alert(out.ok ? `OK in ${out.latencyMs}ms` : `Error: ${out.error}`);
  });
});
