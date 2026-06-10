// TOS Guardian — Button detection tests (content.js isAgreeButton)
//
// content.js runs in a page context, so it has no automated coverage from the
// other suites. This harness loads the real content-script files into a vm with
// a minimal, per-test DOM mock and exercises isAgreeButton directly — covering
// the signup/login detection gap that let sites slip through silently.
//
// Note: domainIsKnown is a content.js closure variable that defaults to false
// and cannot be toggled from outside the vm, so every case here models the
// harder UNKNOWN-domain path (the one that actually matters for coverage).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const noop = () => {};
const rows = [];

// Build a content-script context with a DOM shaped by `page`:
//   page.password  -> document has an input[type=password]
//   page.emails    -> array used as the email/username input NodeList
//   page.bodyText  -> document.body.innerText (drives pageHasAgreementContext)
function makeCtx(page = {}) {
  const doc = {
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    querySelector: (sel) => (sel.includes('password') ? (page.password ? {} : null) : null),
    querySelectorAll: (sel) => (/email|user/i.test(sel) ? (page.emails || []) : []),
    body: { innerText: page.bodyText || '', querySelectorAll: () => [] },
    documentElement: { innerHTML: '' }
  };
  const urlPath = page.path || '/';
  const win = { location: { hostname: 'example.com', href: `https://example.com${urlPath}`, pathname: urlPath } };
  win.top = win; // not a frame
  const browser = {
    runtime: { onMessage: { addListener: noop }, sendMessage: noop, lastError: null },
    storage: { local: { get: noop, set: noop } },
    tabs: {}
  };
  const ctx = {
    console: { log: noop, warn: noop, error: noop },
    document: doc,
    window: win,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 0,
    clearTimeout: noop,
    URL,
    chrome: browser,
    browser
  };
  vm.createContext(ctx);
  for (const f of ['tosUtils.js', 'shadowDom.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

// Build a fake button element. `ancestors` is nearest-first; each entry may set
// innerText and/or legalLink (whether that ancestor contains a Terms/Privacy link).
function btn({ text = '', value = '', ariaLabel = '', title = '', ancestors = [] } = {}) {
  let parent = null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    const child = parent;
    parent = {
      innerText: a.innerText || '',
      parentElement: child,
      querySelector: (sel) =>
        (a.legalLink && /terms|privacy|legal|user-agreement/i.test(sel) ? {} : null)
    };
  }
  return {
    innerText: text,
    value,
    getAttribute: (n) => (n === 'aria-label' ? ariaLabel : n === 'title' ? title : null),
    parentElement: parent
  };
}

function check(name, page, button, expected) {
  let got;
  try {
    got = makeCtx(page).isAgreeButton(button);
  } catch (e) {
    got = `THREW: ${e.message}`;
  }
  rows.push({ status: got === expected ? 'PASS' : 'FAIL', name, expected, got });
}

// --- Should fire ---------------------------------------------------------
check('explicit "I Agree" fires on label alone', {}, btn({ text: 'I Agree' }), true);
check('"Agree & Join" (LinkedIn) fires', {}, btn({ text: 'Agree & Join' }), true);
check('"Sign up" + password field fires', { password: true }, btn({ text: 'Sign up' }), true);
check('"Sign up" + email field fires', { emails: [{}] }, btn({ text: 'Sign up' }), true);
check('"Create my account" + password fires (substring-robust)', { password: true }, btn({ text: 'Create my account' }), true);
check('"Continue" + ancestor consent text fires', { bodyText: 'welcome' },
  btn({ text: 'Continue', ancestors: [{ innerText: 'By continuing you agree to our Terms of Use' }] }), true);
check('"Continue" + nearby legal link fires (Substack-style modal)', { bodyText: 'welcome' },
  btn({ text: 'Continue', ancestors: [{ innerText: '', legalLink: true }] }), true);
check('"Sign in" + auth form fires', { emails: [{}], bodyText: 'log in' }, btn({ text: 'Sign in' }), true);
check('"Continue with Google" + page agreement context fires', { bodyText: 'by signing up you agree to our privacy policy' },
  btn({ text: 'Continue with Google' }), true);
check('"Get started" + page agreement context fires', { bodyText: 'you agree to the terms of service' },
  btn({ text: 'Get started' }), true);
check('magic-link login: "Continue" + email + auth-modal text fires (Substack)',
  { emails: [{}], bodyText: 'discover more writers' },
  btn({ text: 'Continue', ancestors: [{ innerText: 'Log in or sign up Continue' }] }), true);
check('dedicated /sign-in page: "Continue" + email fires via URL',
  { emails: [{}], path: '/sign-in', bodyText: 'welcome back' }, btn({ text: 'Continue' }), true);
check('"Sign in" submit + email field fires', { emails: [{}], path: '/login', bodyText: 'welcome back' },
  btn({ text: 'Sign in' }), true);

// --- Should NOT fire -----------------------------------------------------
check('"Continue" + email only, no consent → no fire (avoid checkout false-positive)',
  { emails: [{}], bodyText: 'add to cart and continue shopping' }, btn({ text: 'Continue' }), false);
check('header "Sign in", no auth form / no consent → no fire',
  { bodyText: 'welcome to our homepage' }, btn({ text: 'Sign in' }), false);
check('bare "Sign up", no context → no fire',
  { bodyText: 'hello there' }, btn({ text: 'Sign up' }), false);
check('non-action "Learn more" never fires even with agreement context',
  { emails: [{}], bodyText: 'privacy policy and terms of service' }, btn({ text: 'Learn more' }), false);
check('empty label → no fire', {}, btn({ text: '' }), false);

// --- Report --------------------------------------------------------------
const widths = {
  status: 6,
  name: Math.max(...rows.map(r => r.name.length)),
  expected: 8
};
for (const r of rows) {
  console.log(
    `${r.status.padEnd(widths.status)} | ${r.name.padEnd(widths.name)} | expected ${String(r.expected).padEnd(5)} | got ${r.got}`
  );
}
const passed = rows.filter(r => r.status === 'PASS').length;
const failed = rows.filter(r => r.status === 'FAIL').length;
console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
