const browser = globalThis.browser || chrome;

const providerSelect = document.getElementById('providerSelect');
const cloudField = document.getElementById('cloudField');
const ollamaField = document.getElementById('ollamaField');
const ollamaUrl = document.getElementById('ollamaUrl');
const saveBtn = document.getElementById('saveBtn');
const statusMsg = document.getElementById('statusMsg');

// API keys are deliberately NOT handled here anymore (audit refactor #5): they
// live in the proxy's Railway environment (ANTHROPIC_API_KEY / OPENAI_API_KEY)
// and never touch the browser. This page only picks the provider and, for
// Ollama, the local base URL.

// Show/hide fields based on selected provider
function updateFields() {
  const provider = providerSelect.value;
  cloudField.style.display  = provider === 'ollama' ? 'none' : 'block';
  ollamaField.style.display = provider === 'ollama' ? 'block' : 'none';
}

// Load saved settings into the form on page open
function loadSettings() {
  browser.storage.local.get(['selectedProvider', 'ollamaBaseUrl'], (result) => {
    providerSelect.value = result.selectedProvider || 'anthropic';
    ollamaUrl.value      = result.ollamaBaseUrl    || 'http://localhost:11434';
    updateFields();
  });
}

// Save settings to chrome.storage.local
function saveSettings() {
  const toSave = {
    selectedProvider: providerSelect.value,
    ollamaBaseUrl:    ollamaUrl.value.trim() || 'http://localhost:11434'
  };

  browser.storage.local.set(toSave, () => {
    // Belt-and-braces: purge any API keys a previous version stored in the
    // browser (background.js also does this once at startup).
    browser.storage.local.remove(['apiKey_anthropic', 'apiKey_openai']);
    statusMsg.textContent = '✓ Settings saved.';
    statusMsg.className = 'status';
    setTimeout(() => { statusMsg.textContent = ''; }, 3000);
  });
}

providerSelect.addEventListener('change', updateFields);
saveBtn.addEventListener('click', saveSettings);

loadSettings();
