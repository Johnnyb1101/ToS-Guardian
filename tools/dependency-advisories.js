'use strict';

const { createHash } = require('node:crypto');
const { parseUnambiguousJson } = require('./maintenance-observed-live-transport');

const NPM_ADVISORIES = '/-/npm/v1/security/advisories/bulk';
const GITHUB = 'https://api.github.com';
const GLOBAL_TYPES = ['reviewed', 'unreviewed', 'malware'];
const REPO_PART = '[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}';
const REPOSITORY = new RegExp(`^(?:(?:git\\+)?(?:https://|git://)github\\.com/|git\\+ssh://git@github\\.com/|github:)(${REPO_PART}/${REPO_PART})$`, 'i');
const VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const SEVERITIES = ['unknown', 'info', 'low', 'moderate', 'high', 'critical'];

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const json = bytes => parseUnambiguousJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function publicRepository(value) {
  const url = typeof value === 'string' ? value : value?.url;
  if (typeof url !== 'string') return null;
  return REPOSITORY.exec(url.replace(/\/$/, '').replace(/\.git$/i, ''))?.[1]?.toLowerCase() ?? null;
}

function parseVersion(value) {
  const match = VERSION.exec(value);
  requireCondition(match, 'Unsupported advisory version');
  return { numbers: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}

function compare(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] < right.numbers[i] ? -1 : 1;
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const a = left.pre[i];
    const b = right.pre[i];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (BigInt(a) !== BigInt(b)) return BigInt(a) < BigInt(b) ? -1 : 1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return Math.sign(left.pre.length - right.pre.length);
}

const compareOperations = {
  '<': order => order < 0, '<=': order => order <= 0,
  '>': order => order > 0, '>=': order => order >= 0, '=': order => order === 0,
};

function rangeMatches(version, range) {
  requireCondition(typeof range === 'string' && range.length <= 500 && range.trim(), 'Missing advisory range');
  const installed = parseVersion(version);
  const alternatives = range.split('||').map(alternative => {
    const text = alternative.trim().replace(/(<=|>=|<|>|=)\s+/g, '$1').replace(/\s*,\s*/g, ' ');
    requireCondition(text, 'Empty advisory comparator');
    if (text === '*') return !installed.pre.length;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    const terms = hyphen ? ['>=' + hyphen[1], '<=' + hyphen[2]] : text.split(/\s+/);
    const comparisons = terms.map(term => {
      const match = /^(<=|>=|<|>|=)?(.+)$/.exec(term);
      return { operation: match[1] ?? '=', bound: parseVersion(match[2]) };
    });
    // npm ranges exclude prereleases unless a comparator names that prerelease's release tuple.
    if (installed.pre.length && !comparisons.some(({ bound }) => bound.pre.length &&
      bound.numbers.every((number, i) => number === installed.numbers[i]))) return false;
    return comparisons.every(({ operation, bound }) => compareOperations[operation](compare(installed, bound)));
  });
  return alternatives.some(Boolean);
}

function normalizeFinding(row, source) {
  requireCondition(object(row), 'Invalid advisory record');
  const isNpm = source === 'npm';
  const title = isNpm ? row.title : row.summary;
  const href = isNpm ? row.url : row.html_url;
  const severity = row.severity === 'medium' ? 'moderate' : row.severity;
  requireCondition(typeof title === 'string' && title.length > 0 && title.length <= 1000 &&
    typeof href === 'string' && href.length <= 1000 && SEVERITIES.includes(severity), 'Invalid advisory metadata');
  const url = new URL(href);
  requireCondition(url.protocol === 'https:' && !url.username && !url.password &&
    (isNpm || url.hostname === 'github.com'), 'Invalid advisory source URL');
  const ghsa = isNpm ? url.pathname.split('/').at(-1) : row.ghsa_id;
  const hasGhsa = typeof ghsa === 'string' && GHSA.test(ghsa);
  requireCondition(isNpm ? hasGhsa || Number.isSafeInteger(row.id) : hasGhsa, 'Invalid advisory identifier');
  return { id: hasGhsa ? ghsa.toLowerCase().replace(/^ghsa/, 'GHSA') : 'npm:' + row.id,
    title, severity, url: href, source };
}

function npmFindings(body, entry) {
  const { name, version } = entry;
  requireCondition(object(body) && Object.keys(body).every(key => key === name) &&
    (!Object.hasOwn(body, name) || Array.isArray(body[name]) && body[name].length <= 100), 'Invalid npm advisory response');
  return (body[name] ?? []).map(row => {
    requireCondition(!Object.hasOwn(row ?? {}, 'name') || row.name === name, 'Unexpected npm advisory package');
    const found = normalizeFinding(row, 'npm');
    requireCondition(rangeMatches(version, row.vulnerable_versions), 'npm advisory range disagrees with the exact-version query');
    return { ...found, range: row.vulnerable_versions };
  });
}

function githubFindings(body, entries, source) {
  requireCondition(Array.isArray(body) && body.length <= 100, 'Invalid GitHub advisory response');
  const found = [];
  for (const row of body) {
    requireCondition(object(row) && Array.isArray(row.vulnerabilities) && row.vulnerabilities.length > 0,
      'Missing GitHub advisory vulnerabilities');
    requireCondition(row.withdrawn_at === null || typeof row.withdrawn_at === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(row.withdrawn_at) &&
      Number.isFinite(Date.parse(row.withdrawn_at)), 'Invalid GitHub advisory withdrawal status');
    if (row.withdrawn_at !== null) continue;
    requireCondition(source !== 'github-repository' || row.state === 'published',
      'Unexpected repository advisory state');
    const finding = normalizeFinding(row, source);
    const priorCount = found.length;
    for (const vulnerability of row.vulnerabilities) {
      requireCondition(typeof vulnerability?.package?.name === 'string' &&
        typeof vulnerability.package.ecosystem === 'string', 'Invalid GitHub advisory package');
      if (vulnerability.package.ecosystem !== 'npm') continue;
      const range = vulnerability.vulnerable_version_range;
      for (const entry of entries) {
        if (entry.name === vulnerability.package.name && rangeMatches(entry.version, range)) {
          found.push([entry, { ...finding, range }]);
        }
      }
    }
    requireCondition(source !== 'github-global' || found.length > priorCount,
      'GitHub advisory range disagrees with the exact-version query');
  }
  return found;
}

function nextPage(link, original) {
  if (!link) return null;
  const relations = link.split(/,\s*(?=<)/).map(item => /^<([^<>]+)>;\s*rel="(next|prev|first|last)"$/.exec(item.trim()));
  requireCondition(relations.every(Boolean), 'Malformed GitHub pagination');
  const route = relations.filter(match => match[2] === 'next');
  if (!route.length) return null;
  requireCondition(route.length === 1, 'Ambiguous GitHub pagination');
  const next = new URL(route[0][1]);
  const current = new URL(original, GITHUB);
  const paging = ['page', 'after'];
  requireCondition(next.origin === GITHUB && !next.username && !next.password && !next.hash &&
    next.pathname === current.pathname, 'Unexpected GitHub pagination target');
  const candidate = new URL(current);
  for (const param of paging) candidate.searchParams.delete(param);
  const copied = [];
  for (const [key, value] of next.searchParams) {
    if (!paging.includes(key)) continue;
    requireCondition(/^[A-Za-z0-9_=\-]{1,256}$/.test(value) && !copied.includes(key), 'Invalid GitHub pagination cursor');
    candidate.searchParams.set(key, value);
    copied.push(key);
  }
  requireCondition(copied.length === 1 &&
    [...next.searchParams.keys()].every(key => candidate.searchParams.has(key)) &&
    [...candidate.searchParams.keys()].every(key => {
      const values = next.searchParams.getAll(key);
      return values.length === 1 && values[0] === candidate.searchParams.get(key);
    }), 'GitHub pagination changed the query');
  return candidate.pathname + candidate.search;
}

async function readSource(capture, checks, source, route, options, parse) {
  const check = { source, route, ...(options.query ? { query: options.query } : {}),
    status: 'incomplete', httpStatus: null, sha256: null };
  checks.push(check);
  try {
    const response = await capture(route, { ...options, source });
    requireCondition(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599,
      'Missing HTTP response status');
    check.httpStatus = response.status;
    requireCondition(Buffer.isBuffer(response.bytes) &&
      createHash('sha256').update(response.bytes).digest('hex') === response.sha256, 'Missing raw response evidence');
    check.sha256 = response.sha256;
    if (response.headers) check.headers = response.headers;
    requireCondition(check.httpStatus === 200, `HTTP ${check.httpStatus}`);
    requireCondition(!response.readError, response.readError);
    const value = parse(response);
    check.status = 'complete';
    return value;
  } catch (error) {
    check.error = String(error?.message ?? 'Source request failed').slice(0, 250);
    return null;
  }
}

async function listGitHub(capture, checks, source, route, entries) {
  const visited = new Set();
  let page = route;
  while (page) {
    const result = await readSource(capture, checks, source, page, {}, response => {
      const findings = githubFindings(json(response.bytes), entries, source);
      const next = nextPage(response.link, page);
      visited.add(page);
      requireCondition(!next || (visited.size < 20 && !visited.has(next)), 'Incomplete GitHub pagination');
      return { findings, next };
    });
    if (!result) break;
    for (const [entry, finding] of result.findings) entry.advisories.push(finding);
    page = result.next;
  }
}

async function collectAdvisories(versions, capture, checks) {
  const entries = [...versions.values()];
  if (!entries.length) return;
  for (const entry of entries) {
    const options = { query: { [entry.name]: [entry.version] } };
    const hits = await readSource(capture, checks, 'npm', NPM_ADVISORIES, options,
      response => npmFindings(json(response.bytes), entry));
    if (hits) entry.advisories.push(...hits);
  }
  for (let i = 0; i < entries.length; i += 20) {
    const batch = entries.slice(i, i + 20);
    const affects = batch.map(entry => `${entry.name}@${entry.version}`).join(',');
    for (const type of GLOBAL_TYPES) {
      const query = new URLSearchParams({ ecosystem: 'npm', affects, type, per_page: '100' });
      await listGitHub(capture, checks, 'github-global', '/advisories?' + query, batch);
    }
  }
  const repositories = new Map();
  for (const entry of entries) {
    if (!entry.repository) {
      checks.push({ source: 'github-repository', status: 'incomplete', httpStatus: null,
        sha256: null, package: entry.name, version: entry.version, error: 'Verified public GitHub repository unavailable' });
      continue;
    }
    if (!repositories.has(entry.repository)) repositories.set(entry.repository, []);
    repositories.get(entry.repository).push(entry);
  }
  for (const [repository, subset] of repositories) {
    const route = `/repos/${repository}/security-advisories?state=published&per_page=100`;
    await listGitHub(capture, checks, 'github-repository', route, subset);
  }
}

module.exports = { GITHUB, publicRepository, readSource, collectAdvisories, npmFindings, githubFindings, nextPage };
