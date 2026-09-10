(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const COMMUNITY_STORAGE_KEY = 'tosGuardianCommunity';
  const COMMUNITY_REPORT_VERSION = 1;
  const COMMUNITY_MAX_REPORT_CHARS = 65536;

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeCommunityConfig(value) {
    if (!isPlainObject(value)) return { enabled: false, decided: false };
    return { enabled: value.enabled === true, decided: value.decided === true || value.enabled === true };
  }

  async function readCommunityConfig(storageLocal) {
    try {
      if (!storageLocal || typeof storageLocal.get !== 'function') return { enabled: false, decided: false };
      const stored = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value || {}); } };
        const maybe = storageLocal.get(COMMUNITY_STORAGE_KEY, done);
        if (maybe && typeof maybe.then === 'function') maybe.then(done, () => done({}));
      });
      return normalizeCommunityConfig(stored && stored[COMMUNITY_STORAGE_KEY]);
    } catch (e) {
      return { enabled: false, decided: false };
    }
  }

  function shouldOfferCommunityPrompt(config, renderOk) {
    const cfg = normalizeCommunityConfig(config);
    return renderOk === true && !cfg.enabled && !cfg.decided;
  }

  function communityDecision(enabled) {
    return { enabled: enabled === true, decided: true };
  }

  function buildCommunityReport(events, options) {
    const schema = typeof EpisodeSchema !== 'undefined' ? EpisodeSchema : (typeof require === 'function' ? require('./episode') : null);
    if (!schema) return { ok: false, errors: ['episode schema unavailable'] };
    const episode = schema.assembleEpisode(events || []);
    if (!episode) return { ok: false, errors: ['no events'] };
    if (episode.mode !== 'live') return { ok: false, errors: [`mode ${episode.mode} is not reported`] };
    const stripped = schema.stripLocal(episode);
    const check = schema.validateEpisode(stripped, { uploadable: true });
    if (!check.valid) return { ok: false, errors: check.errors };
    const report = { v: COMMUNITY_REPORT_VERSION, episode: stripped };
    const receipt = options && options.analysisReceipt;
    if (typeof receipt === 'string' && receipt.length > 0 && receipt.length <= 4096) report.analysisReceipt = receipt;
    const size = JSON.stringify(report).length;
    if (size > COMMUNITY_MAX_REPORT_CHARS) return { ok: false, errors: [`report is ${size} characters, over the ${COMMUNITY_MAX_REPORT_CHARS} limit`] };
    return { ok: true, report };
  }

  function describeCommunityOutcome(data) {
    if (!data || typeof data !== 'object') return '[Community] No answer from the proxy';
    if (data.accepted !== true) return `[Community] Report not accepted: ${data.reason || data.error || 'unknown reason'}`;
    const binding = data.receiptBound ? 'receipt-bound' : 'unbound';
    const proposal = data.proposal ? `, site proposal ${data.proposal}` : '';
    return `[Community] Report accepted (${binding}${proposal})`;
  }

  return {
    COMMUNITY_STORAGE_KEY,
    COMMUNITY_REPORT_VERSION,
    COMMUNITY_MAX_REPORT_CHARS,
    normalizeCommunityConfig,
    readCommunityConfig,
    shouldOfferCommunityPrompt,
    communityDecision,
    buildCommunityReport,
    describeCommunityOutcome
  };
});
