'use strict';

const { summarizeRun } = require('./jury-lib');
const { mean, num, signed } = require('./prove-lib');

const STEPS = Object.freeze({
  jury: ['health', 'register', 'screen-replay', 'screen-jury', 'screen-decide', 'proof-replay', 'proof-jury', 'prove', 'report', 'notify'],
  critic: ['health', 'register', 'critic-replay', 'prove-critic', 'report', 'notify']
});
const DEFAULTS = Object.freeze({ samples: 3, screenSamples: 3, maxFabricationRise: 0.25, maxScoreDrop: 5, proofBudget: 45, screenBudget: 12, delayMs: 6000 });
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{2,60}$/;
const LESSON_ID = /^lsn_[0-9a-f]{16}$/;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finite(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== null && Number.isFinite(n) ? n : fallback;
}

function validateSpec(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['spec must be an object'], spec: null };
  const name = typeof input.name === 'string' && NAME_PATTERN.test(input.name) ? input.name : null;
  if (!name) errors.push('name must be 3 to 61 lowercase letters, digits or dashes');
  if (typeof input.proxy !== 'string' || !/^https?:\/\/\S+$/.test(input.proxy)) errors.push('proxy must be an http(s) url');
  if (typeof input.control !== 'string' || !input.control.trim()) errors.push('control must name a graded run');
  const kind = input.proof && input.proof.kind === 'critic' ? 'critic' : 'jury';
  const lessons = input.lessons && typeof input.lessons === 'object' ? input.lessons : {};
  const create = lessons.create && typeof lessons.create === 'object' ? { run: String(lessons.create.run || ''), ids: Array.isArray(lessons.create.ids) ? lessons.create.ids.map(String) : [] } : null;
  if (create && (!create.run || !create.ids.length)) errors.push('lessons.create needs a run and ids');
  const carry = lessons.carry && typeof lessons.carry === 'object' ? { run: String(lessons.carry.run || ''), ids: Array.isArray(lessons.carry.ids) ? lessons.carry.ids.map(String) : [] } : null;
  if (carry && (!carry.run || !carry.ids.length)) errors.push('lessons.carry needs a run and ids');
  const revise = Array.isArray(lessons.revise) ? lessons.revise.map(r => ({ run: String((r && r.run) || ''), candidateId: String((r && r.candidateId) || ''), id: r && r.id ? String(r.id) : null, after: r && r.after ? String(r.after) : null, text: String((r && r.text) || '').trim() })) : [];
  for (const r of revise) if (!r.run || !r.candidateId || r.text.length < 20) errors.push(`lessons.revise entry ${r.candidateId || '?'} needs a run, a candidateId and a text of 20+ characters`);
  const pin = Array.isArray(lessons.pin) ? lessons.pin.map(String) : [];
  for (const id of pin) if (!LESSON_ID.test(id)) errors.push(`lessons.pin has an invalid id ${id}`);
  if (!create && !revise.length && !pin.length) errors.push('a campaign needs lessons to create, revise or pin');
  const screen = input.screen && typeof input.screen === 'object' ? {
    sites: Array.isArray(input.screen.sites) ? input.screen.sites.map(String) : [],
    samples: positiveInt(input.screen.samples, DEFAULTS.screenSamples),
    budget: positiveNumber(input.screen.budget, DEFAULTS.screenBudget),
    maxFabricationRise: finite(input.screen.maxFabricationRise, DEFAULTS.maxFabricationRise),
    maxScoreDrop: finite(input.screen.maxScoreDrop, DEFAULTS.maxScoreDrop)
  } : null;
  if (screen && screen.sites.length < 3) errors.push('screen.sites needs at least 3 sites');
  if (screen && kind === 'critic') errors.push('a critic campaign has no screen');
  const proof = {
    kind,
    samples: positiveInt(input.proof && input.proof.samples, DEFAULTS.samples),
    budget: positiveNumber(input.proof && input.proof.budget, DEFAULTS.proofBudget),
    source: input.proof && typeof input.proof.source === 'string' && input.proof.source.trim() ? input.proof.source.trim() : null
  };
  if (kind === 'critic' && !proof.source) errors.push('a critic proof needs proof.source, the graded run whose analyses the critic re-checks');
  const notify = input.notify && typeof input.notify === 'object' && typeof input.notify.url === 'string' ? { url: input.notify.url } : null;
  if (notify && !/^https:\/\/\S+$/.test(notify.url)) errors.push('notify.url must be https');
  const spec = errors.length ? null : { name, proxy: input.proxy.replace(/\/+$/, ''), control: input.control.trim(), lessons: { carry, create, revise, pin }, screen, proof, notify, delayMs: positiveInt(input.delayMs, DEFAULTS.delayMs) };
  return { valid: errors.length === 0, errors, spec };
}

function planSteps(spec) {
  return STEPS[spec.proof.kind].filter(step => spec.screen || !step.startsWith('screen'));
}

function runIds(spec) {
  return { screen: `${spec.name}-screen`, proof: `${spec.name}-proof`, critic: `${spec.name}-critic` };
}

function budgetSplit(budget) {
  return { replay: Math.round(budget * 0.4 * 100) / 100, jury: Math.round(budget * 0.6 * 100) / 100 };
}

function rowsFor(artifacts, sites, juror) {
  const wanted = new Set(sites);
  return summarizeRun(artifacts.filter(a => wanted.has(a.domain)), { juror }).rows;
}

function screenDecision({ controlArtifacts, treatmentArtifacts, sites, maxFabricationRise = DEFAULTS.maxFabricationRise, maxScoreDrop = DEFAULTS.maxScoreDrop, juror = 'anthropic' }) {
  const stats = (rows) => ({ verdicts: rows.length, fabricationsPerVerdict: rows.length ? rows.reduce((n, r) => n + r.fabrications, 0) / rows.length : null, meanScore: mean(rows.map(r => r.juryScore)) });
  const control = stats(rowsFor(controlArtifacts, sites, juror));
  const treatment = stats(rowsFor(treatmentArtifacts, sites, juror));
  const reasons = [];
  if (!control.verdicts || !treatment.verdicts) reasons.push('no graded verdicts to compare on the screen sites');
  else {
    if (treatment.fabricationsPerVerdict - control.fabricationsPerVerdict > maxFabricationRise) reasons.push(`fabrications per verdict rose from ${num(control.fabricationsPerVerdict, 2)} to ${num(treatment.fabricationsPerVerdict, 2)} (limit +${num(maxFabricationRise, 2)})`);
    if (control.meanScore - treatment.meanScore > maxScoreDrop) reasons.push(`jury mean fell from ${num(control.meanScore)} to ${num(treatment.meanScore)} (limit ${maxScoreDrop} points)`);
  }
  return { proceed: reasons.length === 0, reasons, control, treatment, sites: sites.length };
}

function initialState(spec) {
  return { v: 1, name: spec.name, spec, startedAt: new Date().toISOString(), finishedAt: null, steps: {}, lessons: { registered: [], pinned: [] }, screen: null, proof: null, decision: null, cost: { screen: 0, proof: 0 }, failure: null };
}

function markStep(state, step, result) {
  state.steps[step] = { ...result, at: new Date().toISOString() };
  return state;
}

function nextStep(state, steps) {
  return steps.find(step => !state.steps[step] || state.steps[step].status === 'failed') || null;
}

function proposal(state) {
  const proxy = state.spec.proxy;
  const ids = state.lessons.registered.filter(r => r.underTest !== false).map(r => r.id).filter(Boolean);
  const list = ids.length ? ids : ['<lesson id>'];
  if (state.decision === 'stopped-at-screen') return `Retire the candidates; the screen showed the regression that bundle 2 had.\n${list.map(id => `node tools/lessons.js status ${id} retired --proxy ${proxy}`).join('\n')}`;
  if (!state.proof) return 'No proof was reached.';
  const verb = state.proof.proven ? 'promoted' : 'retired';
  return `${state.proof.proven ? 'Promote' : 'Retire'} the candidates with the proof attached.\n${list.map(id => `node tools/lessons.js status ${id} ${verb} --proxy ${proxy} --proof ${state.proof.runDir}`).join('\n')}`;
}

function renderReport(state) {
  const lines = [];
  lines.push(`# Campaign ${state.name}`);
  lines.push('');
  lines.push(`${state.failure ? `Failed: ${state.failure}` : state.decision === 'stopped-at-screen' ? 'Stopped at the screen.' : state.proof ? state.proof.summary : 'Not finished.'}`);
  lines.push('');
  lines.push(`Started ${state.startedAt}${state.finishedAt ? `, finished ${state.finishedAt}` : ''}. Proxy ${state.spec.proxy}. Control ${state.spec.control}. Proof kind ${state.spec.proof.kind}${state.spec.proof.source ? ` on ${state.spec.proof.source}` : ''}.`);
  lines.push(`Cost: screen $${num(state.cost.screen, 2)}, proof $${num(state.cost.proof, 2)}, total $${num(state.cost.screen + state.cost.proof, 2)}.`);
  lines.push('');
  lines.push('## Lessons');
  lines.push('');
  if (!state.lessons.registered.length) lines.push('None registered.');
  for (const r of state.lessons.registered) lines.push(`- ${r.candidateId || '?'} -> ${r.id || 'not registered'} (${r.status}${r.underTest === false ? ', carried, not under test' : ''})`);
  if (state.lessons.pinned.length) lines.push(`\nPinned set: ${state.lessons.pinned.join(', ')}`);
  if (state.screen) {
    lines.push('');
    lines.push('## Screen');
    lines.push('');
    lines.push(`${state.screen.sites} site(s): ${state.screen.proceed ? 'passed' : 'STOPPED'}${state.screen.reasons.length ? ` (${state.screen.reasons.join('; ')})` : ''}.`);
    lines.push('');
    lines.push('| arm | verdicts | fabrications per verdict | jury mean |');
    lines.push('|---|---|---|---|');
    lines.push(`| control | ${state.screen.control.verdicts} | ${num(state.screen.control.fabricationsPerVerdict, 2)} | ${num(state.screen.control.meanScore)} |`);
    lines.push(`| treatment | ${state.screen.treatment.verdicts} | ${num(state.screen.treatment.fabricationsPerVerdict, 2)} | ${num(state.screen.treatment.meanScore)} |`);
  }
  if (state.proof) {
    lines.push('');
    lines.push('## Proof');
    lines.push('');
    lines.push(`${state.proof.summary}`);
    lines.push(`Lesson set ${state.proof.lessonsHash ? state.proof.lessonsHash.slice(0, 12) : 'mixed or none'}; details in ${state.proof.runDir}/proof.md.`);
  }
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  for (const [step, r] of Object.entries(state.steps)) lines.push(`- ${step}: ${r.status}${r.note ? ` (${r.note})` : ''} at ${r.at}`);
  lines.push('');
  lines.push('## Proposal');
  lines.push('');
  lines.push(proposal(state));
  lines.push('');
  return lines.join('\n');
}

function notificationText(state) {
  const outcome = state.failure ? `failed: ${state.failure}` : state.decision === 'stopped-at-screen' ? 'stopped at the screen' : state.proof ? (state.proof.proven ? 'PROVEN' : 'not proven') : 'finished';
  const detail = state.proof && state.proof.summary ? ` ${state.proof.summary}` : state.screen && !state.screen.proceed ? ` ${state.screen.reasons.join('; ')}` : '';
  return `ToS Guardian campaign ${state.name}: ${outcome}.${detail} Cost $${num(state.cost.screen + state.cost.proof, 2)}.`.slice(0, 400);
}

module.exports = { STEPS, DEFAULTS, validateSpec, planSteps, runIds, budgetSplit, screenDecision, initialState, markStep, nextStep, proposal, renderReport, notificationText, signed };
