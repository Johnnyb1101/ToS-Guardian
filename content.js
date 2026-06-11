const hookedButtons = new WeakSet();
const browser = globalThis.browser || chrome;
const isFrame = window.top !== window;

function hasProximityConsent(el) {
  const consentPhrases = [
    "by clicking", "by continuing", "by signing up",
    "by registering", "by creating", "by joining",
    "you agree", "you accept", "you consent",
    "terms of service", "terms and conditions", "terms of use",
    "privacy policy", "our terms", "our policies",
    "user agreement", "legal agreement", "end user license"
  ];

  let node = el.parentElement;
  for (let i = 0; i < 6; i++) {
    if (!node) break;
    const text = node.innerText?.toLowerCase() || "";
    if (consentPhrases.some(phrase => text.includes(phrase))) return true;
    // Links to legal docs right next to the action are a strong consent signal
    // even without explicit "you agree" prose — signup modals almost always
    // have Terms/Privacy links beside the button. Scoped to the button's own
    // container (6 ancestors), so a page-footer link won't trigger this.
    if (typeof node.querySelector === "function" &&
        node.querySelector('a[href*="terms" i], a[href*="privacy" i], a[href*="legal" i], a[href*="user-agreement" i]')) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function pageHasPasswordField() {
  return !!document.querySelector('input[type="password"]');
}

function pageHasAuthForm() {
  if (pageHasPasswordField()) return true;
  const emailInputs = document.querySelectorAll('input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="email"], input[name*="user"]');
  if (emailInputs.length > 0) return true;
  return false;
}

function pageHasAgreementContext() {
  const pageText = document.body?.innerText?.toLowerCase() || "";
  const agreementContext = [
    "by clicking", "by continuing", "by signing up",
    "you agree", "terms of service", "privacy policy",
    "terms and conditions", "terms of use", "user agreement",
    "legal agreement", "end user license"
  ];
  return agreementContext.some(phrase => pageText.includes(phrase));
}

function shouldRunInFrame() {
  if (!isFrame) return true;
  return pageHasAuthForm() || pageHasAgreementContext();
}

// True when the URL path itself names an auth page (e.g. /login, /sign-up).
function pageUrlLooksLikeAuth() {
  const path = (window.location?.pathname || "").toLowerCase();
  return /(^|\/)(log[-_]?in|sign[-_]?in|sign[-_]?up|signin|signup|register|registration|auth|join)(\/|$)/.test(path);
}

// True when auth-intent text sits right around the button (e.g. a login/signup
// modal heading like "Log in or sign up"). Scoped tight (4 ancestors) so a
// header "Sign in" link elsewhere on the page doesn't count.
function hasAuthProximity(el) {
  const authPhrases = [
    "sign in", "signin", "log in", "login",
    "sign up", "signup", "create account", "create an account",
    "create your account", "forgot password", "reset password",
    "log in or sign up"
  ];
  let node = el.parentElement;
  for (let i = 0; i < 4; i++) {
    if (!node) break;
    const text = node.innerText?.toLowerCase() || "";
    if (authPhrases.some(p => text.includes(p))) return true;
    node = node.parentElement;
  }
  return false;
}

function isAgreeButton(el) {
  const text = el.innerText?.toLowerCase().trim() || "";
  const value = el.value?.toLowerCase().trim() || "";
  const ariaLabel = el.getAttribute?.("aria-label")?.toLowerCase().trim() || "";
  const title = el.getAttribute?.("title")?.toLowerCase().trim() || "";
  const combined = text || value || ariaLabel || title;
  if (!combined) return false;

  // High confidence: explicit agree/accept/signup language — fire on the label alone.
  const highConfidence = [
    "i agree", "agree & continue", "agree and continue", "agree & join", "agree and join",
    "accept all", "accept & continue", "accept and continue", "i accept", "i consent",
    "continue with sso", "sign up free", "sign up with email"
  ];
  if (highConfidence.some(k => combined.includes(k))) return true;

  // Account-creation intent. Matched broadly ("create my account", "create your
  // profile") because creating an account always forms an agreement — but every
  // path below still requires real auth context before it fires.
  const signupIntent =
    /\bsign\s?up\b/.test(combined) ||
    /\bregister\b/.test(combined) ||
    /\bcreate\b[\s\w]{0,15}\b(account|profile)\b/.test(combined) ||
    /\bjoin\b/.test(combined);

  // Sign-in / SSO actions.
  const signin = [
    "sign in", "signin", "log in", "login", "sign in with",
    "continue with google", "continue with facebook", "continue with apple",
    "continue with microsoft", "continue with email"
  ].some(k => combined.includes(k));

  // Weak, generic progression words — only fire with strong context.
  const generic = ["continue", "get started", "join now", "join free"]
    .some(k => combined.includes(k));

  if (!signupIntent && !signin && !generic) return false;

  // Everything below requires real context so generic words never fire on
  // arbitrary pages.

  // Consent text or legal links right next to the button.
  if (hasProximityConsent(el)) return true;

  // A password field means this is unambiguously a login/signup flow.
  if (pageHasPasswordField()) return true;

  const authForm = pageHasAuthForm();

  // Account creation + an auth form on the page.
  if (signupIntent && authForm) return true;

  // Signing in (incl. SSO) on a page that has an auth form.
  if (signin && authForm) return true;

  // Generic "continue" is weak, so it only fires when the page clearly IS an
  // auth page — an auth form plus an auth-looking URL or auth text right around
  // the button. Catches magic-link logins (no password field, no Terms links)
  // without firing on e-commerce "Continue" buttons that merely sit near an
  // email box.
  if (generic && authForm && (pageUrlLooksLikeAuth() || hasAuthProximity(el))) return true;

  // On domains we already know host legal docs, be more permissive.
  if (domainIsKnown && (signin || signupIntent || authForm)) return true;

  // Page-wide agreement context (SSO buttons, etc.).
  return pageHasAgreementContext();
}

// Walk up from a clicked element to find the nearest hooked agree button.
// Uses composedPath when available to cross shadow DOM boundaries.
function findHookedAncestor(el, composedPath = null) {
  if (composedPath) {
    for (const node of composedPath) {
      if (node.dataset?.tgHooked === "true") return node;
    }
  }
  while (el && el !== document.body) {
    if (el.dataset?.tgHooked === "true") return el;
    el = el.parentElement;
  }
  return null;
}

function findAgreeControl(el, composedPath = null) {
  const candidates = composedPath || [];
  for (const node of candidates) {
    if (!node || typeof node.getAttribute !== "function") continue;
    const tag = node.tagName?.toLowerCase();
    const buttonLike = tag === "button" || tag === "a" ||
      (tag === "input" && ["submit", "button"].includes(node.type)) ||
      node.getAttribute("role") === "button";
    if (buttonLike && isAgreeButton(node)) return node;
  }

  let node = el;
  while (node && node !== document.body) {
    const tag = node.tagName?.toLowerCase();
    const buttonLike = tag === "button" || tag === "a" ||
      (tag === "input" && ["submit", "button"].includes(node.type)) ||
      node.getAttribute?.("role") === "button";
    if (buttonLike && isAgreeButton(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function showGuardianOverlay(event, sourceButton = null) {
  const clickedButton = sourceButton || event.currentTarget || event.target;

  const existingOverlay = document.getElementById("tos-guardian-overlay");
  if (existingOverlay) existingOverlay.remove();

  const overlay = document.createElement("div");
  overlay.id = "tos-guardian-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.55); z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    font-family: 'DM Sans', system-ui, sans-serif;
  `;

  const overlayRoot = overlay.attachShadow({ mode: "closed" });
  overlayRoot.innerHTML = `
    <style>
      #tg-card { all:initial; box-sizing:border-box; background:#fff; border-radius:14px; box-shadow:0 8px 40px rgba(0,0,0,0.18); max-width:620px; width:min(620px,calc(100vw - 24px)); max-height:calc(100vh - 24px); overflow:hidden; display:flex; flex-direction:column; color:#111; font-family:Arial,Helvetica,sans-serif; }
      #tg-card * { box-sizing:border-box; font-family:inherit; }
      #tg-card-topbar { height:4px; background:#1a1aff; }
      #tg-card-header { display:flex; align-items:center; gap:12px; padding:16px 20px 14px; border-bottom:1px solid #f0f0f0; }
      #tg-card-shield { width:34px; height:34px; background:#1a1aff; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
      #tg-card-shield-icon { width:16px; height:18px; background:#fff; clip-path:polygon(50% 0%,100% 25%,100% 70%,50% 100%,0% 70%,0% 25%); }
      #tg-card-title { font-size:14px; font-weight:600; color:#111; }
      #tg-card-subtitle { font-size:12px; color:#aaa; margin-top:1px; }
      #tg-summary { padding:4px 0; flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; pointer-events:all; }
      #tg-summary-loading { padding:28px 20px; display:flex; align-items:center; gap:12px; color:#888; font-size:13px; }
      #tg-spinner { width:20px; height:20px; border:2px solid #ebebeb; border-top-color:#1a1aff; border-radius:50%; animation:tg-spin 0.75s linear infinite; flex-shrink:0; }
      @keyframes tg-spin { to { transform:rotate(360deg); } }
      .tg-category { padding:11px 20px; border-bottom:1px solid #f5f5f5; }
      .tg-category-title { font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#000; margin-bottom:4px; display:block; }
      .tg-category-body { font-size:13px; color:#333; line-height:1.6; }
      .tg-optout-links { margin:10px 20px; padding:10px 12px; background:#f5fff8; border:1px solid #b2dfc0; border-radius:8px; }
      .tg-optout-title { font-size:11px; font-weight:600; color:#1a7a3c; margin-bottom:6px; }
      .tg-optout-link { display:block; font-size:11px; color:#1a1aff; text-decoration:none; word-break:break-all; margin-bottom:3px; }
      .tg-optout-link:hover { text-decoration:underline; }
      .tg-eval-warning { margin:8px 20px 0; padding:8px 12px; background:#fff8ee; border:1px solid #f5dfa0; border-radius:8px; color:#7a5000; font-size:12px; line-height:1.5; }
      .tg-eval-badge { margin:8px 20px 4px; padding:4px 10px; border-radius:20px; font-size:11px; font-weight:500; display:inline-block; }
      .tg-eval-strong   { background:#f0fff4; color:#1a7a3c; border:1px solid #b2dfc0; }
      .tg-eval-adequate { background:#fff8ee; color:#b7770d; border:1px solid #f5dfa0; }
      .tg-eval-failed   { background:#fff0f0; color:#c0392b; border:1px solid #f5c6c6; }
      .tg-bottomline { margin:16px 20px 6px; font-size:15px; font-weight:600; color:#111; line-height:1.45; }
      .tg-risk { margin:2px 20px 10px; padding:6px 14px; border-radius:20px; font-size:13px; font-weight:700; display:inline-block; }
      .tg-risk-low { background:#f0fff4; color:#1a7a3c; border:1px solid #b2dfc0; }
      .tg-risk-moderate { background:#fff8ee; color:#b7770d; border:1px solid #f5dfa0; }
      .tg-risk-high { background:#fff0f0; color:#c0392b; border:1px solid #f5c6c6; }
      .tg-risk-unknown { background:#f3f4f6; color:#555; border:1px solid #d1d5db; }
      .tg-details-toggle { margin:6px 20px; padding:6px 0; background:none; border:none; color:#1a1aff; font-size:12px; font-weight:600; cursor:pointer; display:block; text-align:left; }
      .tg-details-toggle:hover { text-decoration:underline; }
      .tg-details { display:none; }
      .tg-details.tg-open { display:block; }
      .tg-confidence-note { margin:10px 20px 0; font-size:11px; color:#aaa; text-align:center; }
      #tg-card-footer { display:none; gap:10px; padding:14px 20px; border-top:1px solid #f0f0f0; align-items:center; }
      #tg-card-footer.tg-ready { display:flex; }
      #tg-card button { appearance:none; -webkit-appearance:none; text-transform:none; letter-spacing:normal; line-height:normal; margin:0; }
      #tg-proceed { flex:1 1 0; min-width:0; height:40px; padding:0 10px; background:#b91c1c; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; }
      #tg-proceed:hover { background:#991b1b; }
      #tg-leave { flex:1 1 0; min-width:0; height:40px; padding:0 10px; background:#9ca3af; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; }
      #tg-leave:hover { background:#6b7280; }
    </style>

    <div id="tg-card">
      <div id="tg-card-topbar"></div>
      <div id="tg-card-header">
        <div id="tg-card-shield"><div id="tg-card-shield-icon"></div></div>
        <div>
          <div id="tg-card-title">TOS Guardian</div>
          <div id="tg-card-subtitle">Reading the fine print before you agree</div>
        </div>
      </div>
      <div id="tg-summary">
        <div id="tg-summary-loading">
          <div id="tg-spinner"></div>
          Analyzing this agreement - reading the fine print...
        </div>
      </div>
      <div id="tg-card-footer">
        <button id="tg-proceed">Accept Risk and Continue</button>
        <button id="tg-leave">Go Back Safely</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const revealActions = () => {
    overlayRoot.getElementById("tg-card-footer")?.classList.add("tg-ready");
  };

  overlayRoot.getElementById("tg-summary").addEventListener("wheel", (e) => {
    e.stopPropagation();
  }, { passive: true });

  overlayRoot.getElementById("tg-proceed").addEventListener("click", () => {
    interceptActive = false;
    acknowledgedDomains.add(window.location.hostname);
    overlay.remove();
    browser.runtime.sendMessage({ action: "acknowledge", domain: window.location.hostname });
    setTimeout(() => {
      if (!clickedButton || !clickedButton.isConnected) return;
      if (clickedButton instanceof HTMLFormElement) {
        if (typeof clickedButton.requestSubmit === "function") clickedButton.requestSubmit();
        else clickedButton.submit();
        return;
      }
      if (typeof clickedButton.click === "function") clickedButton.click();
    }, 0);
  });

  overlayRoot.getElementById("tg-leave").addEventListener("click", () => {
    interceptActive = false;
    overlay.remove();
  });

  const fullText = document.body.innerText;
  let analysisResponded = false;
  const analysisTimer = setTimeout(() => {
    if (analysisResponded) return;
    const summaryEl = overlayRoot.getElementById("tg-summary");
    if (summaryEl) {
      summaryEl.innerHTML = formatSummary(
        "TOS Guardian is still analyzing this agreement. Some sites take longer because legal pages and opt-out links have to be fetched and checked.",
        []
      );
    }
  }, 45000);

  browser.runtime.sendMessage(
    {
      action: "analyzeTos",
      text: fullText,
      pageUrl: window.location.href,
      pageHtml: document.documentElement.innerHTML
    },
    (result) => {
      if (analysisResponded) return;
      analysisResponded = true;
      clearTimeout(analysisTimer);
      const summaryEl = overlayRoot.getElementById("tg-summary");
      if (summaryEl) {
        if (browser.runtime.lastError) {
          summaryEl.innerHTML = formatSummary(
            "TOS Guardian could not reach the background service worker. Reload the extension and try again.",
            []
          );
          revealActions();
          return;
        }
        summaryEl.innerHTML = formatSummary(
          result?.summary || "Could not analyze this page.",
          result?.optOutLinks || []
        );
        // Wire the "Show full breakdown" expander (progressive disclosure):
        // the five detailed sections stay collapsed until the user asks.
        const detailsToggle = overlayRoot.getElementById("tg-details-toggle");
        const detailsPanel = overlayRoot.getElementById("tg-details");
        if (detailsToggle && detailsPanel) {
          detailsToggle.addEventListener("click", () => {
            const open = detailsPanel.classList.toggle("tg-open");
            detailsToggle.textContent = open ? "Hide full breakdown ▴" : "Show full breakdown ▾";
          });
        }
        revealActions();
      }
    }
  );
}

// --- EVENT DELEGATION ---
// Single capture-phase listener on document handles all agree-button clicks.
// Resilient to React re-rendering DOM nodes.
let interceptActive = false;
const acknowledgedDomains = new Set();

document.addEventListener("click", (event) => {
  if (acknowledgedDomains.has(window.location.hostname)) return;
  if (interceptActive) return;

  const eventPath = event.composedPath();
  const hookedEl = findHookedAncestor(event.target, eventPath) ||
    findAgreeControl(event.target, eventPath);
  if (!hookedEl) return;
  if (hookedEl.dataset) hookedEl.dataset.tgHooked = "true";

  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
  interceptActive = true;
  setTimeout(() => { interceptActive = false; }, 5000);

  console.log('[TOS Guardian] Intercepted click on:', hookedEl.tagName);

  const domain = window.location.hostname;

  let responded = false;
  const fallbackTimer = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.warn('[TOS Guardian] Background service worker did not respond — showing overlay');
      showGuardianOverlay(event, hookedEl);
    }
  }, 8000);

  browser.runtime.sendMessage(
    { action: "checkCache", domain },
    (response) => {
      if (responded) return;
      responded = true;
      clearTimeout(fallbackTimer);

      if (browser.runtime.lastError) {
        console.warn('[TOS Guardian] Message channel error:', browser.runtime.lastError.message);
        showGuardianOverlay(event, hookedEl);
        return;
      }
      if (response && response.acknowledged) {
        interceptActive = false;
        acknowledgedDomains.add(domain);
        return;
      }
      showGuardianOverlay(event, hookedEl);
    }
  );
}, true);

document.addEventListener("submit", (event) => {
  if (acknowledgedDomains.has(window.location.hostname)) return;
  if (interceptActive) return;

  const form = event.target;
  if (!form || form.tagName !== "FORM") return;

  const submitButtons = form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
  let agreeBtn = null;
  submitButtons.forEach(btn => { if (isAgreeButton(btn)) agreeBtn = btn; });

  if (!agreeBtn) {
    if (!pageHasAgreementContext()) return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const syntheticEvent = { preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {}, target: agreeBtn || form, currentTarget: form };
  interceptActive = true;
  setTimeout(() => { interceptActive = false; }, 5000);
  showGuardianOverlay(syntheticEvent, agreeBtn || form);
}, true);

// --- BUTTON MARKING ---
// attachToButtons only marks elements with data-tg-hooked — no per-element listeners.
function attachToButtons() {
  document.querySelectorAll("button, a, [role='button']").forEach(el => {
    if (el.dataset?.tgHooked === "true") return;
    if (isAgreeButton(el)) {
      el.dataset.tgHooked = "true";
      console.log('[TOS Guardian] Marked button:', el.innerText?.trim().substring(0, 30));
    }
  });
  hookShadowButtons(document.body);
}

function attachToForms() {
  // Forms are handled by the document-level submit listener — no per-form hooking needed
}

let domainIsKnown = false;

function initTosGuardian() {
  if (!shouldRunInFrame()) return;

  const domain = window.location.hostname;

  let initResponded = false;
  const initFallback = setTimeout(() => {
    if (!initResponded) {
      initResponded = true;
      console.warn('[TOS Guardian] Init: service worker did not respond — hooking buttons without site check');
      attachToButtons();
    }
  }, 2000);

  browser.runtime.sendMessage({ action: "checkCache", domain }, (response) => {
    if (initResponded) return;
    initResponded = true;
    clearTimeout(initFallback);

    if (browser.runtime.lastError) {
      console.warn('[TOS Guardian] Init: message channel error:', browser.runtime.lastError.message);
    } else {
      if (response && response.knownSite) domainIsKnown = true;
      if (response && response.acknowledged) acknowledgedDomains.add(domain);
    }
    attachToButtons();
    setTimeout(() => { attachToButtons(); }, 2000);
    setTimeout(() => { attachToButtons(); }, 4000);
  });

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      attachToButtons();
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class'] });
}

if (document.body) { initTosGuardian(); }
else { document.addEventListener('DOMContentLoaded', initTosGuardian); }

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getText") {
    sendResponse({ text: document.body.innerText, html: document.documentElement.innerHTML });
  }
});
