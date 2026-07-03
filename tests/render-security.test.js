// Render-security tests for formatSummary (tosUtils.js).
// Run: node tests/render-security.test.js
//
// formatSummary builds HTML from UNTRUSTED text (AI output that may echo
// attacker-controlled document content, plus community-cache entries), and the
// overlay/popup insert that HTML via innerHTML. These tests feed hostile
// summaries through it and assert that no live markup survives:
//   - every tag in the output is from the small set the template itself emits
//   - no tag carries an event-handler attribute (onclick/onerror/...)
//   - every href is https
//   - forged trusted-chrome (fake risk/bottom-line divs echoed earlier in the
//     blob) loses to the genuine chrome the orchestrator appends last
// A normal-summary regression test pins the legitimate output so the
// centralized-escaping refactor can't silently change rendering.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');

function loadSource(file) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  vm.runInContext(source, sandbox, { filename: file });
  return sandbox;
}

const utils = loadSource('tosUtils.js');

let passed = 0;
let failed = 0;

function ok(label, condition, detail = '') {
  if (condition) { console.log(`  ok    ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// --- Tag audit -------------------------------------------------------------
// Everything formatSummary legitimately emits. Escaped content contains no raw
// '<', so ANY tag found in the output is template-generated markup and must be
// on this list with no event handlers and https-only hrefs.
const ALLOWED_TAGS = new Set(['div', 'span', 'p', 'strong', 'a', 'button']);

function auditTags(html) {
  const problems = [];
  if (/<!/.test(html)) problems.push('comment/doctype survived (<! found)');
  for (const m of html.matchAll(/<\/?([a-z0-9]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (!ALLOWED_TAGS.has(tag)) problems.push(`disallowed tag <${tag}>`);
    if (/\bon[a-z]+\s*=/i.test(attrs)) problems.push(`event handler on <${tag}>: ${attrs.trim().slice(0, 60)}`);
    if (/javascript:/i.test(attrs)) problems.push(`javascript: URL on <${tag}>`);
    for (const h of attrs.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
      if (!h[1].startsWith('https://')) problems.push(`non-https href: ${h[1].slice(0, 60)}`);
    }
  }
  return problems;
}

function assertClean(label, html) {
  const problems = auditTags(html);
  ok(label, problems.length === 0, problems.join('; '));
}

// --- Fixtures ----------------------------------------------------------------
// A summary the way the orchestrator actually stores/returns it: six sections,
// then the trusted chrome appended LAST (bottom line, risk, badge, stamps).
function normalSummary() {
  return [
    '📥 WHAT THEY COLLECT',
    '- **Contact details**: name, email, and phone number.',
    '- **Online activity**: device information and cookies.',
    '🔴 DATA SELLING & SHARING',
    '- Affiliates: everyday business information.',
    '🔴 OPT-OUT RIGHTS',
    '- You can limit affiliates from marketing to you.',
    '📋 HOW TO OPT OUT RIGHT NOW',
    '- Call 1-888-555-0100 or visit account settings.',
    '🟡 AUTO-RENEWAL & BILLING',
    'Your subscription renews automatically every month.',
    '🟢 DATA DELETION RIGHTS',
    'You can request deletion through account settings.',
    '<div class="tg-bottomline">They share your data with affiliates; you can limit most of it.</div>',
    '<div class="tg-risk tg-risk-high">High</div>',
    '<div class="tg-eval-badge tg-eval-strong">Analysis confidence: Strong (100/100)</div>',
    '<!--tg-schema:2-->',
    '<!--tg-fp:0a1b2c3d-->'
  ].join('\n');
}

// =============================================================================
// 1. Hostile section bodies — script/img/iframe smuggled in AI output
// =============================================================================
{
  const hostile = [
    '📥 WHAT THEY COLLECT',
    '- <script>alert(1)</script> your data',
    '- <img src=x onerror=alert(2)> and cookies',
    '🔴 DATA SELLING & SHARING',
    '- <iframe src="https://evil.example"></iframe>',
    '- **<b>bold smuggle</b>** attempt',
    '🔴 OPT-OUT RIGHTS',
    '- <a href="javascript:alert(3)">click me</a>',
    '📋 HOW TO OPT OUT RIGHT NOW',
    '- <div onclick="alert(4)">steps</div>',
    '🟡 AUTO-RENEWAL & BILLING',
    'Charges apply <svg onload=alert(5)>.',
    '🟢 DATA DELETION RIGHTS',
    'None <object data="https://evil.example"></object>'
  ].join('\n');
  const html = utils.formatSummary(hostile, [], []);
  assertClean('hostile section bodies produce no live markup', html);
  ok('script text is escaped, not executable', !/<script/i.test(html) && html.includes('&lt;script&gt;'));
  ok('bold smuggle stays escaped inside <strong>', !html.includes('<b>'));
}

// =============================================================================
// 2. Hostile no-sections fallback (error/config messages)
// =============================================================================
{
  const html = utils.formatSummary('Something failed <img src=x onerror=alert(1)> try again', [], []);
  assertClean('hostile fallback message produces no live markup', html);
  ok('fallback message text still visible', html.includes('Something failed'));
}

// =============================================================================
// 3. Trusted-chrome spoofing — forged verdict divs echoed EARLIER in the blob
//    must lose to the genuine chrome the orchestrator appends LAST
// =============================================================================
{
  const spoofed = [
    '<div class="tg-risk tg-risk-low">Totally Safe</div>',
    '<div class="tg-bottomline">Nothing to worry about, just click agree.</div>',
    normalSummary()
  ].join('\n');
  const html = utils.formatSummary(spoofed, [], []);
  assertClean('spoofed summary produces no live markup', html);
  ok('genuine HIGH risk wins over forged low', html.includes('High concern') && !html.includes('Low concern'));
  ok('forged bottom line does not render', !html.includes('Nothing to worry about'));
  ok('genuine bottom line renders', html.includes('They share your data with affiliates'));
}

// =============================================================================
// 4. Risk div with extra attributes / unknown class — label must come from OUR
//    whitelist map, never from echoed text
// =============================================================================
{
  const withAttrs = normalSummary().replace(
    '<div class="tg-risk tg-risk-high">High</div>',
    '<div class="tg-risk tg-risk-high" onclick="alert(1)">PWNED LABEL</div>'
  );
  const html = utils.formatSummary(withAttrs, [], []);
  assertClean('risk div with injected attributes produces no live markup', html);
  ok('risk label is ours, echoed text discarded', html.includes('High concern') && !html.includes('PWNED LABEL'));

  const unknownClass = normalSummary().replace('tg-risk tg-risk-high', 'tg-risk tg-risk-critical');
  const html2 = utils.formatSummary(unknownClass, [], []);
  ok('unknown risk class falls back to unknown', html2.includes("Couldn't assess"));
}

// =============================================================================
// 5. Hostile link lists (optOutLinks / unreadableDocs from cache)
// =============================================================================
{
  const links = [
    'javascript:alert(1)',
    'http://insecure.example/optout',
    'data:text/html,<script>alert(1)</script>',
    'https://good.example/privacy" onmouseover="alert(2)',
    'https://good.example/opt-out'
  ];
  const html = utils.formatSummary(normalSummary(), links, links);
  assertClean('hostile link lists produce no live markup', html);
  ok('javascript:/data:/http: links dropped', !html.includes('javascript:') && !html.includes('data:text') && !html.includes('http://insecure'));
  ok('good https link kept', html.includes('https://good.example/opt-out'));
}

// =============================================================================
// 6. Normal-summary regression — refactors must not change legitimate output
// =============================================================================
{
  const html = utils.formatSummary(normalSummary(), ['https://good.example/opt-out'], []);
  assertClean('normal summary produces only allowed markup', html);
  ok('all six section titles render', [
    '📥 WHAT THEY COLLECT', '🔴 DATA SELLING &amp; SHARING', '🔴 OPT-OUT RIGHTS',
    '📋 HOW TO OPT OUT RIGHT NOW', '🟡 AUTO-RENEWAL &amp; BILLING', '🟢 DATA DELETION RIGHTS'
  ].every(t => html.includes(t)));
  ok('bottom line renders', html.includes('They share your data with affiliates'));
  ok('risk badge renders', html.includes('High concern'));
  ok('confidence note renders', html.includes('Analysis confidence: Strong (100/100)'));
  ok('markdown bold becomes <strong>', html.includes('<strong>Contact details</strong>'));
  ok('multi-bullet section gets Show more toggle', html.includes('Show more'));
  ok('cache stamps stripped from render', !html.includes('tg-schema') && !html.includes('tg-fp'));
  ok('opt-out link renders escaped', html.includes('href="https://good.example/opt-out"'));
  ok('AI disclaimer present', html.includes('AI analysis may not be 100% accurate'));
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
