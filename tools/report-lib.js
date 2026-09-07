// TOS Guardian — episode report builder (learning loop, phase 0)
//
// Pure: episodes in, markdown out. No model calls. Used by tools/report.js
// and tested in tests/episode.test.js.

'use strict';

const { estimateCost } = require('./batch-lib');

function count(values) {
  const out = {};
  for (const v of values) {
    const key = v === undefined || v === null ? '(none)' : String(v);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function pct(n, total) {
  return total ? `${Math.round((n / total) * 100)}%` : '0%';
}

function distribution(values, total) {
  const counts = count(values);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${n} (${pct(n, total)})`)
    .join(', ') || '(none)';
}

function median(nums) {
  const sorted = nums.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function usageRecords(episode) {
  const s = episode.stages || {};
  const records = [];
  const push = (stage) => {
    if (stage && stage.usage && typeof stage.model === 'string' && stage.model) {
      records.push({
        model: stage.model,
        provider: stage.provider || '',
        input: stage.usage.inputTokens || 0,
        output: stage.usage.outputTokens || 0,
        cacheRead: stage.usage.cacheReadTokens || 0,
        cacheWrite: stage.usage.cacheWriteTokens || 0
      });
    }
  };
  push(s.analyze);
  push(s.critic);
  push(s.escalate);
  return records;
}

function episodeCost(episode) {
  return estimateCost(usageRecords(episode));
}

function verdictLabel(episode) {
  const v = (episode.stages || {}).verdict;
  if (!v) return '(none)';
  return typeof v.score === 'number' && v.label !== 'Cached' ? `${v.label} ${v.score}` : v.label;
}

function attentionReasons(episode) {
  const s = episode.stages || {};
  const reasons = [];
  if (s.trigger && s.trigger.source !== 'batch' && s.trigger.branch === 'none') reasons.push('nothing fired');
  if (s.fetch && s.fetch.path === 'none') reasons.push('no document found');
  if (s.fetch && s.fetch.looksLegal === false && s.fetch.path !== 'none') reasons.push('fetched text is not a legal document');
  if (s.verdict && ['Failed', 'Error', 'Configuration'].includes(s.verdict.label)) reasons.push(`verdict ${s.verdict.label}`);
  if (s.critic && s.critic.failed) reasons.push('critic failed');
  if (s.write && s.write.result === 'blocked') reasons.push(`cache write blocked${s.write.category ? ` (${s.write.category})` : ''}`);
  if (s.render && s.render.error && s.render.error !== 'none') reasons.push(`overlay ${s.render.error}`);
  return reasons;
}

function cell(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\|/g, '\\|');
}

function buildReport(episodes, options) {
  const opts = options || {};
  const list = Array.isArray(episodes) ? episodes : [];
  const total = list.length;
  const stagesOf = e => e.stages || {};
  const lines = [];
  const title = opts.title || 'TOS Guardian episode report';
  lines.push(`# ${title}`);
  lines.push('');
  if (total === 0) {
    lines.push('No episodes.');
    return lines.join('\n') + '\n';
  }

  const modes = count(list.map(e => e.mode));
  const dates = list.map(e => e.startedAt).filter(Boolean).sort();
  lines.push(`Episodes: ${total} (${Object.entries(modes).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  if (dates.length) lines.push(`Range: ${dates[0].slice(0, 19)} to ${dates[dates.length - 1].slice(0, 19)} UTC`);
  lines.push('');

  const live = list.filter(e => e.mode === 'live');
  if (live.length) {
    lines.push('## Trigger (live only)');
    lines.push(`- Source: ${distribution(live.map(e => (stagesOf(e).trigger || {}).source), live.length)}`);
    lines.push(`- Branch: ${distribution(live.map(e => (stagesOf(e).trigger || {}).branch), live.length)}`);
    lines.push('');
  }

  lines.push('## Fetch');
  const fetches = list.map(e => stagesOf(e).fetch).filter(Boolean);
  lines.push(`- Path: ${distribution(fetches.map(f => f.path), fetches.length)}`);
  const legal = fetches.filter(f => f.looksLegal === true).length;
  lines.push(`- Fetched text looks like a legal document: ${legal} of ${fetches.length} (${pct(legal, fetches.length)})`);
  const hidden = fetches.reduce((n, f) => n + (f.hiddenTabHits || 0), 0);
  const proxied = fetches.reduce((n, f) => n + (f.proxyHits || 0), 0);
  lines.push(`- Successful fetches by mechanism: hidden tab ${hidden}, proxy ${proxied}`);
  const unreadable = fetches.reduce((n, f) => n + (f.unreadablePdfCount || 0), 0);
  lines.push(`- Unreadable PDFs: ${unreadable}`);
  lines.push('');

  lines.push('## Cache');
  const caches = list.map(e => stagesOf(e).cache).filter(Boolean);
  lines.push(`- Read: ${distribution(caches.map(c => c.read), caches.length)}`);
  const writes = list.map(e => stagesOf(e).write).filter(Boolean);
  lines.push(`- Write: ${distribution(writes.map(w => w.result), writes.length)}`);
  lines.push('');

  lines.push('## Analysis');
  const analyses = list.map(e => stagesOf(e).analyze).filter(Boolean);
  const cacheHits = caches.filter(c => c.read === 'hit').length;
  lines.push(`- Fresh analyses: ${analyses.length} of ${total} episodes (${cacheHits} served from cache, ${total - analyses.length - cacheHits} ended before analysis)`);
  lines.push(`- Status: ${analyses.length ? distribution(analyses.map(a => a.status), analyses.length) : 'no fresh analyses'}`);
  lines.push(`- Models: ${distribution(analyses.map(a => a.model || '(none)'), analyses.length)}`);
  const escalations = list.map(e => stagesOf(e).escalate).filter(Boolean);
  const attempted = escalations.filter(x => x.attempted).length;
  const accepted = escalations.filter(x => x.accepted).length;
  const capped = escalations.filter(x => x.capReached).length;
  lines.push(`- Escalation: attempted ${attempted}, accepted ${accepted}, blocked by daily cap ${capped}`);
  const critics = list.map(e => stagesOf(e).critic).filter(Boolean);
  const criticRan = critics.filter(c => c.ran).length;
  const criticFailed = critics.filter(c => c.failed).length;
  lines.push(`- Critic: ran ${criticRan}, failed ${criticFailed}`);
  const concerns = {};
  for (const c of critics) {
    for (const [field, verdict] of Object.entries(c.verdicts || {})) {
      if (verdict === 'unsupported' || verdict === 'vague') concerns[field] = (concerns[field] || 0) + 1;
    }
  }
  const concernLine = Object.entries(concerns).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ');
  lines.push(`- Critic concerns by section: ${concernLine || '(none)'}`);
  const evals = list.map(e => stagesOf(e).evaluate).filter(Boolean);
  lines.push(`- Evaluator label: ${distribution(evals.map(v => v.label), evals.length)}`);
  const scores = evals.map(v => v.score).filter(Number.isFinite);
  if (scores.length) lines.push(`- Evaluator score: mean ${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}, median ${median(scores)}`);
  const issueCounts = count(evals.flatMap(v => v.issues || []));
  const topIssues = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`).join('; ');
  lines.push(`- Top issues: ${topIssues || '(none)'}`);
  const verdicts = list.map(e => stagesOf(e).verdict).filter(Boolean);
  lines.push(`- Risk: ${distribution(verdicts.map(v => v.risk), verdicts.length)}`);
  lines.push('');

  lines.push('## Cost and time');
  let totalCost = 0;
  let unpriced = 0;
  for (const e of list) { const c = episodeCost(e); totalCost += c.cost; unpriced += c.unpriced; }
  lines.push(`- Estimated cost: $${totalCost.toFixed(4)}${unpriced ? ` plus ${unpriced} unpriced call(s)` : ''}`);
  const durations = list.map(e => e.durationMs).filter(Number.isFinite);
  if (durations.length) lines.push(`- Duration: median ${(median(durations) / 1000).toFixed(1)}s, max ${(Math.max(...durations) / 1000).toFixed(1)}s`);
  lines.push('');

  const renders = live.map(e => stagesOf(e).render).filter(Boolean);
  if (renders.length) {
    lines.push('## Overlay (live only)');
    lines.push(`- Shown: ${renders.filter(r => r.shown).length} of ${renders.length}`);
    lines.push(`- Errors: ${distribution(renders.map(r => r.error || 'none'), renders.length)}`);
    lines.push('');
  }

  // The events file is cumulative, so a domain can appear more than once. Each
  // flagged episode carries its time, and one that a later episode of the same
  // domain no longer flags is marked as such, so a fixed site reads as fixed.
  const attention = list.map(e => ({ e, reasons: attentionReasons(e) })).filter(x => x.reasons.length);
  const latestByDomain = new Map();
  for (const e of list) if (e.domain) latestByDomain.set(e.domain, e);
  lines.push('## Needs attention');
  if (attention.length === 0) lines.push('Nothing flagged.');
  for (const { e, reasons } of attention) {
    const when = e.startedAt ? ` at ${e.startedAt.slice(11, 16)} UTC` : '';
    const latest = e.domain ? latestByDomain.get(e.domain) : null;
    const superseded = latest && latest !== e && attentionReasons(latest).length === 0 ? ' (a later episode of this site is clean)' : '';
    lines.push(`- ${e.domain || e.episodeId}${when}: ${reasons.join('; ')}${superseded}`);
  }
  lines.push('');

  lines.push('## Episodes');
  lines.push('| domain | mode | trigger | fetch | legal | cache | verdict | risk | critic | escalation | cost | seconds | issues |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const e of list) {
    const s = stagesOf(e);
    const trig = s.trigger ? `${s.trigger.source}${s.trigger.branch ? `/${s.trigger.branch}` : ''}` : '';
    const fetch = s.fetch ? s.fetch.path : '';
    const legalCell = s.fetch ? (s.fetch.looksLegal ? 'yes' : 'no') : '';
    const cacheCell = s.cache ? s.cache.read : '';
    const criticCell = s.critic ? (s.critic.failed ? 'failed' : (s.critic.ran ? `${Object.values(s.critic.verdicts || {}).filter(v => v === 'unsupported' || v === 'vague').length} concerns` : 'off')) : '';
    const escCell = s.escalate ? (s.escalate.capReached ? 'cap' : (s.escalate.accepted ? 'accepted' : (s.escalate.attempted ? 'kept first' : ''))) : '';
    const issues = (s.evaluate && s.evaluate.issues || []).slice(0, 3).join('; ');
    lines.push(`| ${[
      e.domain || e.episodeId, e.mode, trig, fetch, legalCell, cacheCell, verdictLabel(e),
      s.verdict ? s.verdict.risk : '', criticCell, escCell, `$${episodeCost(e).cost.toFixed(4)}`,
      (e.durationMs / 1000).toFixed(1), issues
    ].map(cell).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

module.exports = { buildReport, attentionReasons, episodeCost, usageRecords };
