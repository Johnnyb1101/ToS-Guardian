// TOS Guardian — Episode schema (learning loop, phase 0)
//
// One EPISODE is the structured record of one run of the pipeline for one
// site: what fired, what was fetched, what the cache did, what the models
// said, how it was scored, what rendered. It is the unit the learning loop
// reflects on. Producers: the extension in observer mode (live) and
// tools/batch-runner.js (headless). Consumers: tools/observer.js (collector),
// tools/report.js, and later the trainer. All of them load THIS file, so there
// is exactly one definition of what an episode is.
//
// Loaded two ways: importScripts() in the background service worker (globals)
// and require() in Node (module.exports). Dependency-free on purpose.
//
// Two layers, by design:
//   - `data` on each event is the UPLOADABLE layer: enums, counts, hashes,
//     booleans, and public legal-document URLs. Every key is on a per-stage
//     allowlist and anything else is rejected.
//   - `local` on each event is the LOCAL-ONLY layer: page URL, raw button
//     label, user action, model-authored text. It never leaves the machine:
//     stripLocal() removes it, and validateEpisode(..., { uploadable: true })
//     refuses any record that still carries it or any forbidden key.
// Observer mode is off by default; with it off, no event is ever created.

const EPISODE_SCHEMA_VERSION = 1;
const OBSERVER_DEFAULT_PORT = 3123;
const EPISODE_ID_PATTERN = /^[0-9a-f]{16}$/;

const EPISODE_STAGES = Object.freeze([
  'trigger', 'relay', 'fetch', 'cache', 'scan', 'links', 'analyze',
  'critic', 'evaluate', 'escalate', 'verdict', 'write', 'render', 'end'
]);

const CRITIC_FIELD_NAMES = Object.freeze([
  'dataCollection', 'dataSelling', 'optOutRights', 'howToOptOut', 'autoRenewal', 'dataDeletion'
]);
const CRITIC_VERDICT_VALUES = Object.freeze(['grounded', 'unsupported', 'vague', 'skipped']);

const MAX_SHORT_STRING = 200;
const MAX_STRING_LIST = 40;
const MAX_URL_LIST = 20;
const MAX_URL_CHARS = 2048;
const MAX_LOCAL_STRING = 2048;

const ANALYZE_STATUS = 'enum:ok|config|busy|rate-limited|daily-limit|error|empty';
const LABELS = 'enum:Strong|Adequate|Failed';
const RISKS = 'enum:Low|Moderate|High|Unknown';

// Per-stage allowlist of uploadable fields with their type tags. Every field
// is optional; an unknown field is an error. Tags: bool, int, num, str (short),
// strs (short list), url list `urls`, `domain`, `hex8`, `hex16`, `usage`,
// `verdicts`, and `enum:a|b|c`.
const STAGE_FIELDS = Object.freeze({
  trigger: {
    source: 'enum:click|submit|enter|pending-reshow|popup|batch|replay',
    branch: 'str',
    controlTag: 'enum:button|a|input|form|textarea|body|other',
    authForm: 'bool', passwordField: 'bool', knownDomain: 'bool', frame: 'bool'
  },
  relay: {
    domain: 'domain',
    siteLookup: 'enum:static|learned|none',
    deduped: 'bool', joinedEpisodeId: 'hex16',
    mode: 'enum:live|batch|replay',
    sample: 'int'
  },
  fetch: {
    path: 'enum:known-urls|page-links|link-text|homepage-footer|candidates|page-text|frozen|none|unknown',
    tosFound: 'bool', privacyFound: 'bool', supplementalCount: 'int',
    textChars: 'int', textHash: 'hex8', looksLegal: 'bool', unreadablePdfCount: 'int',
    documentUrls: 'urls', hiddenTabHits: 'int', proxyHits: 'int', attempts: 'int', retried: 'bool'
  },
  cache: {
    read: 'enum:hit|miss|skipped|stale-schema|stale-fingerprint|quality-reject|error',
    similarity: 'num'
  },
  scan: { injection: 'bool' },
  links: { candidates: 'int', followed: 'int', displayed: 'int' },
  analyze: {
    provider: 'enum:anthropic|openai|ollama|unknown', model: 'str', escalated: 'bool',
    inputChars: 'int', stopReason: 'str', usage: 'usage', status: ANALYZE_STATUS,
    receipt: 'bool', summaryHash: 'hex8', retried: 'bool'
  },
  critic: {
    ran: 'bool', failed: 'bool', reason: 'str', verdicts: 'verdicts',
    flagCount: 'int', adjustmentCount: 'int', receipt: 'bool',
    model: 'str', stopReason: 'str', usage: 'usage'
  },
  evaluate: {
    score: 'int', label: LABELS, issues: 'strs', contradictions: 'int',
    thinSourceCap: 'bool', criticCap: 'bool', escalate: 'bool'
  },
  escalate: {
    attempted: 'bool', capReached: 'bool', model: 'str', stopReason: 'str', usage: 'usage',
    status: ANALYZE_STATUS, score: 'int', label: LABELS, accepted: 'bool',
    reason: 'enum:higher-score|conservative-grounding|not-better|cap|not-needed|failed',
    criticRan: 'bool', criticFailed: 'bool', criticConcerns: 'int'
  },
  verdict: {
    risk: RISKS, label: 'enum:Strong|Adequate|Failed|Cached|Configuration|Error',
    score: 'int', retrievalFailure: 'bool', cached: 'bool', optOutLinks: 'int', unreadableDocs: 'int'
  },
  write: {
    attempted: 'bool',
    result: 'enum:written|skipped-quality|skipped-no-provenance|blocked|rate-limited|failed|error',
    category: 'str'
  },
  render: {
    shown: 'bool', sections: 'int', optOutLinksShown: 'int', unreadableShown: 'int',
    risk: RISKS, confidenceLabel: LABELS, error: 'enum:timeout|channel|none', retry: 'bool'
  },
  end: { durationMs: 'int', ok: 'bool' }
});

// Local-only layer. Bounded so a runaway value cannot bloat the log, but free
// text is allowed here because it never leaves the machine.
const LOCAL_FIELDS = Object.freeze({
  pageUrl: 'local-str', controlLabel: 'local-str', userAction: 'enum:accept|back',
  flagsText: 'local-strs', bottomLine: 'local-str', note: 'local-str'
});

// Keys that must never appear anywhere in an uploadable record, checked
// recursively as a belt-and-braces guard behind the allowlist. Every
// local-layer field name is here, plus names that would only ever carry
// content or identity. (`label` alone is not banned: it is the evaluator's
// verdict label, which is why the button text is called `controlLabel`.)
const FORBIDDEN_UPLOAD_KEYS = Object.freeze([
  'text', 'html', 'pageUrl', 'controlLabel', 'userAction', 'flagsText', 'bottomLine', 'note',
  'title', 'email', 'ip', 'userId', 'installId', 'sessionId', 'cookie', 'token',
  'analysisReceipt', 'writeReceipt', 'summary', 'local'
]);

function newEpisodeId() {
  const bytes = new Uint8Array(8);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function isEpisodeId(value) {
  return typeof value === 'string' && EPISODE_ID_PATTERN.test(value);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Read the observer setting from a chrome.storage.local-like object. Off
// unless explicitly enabled; a bad or missing port falls back to the default.
// Shared by the orchestrator and the message boundary so both read it the
// same way. Never throws.
async function readObserverConfig(storageLocal) {
  try {
    if (!storageLocal || typeof storageLocal.get !== 'function') return { enabled: false };
    const stored = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value || {}); } };
      const maybe = storageLocal.get('tosGuardianObserver', done);
      if (maybe && typeof maybe.then === 'function') maybe.then(done, () => done({}));
    });
    const cfg = stored && stored.tosGuardianObserver;
    if (!isPlainObject(cfg) || cfg.enabled !== true) return { enabled: false };
    const port = Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536 ? cfg.port : OBSERVER_DEFAULT_PORT;
    return { enabled: true, port };
  } catch (e) {
    return { enabled: false };
  }
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateUrlValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.username || parsed.password) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// Validate one field value against a type tag. Returns null when valid or an
// error string when not.
function checkField(tag, value, key) {
  if (tag.startsWith('enum:')) {
    const allowed = tag.slice(5).split('|');
    return allowed.includes(value) ? null : `${key} must be one of ${allowed.join(', ')}`;
  }
  switch (tag) {
    case 'bool':
      return typeof value === 'boolean' ? null : `${key} must be a boolean`;
    case 'int':
      return isNonNegativeInt(value) ? null : `${key} must be a non-negative integer`;
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${key} must be a finite number`;
    case 'str':
      return typeof value === 'string' && value.length <= MAX_SHORT_STRING ? null : `${key} must be a string of at most ${MAX_SHORT_STRING} chars`;
    case 'local-str':
      return typeof value === 'string' && value.length <= MAX_LOCAL_STRING ? null : `${key} must be a string of at most ${MAX_LOCAL_STRING} chars`;
    case 'strs':
      if (!Array.isArray(value) || value.length > MAX_STRING_LIST) return `${key} must be a list of at most ${MAX_STRING_LIST} strings`;
      return value.every(v => typeof v === 'string' && v.length <= MAX_SHORT_STRING) ? null : `${key} entries must be strings of at most ${MAX_SHORT_STRING} chars`;
    case 'local-strs':
      if (!Array.isArray(value) || value.length > MAX_STRING_LIST) return `${key} must be a list of at most ${MAX_STRING_LIST} strings`;
      return value.every(v => typeof v === 'string' && v.length <= MAX_LOCAL_STRING) ? null : `${key} entries must be strings`;
    case 'urls':
      if (!Array.isArray(value) || value.length > MAX_URL_LIST) return `${key} must be a list of at most ${MAX_URL_LIST} URLs`;
      return value.every(validateUrlValue) ? null : `${key} entries must be http(s) URLs without credentials`;
    case 'domain':
      return typeof value === 'string' && value.length > 0 && value.length <= 253 && /^[a-z0-9.-]+$/.test(value)
        ? null : `${key} must be a lowercase registrable domain`;
    case 'hex8':
      return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value) ? null : `${key} must be 8 hex chars`;
    case 'hex16':
      return isEpisodeId(value) ? null : `${key} must be 16 hex chars`;
    case 'usage': {
      if (!isPlainObject(value)) return `${key} must be an object`;
      const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
      for (const k of Object.keys(value)) if (!keys.includes(k)) return `${key}.${k} is not a usage field`;
      for (const k of keys) if (value[k] !== undefined && !isNonNegativeInt(value[k])) return `${key}.${k} must be a non-negative integer`;
      return null;
    }
    case 'verdicts': {
      if (!isPlainObject(value)) return `${key} must be an object`;
      for (const k of Object.keys(value)) {
        if (!CRITIC_FIELD_NAMES.includes(k)) return `${key}.${k} is not a critic field`;
        if (!CRITIC_VERDICT_VALUES.includes(value[k])) return `${key}.${k} must be a critic verdict`;
      }
      return null;
    }
    default:
      return `${key} has an unknown type tag ${tag}`;
  }
}

function validateAgainst(spec, data, prefix) {
  const errors = [];
  if (!isPlainObject(data)) return [`${prefix} must be an object`];
  for (const key of Object.keys(data)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) {
      errors.push(`${prefix}.${key} is not an allowed field`);
      continue;
    }
    if (data[key] === undefined) continue;
    const err = checkField(spec[key], data[key], `${prefix}.${key}`);
    if (err) errors.push(err);
  }
  return errors;
}

function validateEventData(stage, data) {
  if (!EPISODE_STAGES.includes(stage)) return { valid: false, errors: [`unknown stage ${String(stage)}`] };
  const errors = validateAgainst(STAGE_FIELDS[stage], data, stage);
  return { valid: errors.length === 0, errors };
}

function validateLocal(local) {
  if (local === undefined) return { valid: true, errors: [] };
  const errors = validateAgainst(LOCAL_FIELDS, local, 'local');
  return { valid: errors.length === 0, errors };
}

function validateEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) return { valid: false, errors: ['event must be an object'] };
  if (event.v !== EPISODE_SCHEMA_VERSION) errors.push(`event.v must be ${EPISODE_SCHEMA_VERSION}`);
  if (!isEpisodeId(event.episodeId)) errors.push('event.episodeId must be 16 hex chars');
  if (!Number.isFinite(event.ts) || event.ts <= 0) errors.push('event.ts must be a positive timestamp');
  if (event.seq !== undefined && !isNonNegativeInt(event.seq)) errors.push('event.seq must be a non-negative integer');
  for (const key of Object.keys(event)) {
    if (!['v', 'episodeId', 'stage', 'ts', 'seq', 'data', 'local'].includes(key)) errors.push(`event.${key} is not an allowed field`);
  }
  const dataResult = validateEventData(event.stage, event.data);
  errors.push(...dataResult.errors);
  const localResult = validateLocal(event.local);
  errors.push(...localResult.errors);
  return { valid: errors.length === 0, errors };
}

// Drop undefined values so callers can pass `maybe: value || undefined`.
function compact(obj) {
  const out = {};
  for (const key of Object.keys(obj || {})) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

function createEvent(episodeId, stage, data, options) {
  const opts = options || {};
  const event = {
    v: EPISODE_SCHEMA_VERSION,
    episodeId,
    stage,
    ts: typeof opts.now === 'number' ? opts.now : Date.now(),
    data: compact(data)
  };
  if (isNonNegativeInt(opts.seq)) event.seq = opts.seq;
  if (opts.local && isPlainObject(opts.local)) {
    const local = compact(opts.local);
    if (Object.keys(local).length > 0) event.local = local;
  }
  return event;
}

// The recorder is what the pipeline calls. With `enabled` false it does
// nothing at all, which is the behavior of every install by default. An
// invalid event is reported through `onInvalid` and dropped: instrumentation
// bugs must never break, slow, or change an analysis.
function createEpisodeRecorder(options) {
  const opts = options || {};
  const enabled = opts.enabled === true;
  const id = isEpisodeId(opts.episodeId) ? opts.episodeId : newEpisodeId();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sink = typeof opts.sink === 'function' ? opts.sink : null;
  const onInvalid = typeof opts.onInvalid === 'function' ? opts.onInvalid : null;
  const events = [];
  let seq = 0;

  function record(stage, data, local) {
    if (!enabled) return null;
    const event = createEvent(id, stage, data, { now: now(), seq: seq++, local });
    const check = validateEvent(event);
    if (!check.valid) {
      if (onInvalid) { try { onInvalid(stage, check.errors); } catch (e) { /* never surface */ } }
      return null;
    }
    events.push(event);
    if (sink) { try { sink(event); } catch (e) { /* never surface */ } }
    return event;
  }

  return { id, enabled, events, record };
}

// Merge a stream of events into one episode record per episodeId. Later
// events for the same stage merge over earlier ones, so a stage may be
// recorded incrementally. Returns episodes in order of first appearance.
function assembleEpisodes(events) {
  const byId = new Map();
  for (const event of events || []) {
    if (!isPlainObject(event) || !isEpisodeId(event.episodeId)) continue;
    let episode = byId.get(event.episodeId);
    if (!episode) {
      episode = {
        v: EPISODE_SCHEMA_VERSION,
        episodeId: event.episodeId,
        startedAt: null,
        endedAt: null,
        durationMs: 0,
        mode: 'live',
        domain: null,
        stages: {},
        timeline: [],
        eventCount: 0
      };
      byId.set(event.episodeId, episode);
    }
    const ts = Number.isFinite(event.ts) ? event.ts : 0;
    if (episode.startedAt === null || ts < episode.startedAt) episode.startedAt = ts;
    if (episode.endedAt === null || ts > episode.endedAt) episode.endedAt = ts;
    episode.eventCount++;
    episode.timeline.push({ stage: event.stage, ts });
    if (EPISODE_STAGES.includes(event.stage)) {
      episode.stages[event.stage] = Object.assign(episode.stages[event.stage] || {}, compact(event.data));
      if (event.local && isPlainObject(event.local)) {
        if (!episode.local) episode.local = {};
        episode.local[event.stage] = Object.assign(episode.local[event.stage] || {}, compact(event.local));
      }
    }
  }
  const episodes = [];
  for (const episode of byId.values()) {
    episode.timeline.sort((a, b) => a.ts - b.ts);
    episode.durationMs = Math.max(0, (episode.endedAt || 0) - (episode.startedAt || 0));
    if (episode.stages.end && isNonNegativeInt(episode.stages.end.durationMs)) episode.durationMs = episode.stages.end.durationMs;
    episode.startedAt = episode.startedAt === null ? null : new Date(episode.startedAt).toISOString();
    episode.endedAt = episode.endedAt === null ? null : new Date(episode.endedAt).toISOString();
    const relay = episode.stages.relay || {};
    const trigger = episode.stages.trigger || {};
    episode.mode = relay.mode || (trigger.source === 'batch' ? 'batch' : 'live');
    episode.domain = typeof relay.domain === 'string' ? relay.domain : null;
    episodes.push(episode);
  }
  return episodes;
}

function assembleEpisode(events) {
  const episodes = assembleEpisodes(events);
  return episodes.length > 0 ? episodes[0] : null;
}

function findForbiddenKeys(value, pathPrefix, found) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${pathPrefix}[${index}]`, found));
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_UPLOAD_KEYS.includes(key)) found.push(`${pathPrefix}.${key}`);
      findForbiddenKeys(value[key], `${pathPrefix}.${key}`, found);
    }
  }
}

// Validate an assembled episode. With `uploadable` set, also enforce the
// zero-user-data rule: no local layer, no timestamps finer than a day, no
// query strings on URLs, and no forbidden key anywhere in the record.
function validateEpisode(episode, options) {
  const uploadable = !!(options && options.uploadable);
  const errors = [];
  if (!isPlainObject(episode)) return { valid: false, errors: ['episode must be an object'] };
  if (episode.v !== EPISODE_SCHEMA_VERSION) errors.push(`episode.v must be ${EPISODE_SCHEMA_VERSION}`);
  if (!isEpisodeId(episode.episodeId)) errors.push('episode.episodeId must be 16 hex chars');
  if (!isPlainObject(episode.stages)) errors.push('episode.stages must be an object');
  else {
    for (const stage of Object.keys(episode.stages)) {
      const result = validateEventData(stage, episode.stages[stage]);
      errors.push(...result.errors);
    }
  }
  if (!['live', 'batch', 'replay'].includes(episode.mode)) errors.push('episode.mode must be live, batch, or replay');
  if (episode.local !== undefined) {
    if (!isPlainObject(episode.local)) errors.push('episode.local must be an object');
    else for (const stage of Object.keys(episode.local)) errors.push(...validateLocal(episode.local[stage]).errors);
  }
  if (uploadable) {
    if (episode.local !== undefined) errors.push('uploadable episode must not carry a local layer');
    if (episode.startedAt !== undefined || episode.endedAt !== undefined || episode.timeline !== undefined) {
      errors.push('uploadable episode must not carry timestamps finer than a day');
    }
    if (typeof episode.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(episode.day)) errors.push('uploadable episode must carry a day stamp');
    const urls = episode.stages && episode.stages.fetch && episode.stages.fetch.documentUrls;
    if (Array.isArray(urls)) {
      for (const url of urls) if (/[?#]/.test(url)) errors.push(`uploadable documentUrls must not carry a query or fragment: ${url}`);
    }
    const forbidden = [];
    findForbiddenKeys(episode, 'episode', forbidden);
    for (const hit of forbidden) errors.push(`forbidden key in uploadable episode: ${hit}`);
  }
  return { valid: errors.length === 0, errors };
}

function stripUrlQuery(url) {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch (e) {
    return null;
  }
}

// Produce the uploadable form of an episode: a deep copy with the local
// layer and fine timestamps removed, URLs reduced to path only, and every
// stage re-filtered through its allowlist.
function stripLocal(episode) {
  if (!isPlainObject(episode)) return null;
  const copy = JSON.parse(JSON.stringify(episode));
  delete copy.local;
  const day = typeof copy.startedAt === 'string' ? copy.startedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  delete copy.startedAt;
  delete copy.endedAt;
  delete copy.timeline;
  copy.day = day;
  const stages = {};
  for (const stage of Object.keys(copy.stages || {})) {
    if (!EPISODE_STAGES.includes(stage)) continue;
    const spec = STAGE_FIELDS[stage];
    const filtered = {};
    for (const key of Object.keys(copy.stages[stage] || {})) {
      if (Object.prototype.hasOwnProperty.call(spec, key)) filtered[key] = copy.stages[stage][key];
    }
    if (stage === 'fetch' && Array.isArray(filtered.documentUrls)) {
      filtered.documentUrls = filtered.documentUrls.map(stripUrlQuery).filter(Boolean);
    }
    stages[stage] = filtered;
  }
  copy.stages = stages;
  return copy;
}

const EpisodeSchema = {
  EPISODE_SCHEMA_VERSION,
  OBSERVER_DEFAULT_PORT,
  EPISODE_STAGES,
  STAGE_FIELDS,
  LOCAL_FIELDS,
  FORBIDDEN_UPLOAD_KEYS,
  CRITIC_FIELD_NAMES,
  newEpisodeId,
  isEpisodeId,
  readObserverConfig,
  validateEventData,
  validateLocal,
  validateEvent,
  createEvent,
  createEpisodeRecorder,
  assembleEpisodes,
  assembleEpisode,
  validateEpisode,
  stripLocal
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EpisodeSchema;
}
