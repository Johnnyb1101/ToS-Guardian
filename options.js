const browser = globalThis.browser || chrome;

const providerSelect = document.getElementById('providerSelect');
const cloudField = document.getElementById('cloudField');
const ollamaField = document.getElementById('ollamaField');
const ollamaUrl = document.getElementById('ollamaUrl');
const saveBtn = document.getElementById('saveBtn');
const statusMsg = document.getElementById('statusMsg');
const observerEnabled = document.getElementById('observerEnabled');
const observerPort = document.getElementById('observerPort');

// API keys are deliberately NOT handled here anymore (audit refactor #5): they
// live in the proxy's Railway environment (ANTHROPIC_API_KEY / OPENAI_API_KEY)
// and never touch the browser. This page only picks the provider and, for
// Ollama, the local base URL.
//
// Observer mode (learning loop, phase 0) is a developer setting: off by
// default; when on, the background worker posts per-stage episode facts to a
// collector on 127.0.0.1 at the chosen port. See episode.js for exactly what a
// record can contain.

const OBSERVER_DEFAULT_PORT = 3123;

// Show/hide fields based on selected provider
function updateFields() {
  const provider = providerSelect.value;
  cloudField.style.display  = provider === 'ollama' ? 'none' : 'block';
  ollamaField.style.display = provider === 'ollama' ? 'block' : 'none';
}

function parsePort(value) {
  const n = Number(String(value || '').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

// Load saved settings into the form on page open
function loadSettings() {
  browser.storage.local.get(['selectedProvider', 'ollamaBaseUrl', 'tosGuardianObserver'], (result) => {
    providerSelect.value = result.selectedProvider || 'anthropic';
    ollamaUrl.value      = result.ollamaBaseUrl    || 'http://localhost:11434';
    const observer = result.tosGuardianObserver || {};
    observerEnabled.checked = observer.enabled === true;
    observerPort.value = String(parsePort(observer.port) || OBSERVER_DEFAULT_PORT);
    updateFields();
  });
}

// Save settings to chrome.storage.local
function saveSettings() {
  const port = parsePort(observerPort.value);
  if (observerEnabled.checked && !port) {
    statusMsg.textContent = 'Collector port must be a number between 1 and 65535.';
    statusMsg.className = 'status error';
    return;
  }

  const toSave = {
    selectedProvider: providerSelect.value,
    ollamaBaseUrl:    ollamaUrl.value.trim() || 'http://localhost:11434',
    tosGuardianObserver: { enabled: observerEnabled.checked === true, port: port || OBSERVER_DEFAULT_PORT }
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
