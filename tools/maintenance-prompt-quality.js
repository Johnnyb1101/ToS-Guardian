'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('./final-corpus-lib');
const { checkRelease } = require('./sites-lib');
const { localPath } = require('./maintenance-local-path');
const { sameLocalDirectory } = require('./maintenance-dependency-smoke-approval');
const { createObservedBudgetPlan } = require('./maintenance-observed-budget');

const PROVIDERS = Object.freeze(['anthropic', 'openai']);
const ARMS = Object.freeze(['baseline', 'candidate']);
const STAGES = Object.freeze(['analyzer', 'critic', 'judge', 'independent']);
const ROLES = ['protocol', 'execution', 'human', 'judge', 'scope', 'code'];
const SPEC = ['mode', 'declaredAt', 'builds', 'offlineComparisonHash', 'corpus', 'repetitions', 'criteria', 'rubric', 'independentJudge', 'reviewers'];
const PLAN = ['approvalId', 'limitMicrodollars', 'overheadMicrodollars', 'journalDirectory', 'protocol', 'pricing'];
const TOKENS = { analyzer: 1200, critic: 1000, judge: 8000, independent: 8000 };
const ANTHROPIC_INPUT_CHECK = Object.freeze({
  method: 'count-tokens', maxEstimatedInputTokens: 56000, maxInputTokens: 64000,
});
const ANTHROPIC_FULL_CONTEXT_TOKENS = 1_000_000;
// Reserve the entire reviewed context unless the protocol binds an enforced Anthropic input check.
// https://platform.claude.com/docs/en/build-with-claude/context-windows
// https://developers.openai.com/api/docs/models/gpt-4o-mini
// https://developers.openai.com/api/docs/models/gpt-4o
// https://developers.openai.com/api/docs/models/gpt-6-luna
const CONTEXT = {
  anthropic: { 'claude-sonnet-4-6': ANTHROPIC_FULL_CONTEXT_TOKENS, 'claude-opus-5': ANTHROPIC_FULL_CONTEXT_TOKENS },
  openai: { 'gpt-4o-mini': 128_000, 'gpt-4o': 128_000 },
  independent: { 'gpt-6-luna': 1_050_000 },
};
const RATE = ['responseModel', 'maxInputTokens', 'maxOutputTokens', 'inputMicrodollarsPerMillion', 'outputMicrodollarsPerMillion'];
const MAX_BYTES = 400000;
const exact = (obj, fields) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === fields.length && fields.every(key => Object.hasOwn(obj, key));
const clone = value => JSON.parse(C.canonicalJson(value));
const same = (a, b) => C.canonicalJson(a) === C.canonicalJson(b);
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const requireThat = (ok, reason) => { if (!ok) throw Error(reason); };
const descriptor = value => exact(value, ['sha256', 'bytes']) && C.isHash(value.sha256) && positive(value.bytes) && value.bytes <= MAX_BYTES;
const uniqueTags = value => Array.isArray(value) && value.length && value.every(id) && new Set(value).size === value.length;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Immutable identities from the reviewed offline package. Keeping the pins here
// lets verification run without a sibling checkout or a network lookup.
const OFFLINE_HASH = "4fcf123e89cab6d7bf12ec310ed4382bf44880d15eee755c7409590c4d36f886";
const BUILDS = {
  "baseline": {
    "commit": "6b818e7a13f0f8575d20bc4a5df9b01521c90edf",
    "artifact": {
      "bytes": 264284160,
      "manifestDigest": "sha256:03ea83c81a47b1f85df69fa2b194445d4854ec6a6c319c5387833521baf28deb",
      "sha256": "aea17d48af7c39e5090f14797731c6fdcefa5bc5de20a6c20bbb30ab7129fb08"
    },
    "configHash": "9f0847ca320b24a67e98fd83dff1621e46c03828ae6c951def99ee9c4c8eb056"
  },
  "candidate": {
    "commit": "78f1861c70f30c710165446225858ccfe9088a52",
    "artifact": {
      "bytes": 264284160,
      "manifestDigest": "sha256:c64f8b2a55cc4e7d2acda70504c8eee4e2d348ba4c04cde87b2c01dc172f05a4",
      "sha256": "84ec6cab361baa17557e68d1fefddfe543884a3ca06286fe398929d1a077d619"
    },
    "configHash": "f7054dc1113dfb722cd6b925d3deee924c717979213b847f8231656de4635ec2"
  }
};
const RUNTIME = {
  "arch": "x64",
  "node": "v22.23.3",
  "npm": "10.9.9",
  "platform": "linux"
};
const CHANGES = [
  {
    "baseline": "72475231335741c56b9b7ea67ae8b414100fbd6f2712f7553eefcc9af246703a",
    "candidate": "b7860757fa2d7c81a39c07b5c7be23edd1e1d6730316f16ed392b1a78df11e97",
    "path": [
      "policy",
      "promptHashes",
      "analyzer"
    ]
  },
  {
    "baseline": "19682ddcfa256021e2450209cc0022508e27bb35c727a868ac42148383eb7a6e",
    "candidate": "dda72baadc2a7ef08a06d355b023a7baae14997ba2a3d36bdcda6be86edfd7f7",
    "path": [
      "policy",
      "versions",
      "promptComposition"
    ]
  },
  {
    "baseline": "42aa8c9690cd9a93a49cd02c5359d57e0a191ac71ed64b9170e434dc16228393",
    "candidate": "c0fe09853038389bae802ca5dfaac71d1cc37dc815378303cdf8d82368ace676",
    "path": [
      "policy",
      "versions",
      "serverPipeline"
    ]
  }
];
const OBSERVED_BUILD_PAIRS = new Map([
  [OFFLINE_HASH, { builds: BUILDS, changes: CHANGES }],
  ['476d3d202fb834aa2205e31168e89524a69742b5c9a28558dca5b9857cdbfe2c', {
    builds: {
      "baseline": {
        "commit": "39f34f11ea180a4de93370ec790009bc17d63e86",
        "artifact": {
          "manifestDigest": "sha256:d6320e7a89a6dacb6b3f84d56be38b56953d237137f001d89a1058dbe4aa805c",
          "bytes": 266977280,
          "sha256": "dabefdbff08b8f7d78d47e7c36b24079d0a4d3bf7bd8e8a5067e6eda3952be97"
        },
        "configHash": "4b136706efe246302618ed3e6317d7139a8b78d6c9d6d47e4d175d72b18cd960"
      },
      "candidate": {
        "commit": "632b5fc38cdd19d6b042b6d193fb34fb3b612b98",
        "artifact": {
          "manifestDigest": "sha256:2898a9d7594b80a41c4ec21a8847c32b969fd68523ad472433693284d1d4d89b",
          "bytes": 266977280,
          "sha256": "f3a8d29821866d8bdef1a58837ffec89efedc3d0902a3000f116bb1da778276d"
        },
        "configHash": "208864d93ccbfb4ff8f9012e812bdf9c043f3d2919a65220292136383154ac73"
      }
    },
    changes: [
      {
        "path": [
          "policy",
          "promptHashes",
          "analyzer"
        ],
        "baseline": "b7860757fa2d7c81a39c07b5c7be23edd1e1d6730316f16ed392b1a78df11e97",
        "candidate": "61c3552389d6b8bbb1a0c99693315c2d15575d6f4deb0a58d2a794705ff9e8c0"
      },
      {
        "path": [
          "policy",
          "versions",
          "promptComposition"
        ],
        "baseline": "dda72baadc2a7ef08a06d355b023a7baae14997ba2a3d36bdcda6be86edfd7f7",
        "candidate": "bf9de2031ef72410fd4d71da45fe771fa9e0beff4bc211a50b7232f4cfc90c8e"
      },
      {
        "path": [
          "policy",
          "versions",
          "serverPipeline"
        ],
        "baseline": "11e04423e42901b04174b6c565e380dcf58bcfcbcdabba661071b7a1f03b4484",
        "candidate": "190331bc7d9c826e2534920524aa55af9200772ea5210e2ccbd242905f1ac944"
      }
    ],
  }],
]);
const OFFLINE_SOURCES = [
  {
    "url": "https://bsky.social/about/support/tos",
    "sha256": "842e5a387266908ea3f66d12cee9344f2dda54fdb65a5d648804f49f7dd841b3"
  },
  {
    "url": "https://proton.me/legal/terms",
    "sha256": "bcce3938850e79a151bcd6c00f999826c7388b2e17afe0c962ef3c72ab60eb3e"
  },
  {
    "url": "https://bandcamp.com/terms_of_use",
    "sha256": "99ec6cd5336252c79c8dbadc782401a0671d9960c49baa86d077d8f70fb10c46"
  },
  {
    "url": "https://www.nintendo.com/us/terms-of-use/",
    "sha256": "ece8bdbe9dbaee4823f8dda76eac5458f1939ea0c399ece58e21521019eef882"
  },
  {
    "url": "https://www.fastmail.com/policies/privacy/",
    "sha256": "dd48482c24fe958ec91c3c1cec716fef344dd298315e5ed789016b492ceff5d7"
  },
  {
    "url": "https://foundation.wikimedia.org/wiki/Policy:Privacy_policy",
    "sha256": "69a4999178b768d30d7c8949f05ee676c6bca7595e0b2dc26aeff81af5fa5b8d"
  }
];

function validateBuilds({ builds, mode, offlineComparisonHash }) {
  requireThat(exact(builds, ARMS) && C.isHash(offlineComparisonHash), 'Build pair and offline comparison hash required');
  const observed = mode === 'observed';
  const reviewedPair = OBSERVED_BUILD_PAIRS.get(offlineComparisonHash);
  if (observed) requireThat(reviewedPair, 'Unknown offline comparison');
  const changes = observed ? reviewedPair.changes : CHANGES;
  const fixed = {};
  for (const arm of ARMS) {
    const b = builds[arm];
    requireThat(exact(b, ['commit', 'release', 'artifact', 'runtime']) && /^[a-f0-9]{40}$/.test(b.commit) &&
      checkRelease(b.release, observed ? reviewedPair.builds[arm].configHash : null).valid, 'Invalid pinned ' + arm + ' release');
    const a = b.artifact;
    requireThat(exact(a, ['sha256', 'bytes', 'manifestDigest']) && C.isHash(a.sha256) &&
      positive(a.bytes) && a.bytes <= 256 * 1024 * 1024 && /^sha256:[a-f0-9]{64}$/.test(a.manifestDigest), 'Invalid OCI artifact');
    requireThat(exact(b.runtime, Object.keys(RUNTIME)) && Object.values(b.runtime).every(C.nonempty), 'Invalid runtime');
    if (observed) requireThat(same(a, reviewedPair.builds[arm].artifact) && b.commit === reviewedPair.builds[arm].commit && same(b.runtime, RUNTIME),
      'Observed build identity differs from reviewed ' + arm);
    fixed[arm] = clone(b.release.config);
    for (const change of changes) {
      const [, section, field] = change.path;
      const leaf = fixed[arm].policy[section][field];
      requireThat(C.isHash(leaf) && (!observed || leaf === change[arm]), 'Invalid changed release leaf ' + field);
      requireThat(leaf !== builds[arm === 'baseline' ? 'candidate' : 'baseline'].release.config.policy[section][field],
        'Both builds must differ on ' + field);
      delete fixed[arm].policy[section][field];
    }
  }
  const { baseline, candidate } = builds;
  requireThat(same(fixed.baseline, fixed.candidate) && same(baseline.runtime, candidate.runtime), 'Unexpected release or runtime change');
  requireThat(baseline.commit !== candidate.commit && baseline.artifact.sha256 !== candidate.artifact.sha256 &&
    baseline.artifact.manifestDigest !== candidate.artifact.manifestDigest, 'Distinct build identities required');
}

function sourceUrl(value) {
  const url = new URL(value);
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.href === value,
    'Canonical HTTPS source URL required');
  // Query parameters and trailing slashes cannot turn a reused source into a holdout.
  return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') + decodeURIComponent(url.pathname).replace(/\/+$/, '');
}

function validateCorpus(protocol) {
  const { corpus, repetitions, declaredAt, mode } = protocol;
  requireThat(exact(corpus, ['samples', 'requiredCoverage']) && uniqueTags(corpus.requiredCoverage) &&
    positive(repetitions) && Array.isArray(corpus.samples) && corpus.samples.length > 0 &&
    corpus.samples.length * repetitions * ARMS.length * PROVIDERS.length <= 1000, 'Bounded corpus and repetitions required');
  const ids = new Set(), hashes = new Set(), urls = new Set(), covered = new Set();
  for (const sample of corpus.samples) {
    requireThat(exact(sample, ['id', 'coverage', 'source', 'provenance']) && id(sample.id) && !ids.has(sample.id) &&
      descriptor(sample.source) && !hashes.has(sample.source.sha256), 'Malformed or duplicate corpus sample');
    requireThat(uniqueTags(sample.coverage) && sample.coverage.every(tag => corpus.requiredCoverage.includes(tag)), 'Invalid sample coverage');
    sample.coverage.forEach(tag => covered.add(tag));
    const p = sample.provenance;
    requireThat(exact(p, ['url', 'capturedAt', 'method']) && stamp(p.capturedAt) && p.capturedAt <= declaredAt &&
      C.nonempty(p.method), 'Invalid capture provenance or capture time');
    const url = sourceUrl(p.url);
    requireThat(!urls.has(url), 'Duplicate corpus URL');
    if (mode === 'observed') {
      requireThat(p.method === 'official-capture', 'Official source capture required');
      requireThat(!OFFLINE_SOURCES.some(s => s.sha256 === sample.source.sha256 || sourceUrl(s.url) === url), 'Offline comparison corpus cannot be reused');
    }
    ids.add(sample.id); hashes.add(sample.source.sha256); urls.add(url);
  }
  requireThat(corpus.requiredCoverage.every(tag => covered.has(tag)), 'Missing declared coverage');
}

function validatePromptQualityProtocol(protocol) {
  try {
    const fields = Object.hasOwn(protocol ?? {}, 'anthropicInputCheck') ? [...SPEC, 'anthropicInputCheck'] : SPEC;
    requireThat(exact(protocol, [...fields, 'v', 'kind', 'hash']) && protocol.v === 1 &&
      protocol.kind === 'maintenance-prompt-quality-protocol' && C.bodyHash(protocol) === protocol.hash, 'Invalid prompt quality protocol seal or shape');
    if (fields !== SPEC) {
      requireThat(same(protocol.anthropicInputCheck, ANTHROPIC_INPUT_CHECK), 'Invalid Anthropic input check');
    }
    requireThat(['fixture', 'observed'].includes(protocol.mode) && stamp(protocol.declaredAt), 'Invalid protocol mode or declaration time');
    validateBuilds(protocol);
    validateCorpus(protocol);
    const c = protocol.criteria;
    const unit = v => Number.isFinite(v) && v >= 0 && v <= 1;
    requireThat(exact(c, ['minAccuracy', 'minCompleteness', 'maxFabrications', 'maxMeanRegression']) &&
      [c.minAccuracy, c.minCompleteness, c.maxMeanRegression].every(unit) && c.minAccuracy > 0 &&
      c.minCompleteness > 0 && c.maxFabrications === 0, 'Invalid preregistered criteria');
    requireThat(descriptor(protocol.rubric) && exact(protocol.independentJudge, ['model', 'prompt']) &&
      modelId(protocol.independentJudge.model) && descriptor(protocol.independentJudge.prompt), 'Invalid rubric or independent judge');
    requireThat(exact(protocol.reviewers, ROLES) && Object.values(protocol.reviewers).every(id) &&
      new Set(Object.values(protocol.reviewers)).size === ROLES.length, 'Distinct reviewer identities required');
    return { valid: true, reasons: [] };
  } catch (error) { return { valid: false, reasons: [error.message] }; }
}

function createPromptQualityProtocol(spec) {
  const fields = Object.hasOwn(spec ?? {}, 'anthropicInputCheck') ? [...SPEC, 'anthropicInputCheck'] : SPEC;
  requireThat(exact(spec, fields), 'Exact protocol specification required');
  const protocol = C.seal({ v: 1, kind: 'maintenance-prompt-quality-protocol', ...clone(spec) });
  const checked = validatePromptQualityProtocol(protocol);
  requireThat(checked.valid, checked.reasons.join(', '));
  return protocol;
}

function promptQualityCallId(run, stage) {
  return [run.provider, run.arm, run.sampleId, run.repetition, stage].join(':');
}

function validateRate(rate, model, stage, provider, protocol) {
  requireThat(exact(rate, RATE) && modelId(rate.responseModel) && (rate.responseModel === model ||
    (rate.responseModel.startsWith(model + '-') && /^(?:\d{4}-\d{2}-\d{2}|\d{8})$/.test(rate.responseModel.slice(model.length + 1)))),
    'Response model must match the pinned request model or its dated snapshot');
  if (provider === 'anthropic' && protocol.anthropicInputCheck) {
    requireThat(rate.maxInputTokens === protocol.anthropicInputCheck.maxInputTokens,
      'Anthropic pricing must reserve the full checked token allowance');
  } else if (protocol.mode === 'observed') {
    requireThat(Object.hasOwn(CONTEXT[provider], model) && rate.maxInputTokens >= CONTEXT[provider][model],
      'Observed pricing must reserve the full audited model context');
  }
  requireThat(RATE.slice(1).every(key => positive(rate[key])) &&
    (stage === 'independent' ? rate.maxOutputTokens <= TOKENS[stage] : rate.maxOutputTokens === TOKENS[stage]), 'Invalid pricing or stage token cap');
}

function createPromptQualityPlan(input) {
  requireThat(exact(input, PLAN), 'Exact plan input required');
  const value = clone(input);
  const { protocol, pricing } = value;
  const checked = validatePromptQualityProtocol(protocol);
  requireThat(checked.valid, checked.reasons.join(', '));
  requireThat(exact(pricing, [...PROVIDERS, 'independent']), 'Pricing for both providers and the independent judge required');
  validateRate(pricing.independent, protocol.independentJudge.model, 'independent', 'independent', protocol);
  const runs = [];
  for (const provider of PROVIDERS) {
    requireThat(exact(pricing[provider], STAGES.slice(0, 3)), 'Three pipeline stages required per provider');
    for (const arm of ARMS) {
      const models = protocol.builds[arm].release.config.policy.models[provider];
      for (const stage of STAGES.slice(0, 3)) validateRate(pricing[provider][stage], models[stage === 'judge' ? 'jury' : 'default'], stage, provider, protocol);
      for (const { id: sampleId } of protocol.corpus.samples) {
        for (let repetition = 1; repetition <= protocol.repetitions; repetition++) runs.push({ provider, arm, sampleId, repetition });
      }
    }
  }
  const journal = localPath(value.journalDirectory);
  requireThat(journal === value.journalDirectory && fs.statSync(journal).isDirectory() &&
    !sameLocalDirectory(journal, path.join(os.homedir(), 'AppData', 'Local', 'ToSGuardian', 'dependency-smoke-live')),
    'Existing canonical journal directory distinct from the smoke checkpoint required');
  const calls = runs.flatMap(run => STAGES.map(stage => {
    const { responseModel, ...rate } = stage === 'independent' ? pricing.independent : pricing[run.provider][stage];
    return { id: promptQualityCallId(run, stage), ...rate };
  }));
  const binding = C.seal({ v: 1, kind: 'maintenance-prompt-quality-plan', ...value, runs, calls });
  const budget = createObservedBudgetPlan({ approvalId: value.approvalId, planHash: binding.hash, limitMicrodollars: value.limitMicrodollars,
    overheadMicrodollars: value.overheadMicrodollars, calls });
  return { ...binding, budget };
}

function validatePromptQualityPlan(plan, approvedPlanHash) {
  requireThat(C.isHash(approvedPlanHash) && plan?.hash === approvedPlanHash, 'Approved plan hash required');
  const computed = createPromptQualityPlan(Object.fromEntries(PLAN.map(k => [k, plan[k]])));
  requireThat(same(computed, plan), 'Prompt quality plan changed after approval');
  return computed;
}

function readQualityAttachment(attachments, descriptorValue, label) {
  requireThat(descriptor(descriptorValue), label + ': invalid descriptor');
  const data = attachments instanceof Map ? attachments.get(descriptorValue.sha256) : undefined;
  requireThat(Buffer.isBuffer(data) || typeof data === 'string', label + ': missing bytes');
  const bytes = Buffer.from(data);
  requireThat(bytes.length === descriptorValue.bytes && sha(bytes) === descriptorValue.sha256, label + ': changed bytes');
  return bytes;
}

function promptQualityPreregistrationMessage(payload) {
  return 'tos-guardian.prompt-quality-preregistration.v1\n' + C.canonicalJson(payload);
}

function verifyPromptQualityPreregistration({ protocol, preregistration, reviewerRegistry, attachments, now }) {
  const checked = validatePromptQualityProtocol(protocol);
  requireThat(checked.valid, checked.reasons.join(', '));
  requireThat(stamp(now) && exact(preregistration, ['payload', 'signature']), 'Signature envelope and trusted clock required');
  const { payload, signature } = preregistration;
  requireThat(exact(payload, ['v', 'kind', 'protocolHash', 'reviewer', 'observedAt', 'outcome', 'attachment', 'hash']) &&
    payload.v === 1 && payload.kind === 'preregistration' && payload.outcome === 'pass' && payload.protocolHash === protocol.hash &&
    payload.reviewer === protocol.reviewers.protocol && stamp(payload.observedAt) && payload.observedAt >= protocol.declaredAt &&
    payload.observedAt <= now && C.bodyHash(payload) === payload.hash, 'Invalid preregistration declaration');
  const fingerprints = new Set();
  let protocolKey;
  for (const role of ROLES) {
    const name = protocol.reviewers[role];
    const entry = reviewerRegistry && Object.hasOwn(reviewerRegistry, name) && reviewerRegistry[name];
    requireThat(exact(entry, ['publicKey', 'roles']) && uniqueTags(entry.roles) && entry.roles.includes(role) &&
      entry.roles.every(r => ROLES.includes(r)), 'Trusted ' + role + ' reviewer required');
    const key = crypto.createPublicKey(entry.publicKey);
    const fingerprint = sha(key.export({ format: 'der', type: 'spki' }));
    requireThat(key.asymmetricKeyType === 'ed25519' && !fingerprints.has(fingerprint), 'Independent Ed25519 reviewer keys required');
    fingerprints.add(fingerprint);
    if (role === 'protocol') protocolKey = key;
  }
  const raw = Buffer.from(String(signature), 'base64');
  requireThat(raw.length === 64 && raw.toString('base64') === signature &&
    crypto.verify(null, Buffer.from(promptQualityPreregistrationMessage(payload)), protocolKey, raw), 'Invalid preregistration signature');
  readQualityAttachment(attachments, payload.attachment, 'preregistration');
  return payload;
}

module.exports = { PROVIDERS, ARMS, STAGES, ANTHROPIC_FULL_CONTEXT_TOKENS, createPromptQualityProtocol, validatePromptQualityProtocol, createPromptQualityPlan,
  validatePromptQualityPlan, promptQualityPreregistrationMessage, verifyPromptQualityPreregistration, readQualityAttachment, promptQualityCallId };
