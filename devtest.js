// TOS Guardian — Dev Test Recorder (manual). Dev/test only.
// Reads the verdict the orchestrator mirrors to chrome.storage.local
// (tosGuardianLastResult, written only when tosGuardianDebug is true) and
// lets you step through a pasted site list and export results as JSON.
// No browser automation — you navigate and trigger overlays yourself.

const browser = globalThis.browser || chrome;
const RESULTS_KEY = 'tosGuardianTestRecorder';
const LAST_KEY = 'tosGuardianLastResult';
const DEBUG_KEY = 'tosGuardianDebug';

const $ = (id) => document.getElementById(id);

let sites = [];        // [{ name, url }]
let idx = 0;           // current stepper index
let results = [];      // captured rows
let capturedStamps = new Set(); // timestamps already captured (dedupe)

// ---- storage helpers (promise wrappers) ----
const getLocal = (keys) => new Promise((res) => browser.storage.local.get(keys, res));
const setLocal = (obj) => new Promise((res) => browser.storage.local.set(obj, res));
const removeLocal = (keys) => new Promise((res) => browser.storage.local.remove(keys, res));

// ---- site list parsing ----
// "Reddit https://www.reddit.com/"  |  "Discord, https://discord.com/"  |  "Dropbox"
function parseSites(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(.*?)[\s,]+(https?:\/\/\S+)\s*$/i);
    if (m) return { name: m[1].trim() || m[2], url: m[2].trim() };
    if (/^https?:\/\//i.test(line)) {
      let host = line;
      try { host = new URL(line).hostname.replace(/^www\./, ''); } catch (e) {}
      return { name: host, url: line };
    }
    return { name: line, url: '' };
  });
}

// ---- rendering ----
function renderDebug(on) {
  const el = $('debug-status');
  el.textContent = on ? 'ON' : 'OFF';
  el.className = 'pill ' + (on ? 'on' : 'off');
}

function renderStepper() {
  if (!sites.length) {
    $('step-name').textContent = '—';
    $('step-pos').textContent = '(no list loaded — captures tag as "(unassigned)")';
    $('step-url').textContent = '';
    $('step-url').removeAttribute('href');
    return;
  }
  if (idx < 0) idx = 0;
  if (idx > sites.length - 1) idx = sites.length - 1;
  const s = sites[idx];
  $('step-name').textContent = s.name;
  $('step-pos').textContent = `(${idx + 1} / ${sites.length})`;
  const a = $('step-url');
  if (s.url) { a.textContent = s.url; a.href = s.url; }
  else { a.textContent = '(no URL given — navigate manually)'; a.removeAttribute('href'); }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTable() {
  $('result-count').textContent = results.length;
  const body = $('results-body');
  if (!results.length) {
    body.innerHTML = '<tr><td colspan="10" class="muted">No results captured yet.</td></tr>';
    return;
  }
  body.innerHTML = results.map((r, i) => {
    const label = r.label || '';
    const cached = r.cached === true ? 'cached' : r.cached === false ? 'fresh' : '—';
    const issues = (r.issues || []).join('; ');
    const links = (r.optOutLinks || [])
      .map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`).join('');
    return `<tr>
      <td>${i + 1}</td>
      <td>${esc(r.site)}</td>
      <td>${esc(r.url || r.analyzedUrl || '')}</td>
      <td>${r.score == null ? '—' : esc(r.score)}</td>
      <td class="label-${esc(label)}">${esc(label || '—')}</td>
      <td>${cached}</td>
      <td>${esc(r.warning || '')}</td>
      <td>${esc(issues)}</td>
      <td class="links">${links || '<span class="muted">—</span>'}</td>
      <td>${esc(r.timestamp ? new Date(r.timestamp).toLocaleString() : '')}</td>
    </tr>`;
  }).join('');
}

async function persistResults() {
  await setLocal({ [RESULTS_KEY]: results });
}

async function clearLatestResult(message = 'Cleared latest result marker.') {
  await removeLocal(LAST_KEY);
  capturedStamps = new Set(results.map((r) => r.timestamp).filter(Boolean));
  $('latest-info').textContent = message;
}

// ---- capture ----
function buildRow(latest) {
  const site = sites[idx] || { name: '(unassigned)', url: '' };
  return {
    site: site.name,
    url: site.url || latest.url || '',
    analyzedUrl: latest.url || '',
    domain: latest.domain || '',
    score: latest.score == null ? null : latest.score,
    label: latest.label || null,
    warning: latest.warning || null,
    issues: latest.issues || [],
    optOutLinks: latest.optOutLinks || [],
    cached: typeof latest.cached === 'boolean' ? latest.cached : null,
    timestamp: latest.timestamp || Date.now(),
  };
}

async function captureLatest(advance) {
  const data = await getLocal(LAST_KEY);
  const latest = data[LAST_KEY];
  if (!latest) {
    $('latest-info').textContent = 'No tosGuardianLastResult in storage yet — trigger an overlay first.';
    return false;
  }
  if (capturedStamps.has(latest.timestamp)) {
    $('latest-info').textContent = 'Latest result already captured (same timestamp).';
    return false;
  }
  capturedStamps.add(latest.timestamp);
  results.push(buildRow(latest));
  await persistResults();
  renderTable();
  $('latest-info').textContent = `Captured: ${latest.label || '—'} ${latest.score == null ? '' : latest.score}`;
  if (advance && idx < sites.length - 1) { idx++; renderStepper(); }
  return true;
}

// ---- export ----
function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    count: results.length,
    results,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `tos-guardian-results-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- wire up ----
$('load-list').addEventListener('click', async () => {
  sites = parseSites($('site-input').value);
  idx = 0;
  $('list-count').textContent = `${sites.length} site(s) loaded`;
  renderStepper();
  await clearLatestResult('List loaded. Latest result marker cleared; trigger the next overlay.');
});
$('prev').addEventListener('click', () => { idx--; renderStepper(); });
$('next').addEventListener('click', () => { idx++; renderStepper(); });
$('capture-now').addEventListener('click', () => captureLatest(false));
$('clear-latest').addEventListener('click', () => clearLatestResult());
$('export').addEventListener('click', exportJson);
$('clear').addEventListener('click', async () => {
  results = [];
  capturedStamps = new Set();
  await persistResults();
  renderTable();
});
$('enable-debug').addEventListener('click', async () => { await setLocal({ [DEBUG_KEY]: true }); renderDebug(true); });
$('disable-debug').addEventListener('click', async () => { await setLocal({ [DEBUG_KEY]: false }); renderDebug(false); });

// Auto-capture: when the orchestrator writes a new verdict, grab it.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[LAST_KEY] && $('auto-capture').checked) {
    captureLatest(true);
  }
});

// ---- init ----
(async () => {
  // Dev page: turn capture on by default so results flow without extra clicks.
  const data = await getLocal([DEBUG_KEY, RESULTS_KEY]);
  let on = data[DEBUG_KEY];
  if (on === undefined) { await setLocal({ [DEBUG_KEY]: true }); on = true; }
  renderDebug(!!on);
  results = Array.isArray(data[RESULTS_KEY]) ? data[RESULTS_KEY] : [];
  results.forEach((r) => { if (r.timestamp) capturedStamps.add(r.timestamp); });
  renderStepper();
  renderTable();
})();
