'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, digest, isHash, seal } = require('./final-corpus-lib');
const { checkRelease } = require('./sites-lib');
const { localPath, localPaths } = require('./maintenance-local-path');
const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');
const { imageBridge } = require('./maintenance-observed-live');
const { classifyRelease } = require('./release-class-lib');

const PROVIDERS = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
};
const STAGES = ['analyzer', 'critic', 'judge', 'escalation'];
const FIXED_PRIOR = 'Offline equivalence fixture. The source describes its own terms.';
const MAX_DOCUMENT = 400000;
const MAX_RESPONSE = 800000;
const EXACT = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const checkedId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
const descriptor = value => EXACT(value, ['bytes', 'sha256']) && isHash(value.sha256) &&
  Number.isSafeInteger(value.bytes) && value.bytes > 0;

function readPinned(file, expected, limit) {
  if (!descriptor(expected) || expected.bytes > limit || fs.statSync(file).size !== expected.bytes) {
    throw new Error('Invalid or changed equivalence attachment length');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) {
    throw new Error('Equivalence attachment digest mismatch');
  }
  return bytes;
}

function readJson(file, limit = 4000000) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > limit) throw new Error('Invalid JSON input size');
  return parseUnambiguousJson(utf8(fs.readFileSync(file)).replace(/^\uFEFF/, ''));
}

function buildInput(arm, releaseFile, archivePath) {
  if (!EXACT(arm, ['archivePath', 'releaseFile', 'image', 'runtime']) ||
      !EXACT(arm.image, ['sha256', 'bytes', 'manifestDigest']) ||
      !descriptor({ sha256: arm.image.sha256, bytes: arm.image.bytes }) ||
      !/^sha256:[a-f0-9]{64}$/.test(arm.image.manifestDigest) ||
      arm.image.bytes > 256 * 1024 * 1024 ||
      !EXACT(arm.runtime, ['node', 'npm', 'platform', 'arch']) ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(arm.runtime.node) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(arm.runtime.npm) ||
      arm.runtime.platform !== 'linux' || arm.runtime.arch !== 'x64') {
    throw new Error('Exact image identity and runtime required');
  }
  const release = readJson(releaseFile);
  const checked = checkRelease(release);
  if (!checked.valid) throw new Error('Release file did not verify');
  const artifact = { sha256: arm.image.sha256, bytes: arm.image.bytes };
  if (!fs.statSync(archivePath).isFile() || fs.statSync(archivePath).size !== artifact.bytes) {
    throw new Error('OCI archive size did not match its identity');
  }
  return { image: arm.image, release, artifact, runtime: arm.runtime, archivePath };
}

function sourceUrl(value) {
  const parsed = new URL(value);
  if (typeof value !== 'string' || parsed.protocol !== 'https:' || !parsed.hostname ||
      parsed.username || parsed.password || parsed.hash) throw new Error('Official HTTPS capture URL required');
  return value;
}

function loadInput(config) {
  if (!EXACT(config, ['v', 'baseline', 'candidate', 'imageRuntime', 'corpus', 'recordings']) || config.v !== 1 ||
      !EXACT(config.imageRuntime, ['umociPath', 'umociSha256', 'imageLauncherSha256', 'builderFiles']) ||
      !isHash(config.imageRuntime.imageLauncherSha256) || !isHash(config.imageRuntime.umociSha256) ||
      !Array.isArray(config.imageRuntime.builderFiles) ||
      !Array.isArray(config.corpus) || config.corpus.length < 6 || config.corpus.length > 20 ||
      !Array.isArray(config.recordings) || config.recordings.length > 30) throw new Error('Invalid offline release comparison inputs');
  const arms = [config.baseline, config.candidate];
  const resolved = localPaths([
    ...arms.flatMap(arm => [arm?.releaseFile, arm?.archivePath]),
    ...config.corpus.map(item => item?.sourceFile),
    ...config.recordings.map(item => item?.sourceFile),
  ]);
  const sides = arms.map((arm, i) => buildInput(arm, resolved[i * 2], resolved[i * 2 + 1]));
  if (sides[0].image.sha256 === sides[1].image.sha256) throw new Error('Distinct measured archives required');
  const corpus = config.corpus.map((item, i) => {
    if (!EXACT(item, ['id', 'documentType', 'url', 'source', 'sourceFile']) ||
        !checkedId(item.id) || !['terms-of-service', 'privacy-policy'].includes(item.documentType)) {
      throw new Error('Invalid equivalence source case');
    }
    const sourceText = utf8(readPinned(resolved[4 + i], item.source, MAX_DOCUMENT));
    if (!sourceText.trim() || sourceText.includes('\0')) throw new Error('Invalid captured source text');
    return { id: item.id, documentType: item.documentType, url: sourceUrl(item.url), source: item.source, sourceText };
  });
  if (new Set(corpus.map(item => item.id)).size !== corpus.length ||
      new Set(corpus.map(item => item.url)).size !== corpus.length ||
      new Set(corpus.map(item => item.source.sha256)).size !== corpus.length ||
      corpus.filter(item => item.documentType === 'terms-of-service').length !== 4 ||
      corpus.filter(item => item.documentType === 'privacy-policy').length < 2) {
    throw new Error('Expected four distinct terms of service and at least two distinct privacy policies');
  }
  const recordings = config.recordings.map((item, i) => {
    if (!EXACT(item, ['id', 'provider', 'source', 'sourceFile']) ||
        !checkedId(item.id) || !Object.hasOwn(PROVIDERS, item.provider)) throw new Error('Invalid recorded response');
    const body = utf8(readPinned(resolved[4 + corpus.length + i], item.source, MAX_RESPONSE));
    const data = parseUnambiguousJson(body);
    if (item.provider === 'anthropic'
      ? data?.type !== 'message' || !Array.isArray(data.content) || data.content.length === 0
      : data?.object !== 'chat.completion' || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error('Recorded response must retain its original provider envelope');
    }
    if (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(data.id)) {
      throw new Error('Recorded response requires its original provider identity');
    }
    return { id: 'recorded-' + item.id, provider: item.provider, source: item.source, body };
  });
  if (new Set(recordings.map(item => item.provider + ':' + item.id)).size !== recordings.length ||
      new Set(recordings.map(item => item.source.sha256)).size !== recordings.length) {
    throw new Error('Duplicate recorded response');
  }
  return { sides, corpus, recordings, imageRuntime: config.imageRuntime };
}

function replayFixtures() {
  const fence = String.fromCharCode(96).repeat(3);
  const fenced = fence + 'json\n{"fixture":true}\n' + fence;
  return Object.keys(PROVIDERS).flatMap(provider => {
    const body = (content, stop, refusal = null) => provider === 'anthropic'
      ? { content: content === null ? [] : [{ type: 'text', text: content }], stop_reason: stop,
        usage: { input_tokens: 24, output_tokens: 6, cache_creation_input_tokens: 3, cache_read_input_tokens: 5 } }
      : { choices: [{ message: { content, refusal }, finish_reason: stop }],
        usage: { prompt_tokens: 32, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 5 } } };
    const anthropic = provider === 'anthropic';
    const cases = [
      ['malformed', '{"unclosed":', 'malformed-json'],
      ['truncated', JSON.stringify(body('Partial offline fixture.', anthropic ? 'max_tokens' : 'length')), 'truncated'],
      ['fenced-json', JSON.stringify(body(fenced, anthropic ? 'end_turn' : 'stop')), 'fenced-json'],
      ['refusal', JSON.stringify(body(null, anthropic ? 'refusal' : 'stop', 'Offline refusal fixture')), 'refusal'],
      ['ordinary', JSON.stringify(body('Offline response fixture.', anthropic ? 'end_turn' : 'stop')), 'parsed'],
    ];
    return cases.map(([id, raw, expected]) => ({ id, provider, body: raw, expected }));
  });
}

function requestBytes(value, provider) {
  if (!EXACT(value, ['url', 'headers', 'body']) || value.url !== PROVIDERS[provider] ||
      !value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers) ||
      typeof value.body !== 'string' || Buffer.byteLength(value.body) > 1000000) {
    throw new Error('Unsupported offline request output');
  }
  const headers = Object.entries(value.headers);
  const allowed = ['content-type', ...(provider === 'anthropic' ? ['anthropic-version'] : [])];
  if (headers.length !== allowed.length || headers.some(([key, field]) =>
    !allowed.includes(key.toLowerCase()) || typeof field !== 'string' || !field.trim() || /[\r\n]/.test(field)) ||
    new Set(headers.map(([key]) => key.toLowerCase())).size !== allowed.length) {
    throw new Error('Unsupported or credential-bearing offline request headers');
  }
  parseUnambiguousJson(value.body);
  return Buffer.from(JSON.stringify({ url: value.url, headers, body: value.body }));
}

function outputWriter(directory) {
  const target = localPath(directory, { allowMissing: true });
  if (!fs.existsSync(target)) fs.mkdirSync(target);
  if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length) {
    throw new Error('An empty output directory is required');
  }
  const artifacts = path.join(target, 'evidence');
  fs.mkdirSync(artifacts);
  return {
    keep(bytes) {
      const hash = sha(bytes);
      const file = path.join(artifacts, hash);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx' });
      else if (!fs.readFileSync(file).equals(bytes)) throw new Error('Retained equivalence evidence changed');
      return hash;
    },
    report(value) {
      fs.writeFileSync(path.join(target, 'release-classification.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    },
  };
}

async function compareRelease(config, outputDirectory) {
  const { sides, corpus, recordings, imageRuntime } = loadInput(config);
  const writer = outputWriter(outputDirectory);
  const archiveLocations = Object.fromEntries(sides.map(side => [side.image.sha256, side.archivePath]));
  const bridge = imageBridge(imageRuntime, { archiveLocations }, { ...imageRuntime, images: sides.map(side => side.image) });
  try {
    await bridge.ready();
    const measurements = [];
    for (const { image, release } of sides) {
      measurements.push({ image, release, inventory: await bridge.inventory(image.sha256) });
    }
    const [baseline, candidate] = measurements;
    const requests = [];
    const replays = [];
    const replayInputs = [];
    for (const sample of corpus) {
      for (const provider of Object.keys(PROVIDERS)) {
        for (const stage of STAGES) {
          const digests = [];
          for (const side of sides) {
            const build = { artifact: side.artifact, release: side.release, runtime: side.runtime };
            const shaped = await bridge.shapeOffline({ provider, stage, build, buildHash: digest(build),
              sourceUrl: sample.url, sourceText: sample.sourceText, sourceHash: sample.source.sha256,
              prior: stage === 'critic' || stage === 'judge' ? FIXED_PRIOR : null });
            digests.push(writer.keep(requestBytes(shaped, provider)));
          }
          requests.push({ id: sample.id + ':' + provider + ':' + stage, baseline: digests[0], candidate: digests[1] });
        }
      }
    }
    let fixtureCoverage = true;
    for (const replay of [...replayFixtures(), ...recordings]) {
      const id = replay.provider + ':' + replay.id;
      const observed = [];
      const outcomes = [];
      const inputDigest = writer.keep(Buffer.from(replay.body));
      for (const side of sides) {
        const result = await bridge.replay(side.image.sha256, { provider: replay.provider, body: replay.body });
        if (!EXACT(result, ['outcome', 'parsed', 'usage']) || typeof result.outcome !== 'string') {
          throw new Error('Invalid isolated response replay output');
        }
        const usable = typeof result.parsed?.text === 'string' && result.parsed.text.trim() &&
          !Object.hasOwn(result.parsed, 'error');
        outcomes.push(!replay.expected && !usable ? 'provider-error' : result.outcome);
        observed.push(writer.keep(Buffer.from(canonicalJson(result))));
      }
      if (replay.expected && outcomes.some(outcome => outcome !== replay.expected)) fixtureCoverage = false;
      replays.push({ id, baseline: observed[0], candidate: observed[1] });
      replayInputs.push({ id, inputDigest, origin: replay.expected ? 'synthetic' : 'recorded',
        expected: replay.expected ?? null, outcomes });
    }
    const recordedProviders = Object.keys(PROVIDERS).filter(provider => replayInputs.some(entry =>
      entry.id.startsWith(provider + ':') && entry.origin === 'recorded' &&
      entry.outcomes.every(outcome => outcome === 'parsed' || outcome === 'fenced-json')));
    const { hash, ...classification } = classifyRelease({ baseline, candidate, requests, replays, replayInputs });
    const report = seal({ ...classification,
      corpus: corpus.map(({ sourceText, ...entry }) => entry),
      recordedProviders, fixtureCoverage,
      comparisonScope: {
        request: 'Exact serialized request body and public headers in image order. Synthetic authentication is excluded.',
        response: 'Exact relay parse result and normalized usage. Provider receipt identity and timestamp metadata are outside the relay output.',
        fixedPrior: FIXED_PRIOR,
      },
    });
    writer.report(report);
    return report;
  } finally {
    await bridge.close();
  }
}

async function main() {
  if (process.argv.length !== 4) throw new Error('Usage: node tools/release-class.js <input.json> <empty-output-directory>');
  const report = await compareRelease(readJson(localPath(process.argv[2])), process.argv[3]);
  console.log('Offline release classification: ' + report.classification + ' (' + report.reason + ')');
  if (report.classification === 'Q') process.exitCode = 2;
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { compareRelease };
