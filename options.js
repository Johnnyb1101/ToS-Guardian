const browser = globalThis.browser || chrome;

const providerSelect = document.getElementById('providerSelect');
const cloudField = document.getElementById('cloudField');
const ollamaField = document.getElementById('ollamaField');
const ollamaUrl = document.getElementById('ollamaUrl');
const saveBtn = document.getElementById('saveBtn');
const statusMsg = document.getElementById('statusMsg');
const observerEnabled = document.getElementById('observerEnabled');
const observerPort = document.getElementById('observerPort');
const observerStatus = document.getElementById('observerStatus');
const communityEnabled = document.getElementById('communityEnabled');
const communityStatus = document.getElementById('communityStatus');

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

function describeObserver(enabled, port) {
  return enabled
    ? `Observer mode is on — posting to 127.0.0.1:${port}. Reload open tabs to observe them.`
    : 'Observer mode is off.';
}

// The observer toggle saves itself on change. It sits in its own card, away
// from the provider Save button, so it must not depend on that button.
function saveObserver() {
  const port = parsePort(observerPort.value);
  if (observerEnabled.checked && !port) {
    observerStatus.textContent = 'Collector port must be a number between 1 and 65535.';
    observerStatus.className = 'status error';
    return;
  }
  const setting = { enabled: observerEnabled.checked === true, port: port || OBSERVER_DEFAULT_PORT };
  browser.storage.local.set({ tosGuardianObserver: setting }, () => {
    if (browser.runtime.lastError) {
      observerStatus.textContent = `Could not save: ${browser.runtime.lastError.message}`;
      observerStatus.className = 'status error';
      return;
    }
    observerStatus.textContent = `✓ Saved. ${describeObserver(setting.enabled, setting.port)}`;
    observerStatus.className = 'status';
  });
}

function describeCommunity(enabled) {
  return enabled ? 'Community reports are on.' : 'Community reports are off.';
}

function saveCommunity() {
  const setting = { enabled: communityEnabled.checked === true, decided: true };
  browser.storage.local.set({ tosGuardianCommunity: setting }, () => {
    if (browser.runtime.lastError) {
      communityStatus.textContent = `Could not save: ${browser.runtime.lastError.message}`;
      communityStatus.className = 'status error';
      return;
    }
    communityStatus.textContent = `✓ Saved. ${describeCommunity(setting.enabled)}`;
    communityStatus.className = 'status';
  });
}

// Load saved settings into the form on page open
function loadSettings() {
  browser.storage.local.get(['selectedProvider', 'ollamaBaseUrl', 'tosGuardianObserver', 'tosGuardianCommunity'], (result) => {
    providerSelect.value = result.selectedProvider || 'anthropic';
    ollamaUrl.value      = result.ollamaBaseUrl    || 'http://localhost:11434';
    const community = result.tosGuardianCommunity || {};
    communityEnabled.checked = community.enabled === true;
    communityStatus.textContent = describeCommunity(communityEnabled.checked);
    communityStatus.className = 'status';
    const observer = result.tosGuardianObserver || {};
    observerEnabled.checked = observer.enabled === true;
    observerPort.value = String(parsePort(observer.port) || OBSERVER_DEFAULT_PORT);
    observerStatus.textContent = describeObserver(observerEnabled.checked, observerPort.value);
    observerStatus.className = 'status';
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
observerEnabled.addEventListener('change', saveObserver);
communityEnabled.addEventListener('change', saveCommunity);
observerPort.addEventListener('change', saveObserver);

loadSettings();
