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

// Populate the Ollama model dropdown from the local install. Falls back to a
// free-text input when Ollama is unreachable or has no models pulled.
async function refreshOllamaModels() {
  const field = form.querySelector('[name="ollama.model"]');
  if (!field) return;
  const baseUrl = form.querySelector('input[name="ollama.baseUrl"]').value;
  let data;
  try {
    const r = await fetch('/api/ollama/models?baseUrl=' + encodeURIComponent(baseUrl));
    data = await r.json();
  } catch { data = { ok: false }; }

  const current = field.value;

  if (!data.ok || !Array.isArray(data.models) || data.models.length === 0) {
    if (field.tagName === 'SELECT') {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'ollama.model';
      input.value = current;
      field.replaceWith(input);
    }
    return;
  }

  let select = field;
  if (field.tagName !== 'SELECT') {
    select = document.createElement('select');
    select.name = 'ollama.model';
    select.id = 'ollama-model-select';
    field.replaceWith(select);
  }
  select.innerHTML = '';
  if (current && !data.models.includes(current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = current + ' (not installed)';
    opt.selected = true;
    select.appendChild(opt);
  }
  for (const m of data.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === current) opt.selected = true;
    select.appendChild(opt);
  }
}

refreshOllamaModels();
form.querySelector('input[name="ollama.baseUrl"]').addEventListener('change', refreshOllamaModels);

document.querySelectorAll('button[data-test]').forEach((b) => {
  b.addEventListener('click', async () => {
    const backend = b.getAttribute('data-test');
    const model = backend === 'ollama'
      ? form.querySelector('[name="ollama.model"]').value
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

// Typed-confirm flow for removing the stored OpenRouter API key.
const removeBtn = document.getElementById('remove-key-btn');
const confirmDiv = document.getElementById('remove-key-confirm');
const confirmInput = document.getElementById('remove-key-input');
const confirmSubmit = document.getElementById('remove-key-submit');
const confirmCancel = document.getElementById('remove-key-cancel');

if (removeBtn && confirmDiv && confirmInput && confirmSubmit && confirmCancel) {
  const keyTail = confirmDiv.getAttribute('data-key-tail') || '';

  removeBtn.addEventListener('click', () => {
    confirmDiv.removeAttribute('hidden');
    removeBtn.closest('.remove-key-row').setAttribute('hidden', '');
    confirmInput.focus();
  });

  confirmInput.addEventListener('input', () => {
    confirmSubmit.disabled = confirmInput.value !== keyTail;
  });

  confirmSubmit.addEventListener('click', async () => {
    // Read current settings then POST with apiKey: null.
    const cur = await (await fetch('/api/settings')).json();
    const body = {
      llm: {
        backend: cur.llm.backend,
        openrouter: {
          apiKey: null,
          model: cur.llm.openrouter.model,
        },
        ollama: {
          baseUrl: cur.llm.ollama.baseUrl,
          model: cur.llm.ollama.model,
        },
      },
    };
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) location.reload();
    else alert('Remove failed: ' + r.status);
  });

  confirmCancel.addEventListener('click', () => {
    confirmDiv.setAttribute('hidden', '');
    confirmInput.value = '';
    confirmSubmit.disabled = true;
    removeBtn.closest('.remove-key-row').removeAttribute('hidden');
  });
}
