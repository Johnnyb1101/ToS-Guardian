'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { AsyncLocalStorage } = require('async_hooks');
const { usageRecordFromProxyResponse, applyProxyOverride } = require('./batch-lib');

const EXTENSION_FILES = Object.freeze([
  'vendor/tldts-7.4.8.umd.min.js', 'tosUtils.js', 'evaluator.js', 'critic.js',
  'siteDatabase.js', 'episode.js', 'community.js', 'orchestrator.js', 'background.js'
]);

const DIRECT_FETCH_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
});

function newRunState() {
  return { controller: new AbortController(), usage: [], llmCalls: 0, logs: [], lastResult: null, events: [], analyses: [], critics: [], communityReports: [] };
}

function createPipelineHost(options) {
  const opts = Object.assign({
    proxyUrl: null,
    cache: false,
    write: false,
    critic: true,
    escalate: false,
    storage: {},
    onLog: null,
    repoRoot: path.resolve(__dirname, '..')
  }, options || {});
  if (typeof opts.proxyUrl !== 'string' || !/^https?:\/\//.test(opts.proxyUrl)) {
    throw new Error('createPipelineHost needs an explicit http(s) proxyUrl');
  }

  const runState = new AsyncLocalStorage();
  const realFetch = globalThis.fetch;
  const analyzeUrl = `${opts.proxyUrl}/v2/analyze`;

  async function trackedFetch(url, fetchOptions) {
    const target = String(url);
    const state = runState.getStore();
    const finalOptions = { ...(fetchOptions || {}) };
    if (state && state.controller && !finalOptions.signal) finalOptions.signal = state.controller.signal;
    if (target !== analyzeUrl) return realFetch(url, finalOptions);
    if (state) state.llmCalls++;
    const response = await realFetch(url, finalOptions);
    const data = await response.json().catch(() => ({}));
    if (state && response.ok) {
      const record = usageRecordFromProxyResponse(data);
      if (record) state.usage.push(record);
    }
    // analyzeWithModel and runCritic read only ok, status, and json from a response
    return { ok: response.ok, status: response.status, json: async () => data };
  }

  async function directFetch(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const state = runState.getStore();
    const abortFromRun = () => controller.abort();
    if (state && state.controller) {
      if (state.controller.signal.aborted) controller.abort();
      else state.controller.signal.addEventListener('abort', abortFromRun, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await realFetch(url, { signal: controller.signal, redirect: 'follow', headers: DIRECT_FETCH_HEADERS });
      if (!response.ok) return null;
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      // null sends the fetcher to the proxy, which extracts PDFs server-side
      if (contentType.includes('pdf') || /\.pdf([#?].*)?$/i.test(url)) return null;
      if (contentType && !contentType.includes('html') && !contentType.startsWith('text/')) return null;
      const html = await response.text();
      return html ? { html, text: null } : null;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
      if (state && state.controller) state.controller.signal.removeEventListener('abort', abortFromRun);
    }
  }

  const storageData = Object.assign({
    selectedProvider: 'anthropic',
    tosGuardianDebug: true,
    tosGuardianObserver: { enabled: true, port: 0 }
  }, opts.storage);
  if (!opts.escalate) {
    // a pre-exhausted cap is the only way to keep the orchestrator off Opus
    storageData.opusEscalationData = { count: 5, resetAt: Date.now() + 365 * 24 * 60 * 60 * 1000 };
  }

  const storage = {
    get(keys, callback) {
      const result = {};
      const addKey = key => { result[key] = storageData[key]; };
      if (Array.isArray(keys)) keys.forEach(addKey);
      else if (typeof keys === 'string') addKey(keys);
      else if (keys && typeof keys === 'object') {
        for (const [key, defaultValue] of Object.entries(keys)) {
          result[key] = Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : defaultValue;
        }
      } else Object.assign(result, storageData);
      if (callback) callback(result);
      return Promise.resolve(result);
    },
    set(items, callback) {
      const state = runState.getStore();
      const storedItems = { ...items };
      if (state && Object.prototype.hasOwnProperty.call(storedItems, 'tosGuardianLastResult')) {
        state.lastResult = storedItems.tosGuardianLastResult;
        delete storedItems.tosGuardianLastResult;
      }
      Object.assign(storageData, storedItems);
      if (callback) callback();
      return Promise.resolve();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
      if (callback) callback();
      return Promise.resolve();
    }
  };

  function logLine(level, args) {
    const line = `[${level}] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const state = runState.getStore();
    if (state) state.logs.push(line);
    if (typeof opts.onLog === 'function') opts.onLog(line);
  }

  const context = {
    console: {
      log: (...a) => logLine('log', a),
      warn: (...a) => logLine('warn', a),
      error: (...a) => logLine('error', a)
    },
    URL,
    Date,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: trackedFetch,
    importScripts: () => {},
    chrome: undefined,
    browser: {
      storage: { local: storage },
      tabs: {},
      runtime: { onMessage: { addListener: () => {} }, lastError: null }
    }
  };
  vm.createContext(context);

  for (const file of EXTENSION_FILES) {
    let source = fs.readFileSync(path.join(opts.repoRoot, file), 'utf8');
    if (file === 'background.js') source = applyProxyOverride(source, opts.proxyUrl);
    vm.runInContext(source, context, { filename: file });
  }

  // function declarations in the extension files land on the context global, so
  // assigning here replaces them for every caller inside the pipeline
  context.fetchWithHiddenTab = async (url, { minLength = 500 } = {}) => {
    const fetched = await directFetch(url);
    if (!fetched) return null;
    const text = context.stripHtml(fetched.html);
    // a real hidden tab never resolves with minLength characters or fewer
    if (!text || text.length <= minLength) return null;
    return { text, html: fetched.html };
  };

  context.observerSink = (event) => {
    const state = runState.getStore();
    if (state) state.events.push(event);
  };

  context.sendCommunityReport = (report) => {
    const state = runState.getStore();
    if (state) state.communityReports.push(report);
  };

  // the orchestrator rewrites the returned objects in place, so capture copies
  const realAnalyzeWithModel = context.analyzeWithModel;
  context.analyzeWithModel = async (...args) => {
    const result = await realAnalyzeWithModel(...args);
    const state = runState.getStore();
    if (state) state.analyses.push({ escalated: args[2] === true, result: result && typeof result === 'object' ? { ...result } : result });
    return result;
  };
  const realRunCritic = context.runCritic;
  context.runCritic = async (...args) => {
    const result = await realRunCritic(...args);
    const state = runState.getStore();
    if (state) state.critics.push(result && typeof result === 'object' ? { ...result } : result);
    return result;
  };

  if (!opts.cache) context.readFromSupabase = async () => null;
  if (!opts.write) {
    context.writeToSupabase = async () => null;
    context.learnSite = async () => null;
  }
  if (!opts.critic) context.runCritic = async () => null;

  return {
    context,
    runState,
    storageData,
    analyzeUrl,
    directFetch,
    newRunState,
    run(state, fn) { return runState.run(state, fn); }
  };
}

function withTimeout(promise, ms, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sitesFromInputs(inputs, onWarn) {
  const toDomain = (entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
    } catch (e) {
      if (onWarn) onWarn(`Skipping unparseable entry: ${trimmed}`);
      return null;
    }
  };
  const sites = [];
  const seen = new Set();
  const add = (domain, type) => {
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    sites.push({ domain, type: type || null });
  };
  for (const input of inputs) {
    if (fs.existsSync(input) && fs.statSync(input).isFile()) {
      let currentType = null;
      for (const rawLine of fs.readFileSync(input, 'utf8').split(/\r?\n/)) {
        const typeHeader = rawLine.match(/^\s*#\s*type:\s*([a-z][a-z-]*)\s*$/i);
        if (typeHeader) { currentType = typeHeader[1].toLowerCase(); continue; }
        const entry = rawLine.replace(/#.*$/, '').trim();
        if (entry) add(toDomain(entry), currentType);
      }
    } else {
      add(toDomain(input), null);
    }
  }
  return sites;
}

function domainsFromInputs(inputs, onWarn) {
  return sitesFromInputs(inputs, onWarn).map(site => site.domain);
}

module.exports = { EXTENSION_FILES, createPipelineHost, newRunState, withTimeout, sitesFromInputs, domainsFromInputs };
