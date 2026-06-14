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
  const host = page.host || 'example.com';
  const search = page.search || '';
  const win = { location: { hostname: host, href: `https://${host}${urlPath}${search}`, pathname: urlPath, search } };
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

// Build a fake focused field for the Enter-key path. `ancestors` is nearest-first
// (drives hasAuthProximity, same shape as btn()).
function field({ type = 'text', autocomplete = '', name = '', ancestors = [] } = {}) {
  let parent = null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const child = parent;
    parent = { innerText: ancestors[i].innerText || '', parentElement: child };
  }
  return {
    type,
    getAttribute: (n) => (n === 'type' ? type : n === 'autocomplete' ? autocomplete : n === 'name' ? name : null),
    parentElement: parent
  };
}

function checkEnter(name, page, fld, expected) {
  let got;
  try {
    got = makeCtx(page).shouldFireOnEnterField(fld);
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
// FIXPLAN #3 — search-results pages must never fire (result snippets carry other
// sites' login/signup text; the page is the search engine, not the target site).
check('Google SERP: "Log in to your PayPal account" snippet → no fire',
  { host: 'www.google.com', path: '/search', search: '?q=paypal', emails: [{}], bodyText: 'paypal login sign up for paypal' },
  btn({ text: 'Log in to your PayPal account' }), false);
check('search results never fire even with an auth form present',
  { host: 'www.bing.com', path: '/search', search: '?q=login', password: true },
  btn({ text: 'Sign in' }), false);

// --- Enter-key trigger (formless logins) ---------------------------------
// Password field is unambiguous auth → fires on any page.
checkEnter('Enter on password field fires (any page)', {}, field({ type: 'password' }), true);
checkEnter('Enter on password field fires on a generic subdomain path', { path: '/account' },
  field({ type: 'password' }), true);
// Email/username field fires only in a real auth context.
checkEnter('Enter on email field on /register fires', { path: '/register' }, field({ type: 'email' }), true);
checkEnter('Enter on autocomplete=username field on /login fires', { path: '/login' },
  field({ autocomplete: 'username' }), true);
checkEnter('Enter on email field in an auth modal fires via proximity', { path: '/', bodyText: 'welcome' },
  field({ type: 'email', ancestors: [{ innerText: 'Log in or sign up' }] }), true);
checkEnter('Enter on email field with page agreement context fires', { path: '/', bodyText: 'by signing up you agree to our terms of service' },
  field({ type: 'email' }), true);
// Must NOT fire: bare email field with no auth context (newsletter/search/contact).
checkEnter('Enter on email field on a newsletter page does not fire', { path: '/', bodyText: 'subscribe to our newsletter for updates' },
  field({ type: 'email' }), false);
checkEnter('Enter in a plain text/search field does not fire', { path: '/', bodyText: 'search the site' },
  field({ type: 'text', name: 'q' }), false);
// SERP guard applies to the Enter path too.
checkEnter('Enter on a search-results page never fires', { host: 'www.google.com', path: '/search', search: '?q=paypal' },
  field({ type: 'password' }), false);

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
