'use strict';

function candidatesToLessons(candidates, filter = {}) {
  const ids = filter.ids ? new Set(filter.ids) : null;
  const out = [];
  for (const c of candidates || []) {
    if (c.kind !== 'lesson') continue;
    if (!['analyzer', 'critic'].includes(c.target)) continue;
    if (ids && !ids.has(c.id)) continue;
    if (filter.target && c.target !== filter.target) continue;
    out.push({
      target: c.target,
      scope: c.scope && c.scope !== 'all' ? c.scope : 'all',
      section: c.section && c.section !== 'riskLevel' ? c.section : (c.section === 'riskLevel' ? 'riskLevel' : null),
      text: c.text,
      provenance: { runId: filter.runId || null, candidateId: c.id, why: c.why }
    });
  }
  return out;
}

function reviseCandidate(candidates, candidateId, text, options = {}) {
  const parent = (candidates || []).find(c => c.id === candidateId && c.kind === 'lesson');
  if (!parent || typeof text !== 'string' || !text.trim()) return null;
  const id = options.id || `${candidateId}r`;
  const why = `Revised ${candidateId}${options.after ? ` after ${options.after}` : ''}${parent.why ? `: ${parent.why}` : ''}`;
  return {
    target: parent.target,
    scope: parent.scope && parent.scope !== 'all' ? parent.scope : 'all',
    section: parent.section || null,
    text: text.trim(),
    provenance: { runId: options.runId || null, candidateId: id, why: why.slice(0, 400) }
  };
}

function renderLessonList(lessons) {
  if (!lessons.length) return 'No lessons.';
  const lines = [];
  for (const l of lessons) {
    lines.push(`${l.id}  ${l.status.padEnd(9)} ${l.target.padEnd(8)} ${(l.scope || 'all').padEnd(10)} ${(l.section || '-').padEnd(15)} ${l.text.slice(0, 90)}${l.text.length > 90 ? '…' : ''}`);
    if (l.provenance && l.provenance.candidateId) lines.push(`${''.padEnd(22)} from ${l.provenance.runId || '?'} ${l.provenance.candidateId}${l.proof ? ` · proof ${l.proof.proven ? 'proven' : 'not proven'} (${l.proof.runId || '?'})` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { candidatesToLessons, reviseCandidate, renderLessonList };
