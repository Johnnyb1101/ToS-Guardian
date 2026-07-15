const hookedButtons = new WeakSet();
const browser = globalThis.browser || chrome;
const isFrame = window.top !== window;

// MV3 service-worker resilience (FIXPLAN #5b): a sleeping or mid-shutdown SW can
// drop the first message after idle, which surfaces as runtime.lastError ("Could
// not establish connection / receiving end does not exist"). Re-sending wakes it.
// We retry ONLY on a delivery error — never on a slow-but-delivered response — so
// an in-flight analysis is never duplicated; the caller's own deadline bounds the
// total wait. The final outcome (response, error-or-null) is handed to `callback`.
function sendMessageWithRetry(message, callback, { attempts = 3, delay = 350 } = {}) {
  const attempt = (remaining) => {
    // The extension context can be gone — the extension was reloaded/updated while
    // this content script kept running, or a hidden fetch tab is being torn down.
    // Then sendMessage throws "Extension context invalidated" SYNCHRONOUSLY (no
    // runtime.lastError fires), and retrying can't recover it. Detect it up front
    // and via try/catch, and bail quietly with an error instead of throwing.
    if (!browser.runtime?.id) {
      callback(undefined, new Error("Extension context invalidated"));
      return;
    }
    try {
      browser.runtime.sendMessage(message, (response) => {
        const err = browser.runtime.lastError || null;
        if (err && remaining > 1) {
          console.warn(`[TOS Guardian] Message "${message.action}" dropped (${err.message}); waking service worker and retrying (${remaining - 1} left)`);
          setTimeout(() => attempt(remaining - 1), delay);
          return;
        }
        callback(response, err);
      });
    } catch (e) {
      // Invalidated context (or similar). Not retryable — surface as an error.
      callback(undefined, e);
    }
  };
  attempt(attempts);
}

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

// A search-results page is never an agreement moment. Its result snippets are full
// of OTHER sites' "Log in"/"Sign up for X" text, which must not trigger an analysis
// of the search engine itself. Scoped to real search-engine hosts with a query or
// /search path, so it can't suppress normal sites. (FIXPLAN #3 — Google SERP bug.)
function pageIsSearchResults() {
  const host = (window.location?.hostname || "").toLowerCase();
  const path = (window.location?.pathname || "").toLowerCase();
  const search = (window.location?.search || "").toLowerCase();
  const isSearchEngine = /(^|\.)(google|bing|duckduckgo|ecosia|yahoo|baidu|yandex|brave|startpage|qwant)\./.test(host);
  if (!isSearchEngine) return false;
  return /[?&](q|query|p)=/.test(search) || /\/search(\/|$)/.test(path);
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

  // Never fire on a search-results page (its snippets are full of other sites'
  // login/signup text). (FIXPLAN #3)
  if (pageIsSearchResults()) return false;

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

  // On domains we already know host legal docs, be more permissive — but still
  // require a real auth form on the page. Bare "Login"/"Sign up" TEXT alone must
  // not fire (it appears in search-result snippets, nav, footers, etc.). (FIXPLAN #3)
  if (domainIsKnown && authForm) return true;

  // Page-wide agreement context (SSO buttons, etc.).
  return pageHasAgreementContext();
}

// --- ENTER-KEY TRIGGER for formless logins ---
// Native <form> Enter-to-submit is caught by the submit listener; but React/JS
// logins built from <div>s + a <button onClick> dispatch NO submit event, so
// pressing Enter there would bypass us. shouldFireOnEnterField classifies the
// FOCUSED field the same tiered way isAgreeButton classifies a clicked button:
//  - a password field is unambiguous auth → fire on any page
//  - an email/username field fires ONLY in a real auth context (auth URL, auth
//    text nearby, or page-wide agreement context) — so it never fires on a
//    newsletter box, search field, profile edit, or contact form on an ordinary
//    page, where email inputs are common.
// (The email branch fires earliest — first step — and also covers passwordless /
// magic-link flows; the password branch is the catch-all on generic URLs.)
function isPasswordField(el) {
  if (!el) return false;
  const type = (el.type || el.getAttribute?.("type") || "").toLowerCase();
  return type === "password";
}
function isEmailOrUsernameField(el) {
  if (!el) return false;
  const type = (el.type || el.getAttribute?.("type") || "").toLowerCase();
  if (type === "email") return true;
  const autocomplete = (el.getAttribute?.("autocomplete") || el.autocomplete || "").toLowerCase();
  if (autocomplete === "username" || autocomplete === "email") return true;
  const name = (el.getAttribute?.("name") || el.name || "").toLowerCase();
  return /email|user/.test(name);
}
function shouldFireOnEnterField(el) {
  if (!el) return false;
  if (pageIsSearchResults()) return false;
  if (isPasswordField(el)) return true;
  if (isEmailOrUsernameField(el)) {
    return pageUrlLooksLikeAuth() || hasAuthProximity(el) || pageHasAgreementContext();
  }
  return false;
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
      #tg-card-subtitle { font-size:12px; color:#555; margin-top:1px; }
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
      .tg-unreadable-docs { margin:10px 20px; padding:10px 12px; background:#fff8ee; border:1px solid #f5dfa0; border-radius:8px; }
      .tg-unreadable-title { font-size:11px; font-weight:600; color:#7a5000; margin-bottom:6px; line-height:1.4; }
      .tg-unreadable-link { display:block; font-size:11px; color:#1a1aff; text-decoration:none; word-break:break-all; margin-bottom:3px; }
      .tg-unreadable-link:hover { text-decoration:underline; }
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
      .tg-more-toggle { margin:2px 0 2px; padding:2px 0; background:none; border:none; color:#1a1aff; font-size:11px; font-weight:600; cursor:pointer; display:block; text-align:left; }
      .tg-more-toggle:hover { text-decoration:underline; }
      .tg-more { display:none; }
      .tg-more.tg-open { display:block; }
      .tg-confidence-note { margin:10px 20px 0; font-size:11px; color:#aaa; text-align:center; }
      #tg-card-footer { display:none; gap:10px; padding:14px 20px; border-top:1px solid #f0f0f0; align-items:center; flex-wrap:wrap; }
      #tg-card-footer.tg-ready { display:flex; }
      #tg-card button { appearance:none; -webkit-appearance:none; text-transform:none; letter-spacing:normal; line-height:normal; margin:0; }
      #tg-proceed { flex:1 1 0; min-width:0; height:40px; padding:0 10px; background:#1a1aff; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; }
      #tg-proceed:hover { background:#1414cc; }
      #tg-leave { flex:1 1 0; min-width:0; height:40px; padding:0 10px; background:#9ca3af; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; }
      #tg-leave:hover { background:#6b7280; }
      .tg-retry-btn { flex:1 1 100%; height:40px; padding:0 10px; background:#1a1aff; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; }
      .tg-retry-btn:hover { background:#1414cc; }
    </style>

    <div id="tg-card">
      <div id="tg-card-topbar"></div>
      <div id="tg-card-header">
        <div id="tg-card-shield"><div id="tg-card-shield-icon"></div></div>
        <div>
          <div id="tg-card-title">TOS Guardian</div>
          <div id="tg-card-subtitle">Know what you're agreeing to — Terms of Service &amp; privacy, in plain English</div>
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
    acknowledgedDomains.add(currentDomainKey());
    clearPendingOverlay();
    overlay.remove();
    sendMessageWithRetry({ action: "acknowledge" }, () => {});
    setTimeout(() => {
      if (!clickedButton || !clickedButton.isConnected) return;
      if (clickedButton instanceof HTMLFormElement) {
        if (typeof clickedButton.requestSubmit === "function") clickedButton.requestSubmit();
        else clickedButton.submit();
        return;
      }
      // Enter-key trigger on a formless field: the domain is acknowledged now, so a
      // re-dispatched Enter passes through our keydown listener to the site's own
      // handler. (A plain .click() on an input would do nothing useful.)
      if (clickedButton.tagName === "INPUT" || clickedButton.tagName === "TEXTAREA") {
        clickedButton.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
        return;
      }
      if (typeof clickedButton.click === "function") clickedButton.click();
    }, 0);
  });

  overlayRoot.getElementById("tg-leave").addEventListener("click", () => {
    interceptActive = false;
    clearPendingOverlay();
    overlay.remove();
  });

  // Page text is captured once (the overlay lives in a closed shadow DOM, so it
  // doesn't leak into document.body.innerText) and reused if the user retries.
  const fullText = document.body.innerText;

  // Relay lifecycle (FIXPLAN #5a): a relay that never responds — a sleeping MV3
  // service worker, a dropped message, or a candidate fetch that hangs — used to
  // leave the overlay stuck on "still analyzing" forever (the old 45s timer only
  // re-worded the message, it never resolved). Now there are two timers: a SOFT
  // notice at 45s ("still working, some sites take longer") and a HARD deadline at
  // 120s that resolves the overlay to an honest "couldn't finish" state with a
  // Try-again button, so the user is never stranded.
  const SOFT_NOTICE_MS = 45000;
  const HARD_DEADLINE_MS = 120000;

  let analysisResponded = false;
  let softNoticeTimer = null;
  let hardDeadlineTimer = null;

  const clearAnalysisTimers = () => {
    if (softNoticeTimer) clearTimeout(softNoticeTimer);
    if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
    softNoticeTimer = null;
    hardDeadlineTimer = null;
  };

  // Resolve the overlay into an honest error state with a retry affordance.
  const showAnalysisError = (message) => {
    analysisResponded = true;
    clearAnalysisTimers();
    const summaryEl = overlayRoot.getElementById("tg-summary");
    if (!summaryEl) return;
    summaryEl.innerHTML = formatSummary(message, []);
    // Put "Try again" in the FOOTER, not the scrollable summary — appended to the
    // summary it floated at the bottom-left and could sit half-off the card. The
    // footer's flex-wrap gives it the full first row above Accept / Go Back.
    const footer = overlayRoot.getElementById("tg-card-footer");
    if (footer && !footer.querySelector(".tg-retry-btn")) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "tg-retry-btn";
      retryBtn.textContent = "Try again";
      retryBtn.addEventListener("click", () => requestAnalysis());
      footer.insertBefore(retryBtn, footer.firstChild);
    }
    // Reveal the footer so "Try again" / "Go Back Safely" are available on failure.
    revealActions();
  };

  function requestAnalysis() {
    analysisResponded = false;
    clearAnalysisTimers();
    // Clear a stale "Try again" from a previous failed attempt so it doesn't linger
    // in the footer once this attempt succeeds.
    overlayRoot.getElementById("tg-card-footer")?.querySelector(".tg-retry-btn")?.remove();
    const loadingEl = overlayRoot.getElementById("tg-summary");
    if (loadingEl) {
      loadingEl.innerHTML =
        '<div id="tg-summary-loading"><div id="tg-spinner"></div>Analyzing this agreement - reading the fine print...</div>';
    }

    softNoticeTimer = setTimeout(() => {
      if (analysisResponded) return;
      const summaryEl = overlayRoot.getElementById("tg-summary");
      if (summaryEl) {
        summaryEl.innerHTML = formatSummary(
          "TOS Guardian is still analyzing this agreement. Some sites take longer because legal pages and opt-out links have to be fetched and checked.",
          []
        );
      }
    }, SOFT_NOTICE_MS);

    hardDeadlineTimer = setTimeout(() => {
      if (analysisResponded) return;
      showAnalysisError(
        "TOS Guardian couldn't finish analyzing this agreement in time. This sometimes happens when the background service worker goes to sleep or a legal page is slow to load. Try again, or go back and read the terms yourself before agreeing."
      );
    }, HARD_DEADLINE_MS);

    // attempts:2 — retry only the cold-start drop (the orchestrator never ran), not
    // a slow-but-running analysis; the 120s hard deadline bounds total time.
    sendMessageWithRetry(
      {
        action: "analyzeTos",
        text: boundMessageField(fullText, MAX_BACKGROUND_TEXT_CHARS),
        pageHtml: boundMessageField(document.documentElement.innerHTML, MAX_BACKGROUND_HTML_CHARS)
      },
      (result, err) => {
        if (analysisResponded) return;
        analysisResponded = true;
        clearAnalysisTimers();
        const summaryEl = overlayRoot.getElementById("tg-summary");
        if (!summaryEl) return;
        if (err) {
          showAnalysisError(
            "TOS Guardian could not reach the background service worker. Reload the extension and try again."
          );
          return;
        }
        summaryEl.innerHTML = formatSummary(
          result?.summary || "Could not analyze this page.",
          result?.optOutLinks || [],
          result?.unreadableDocs || []
        );
        // Wire each section's "Show more" expander (per-section progressive
        // disclosure): only the main point shows until the reader expands a section.
        overlayRoot.querySelectorAll(".tg-more-toggle").forEach((btn) => {
          btn.addEventListener("click", () => {
            const panel = overlayRoot.getElementById(btn.getAttribute("data-target"));
            if (!panel) return;
            const open = panel.classList.toggle("tg-open");
            btn.textContent = open ? "Show less ▴" : "Show more ▾";
          });
        });
        revealActions();
      },
      { attempts: 2 }
    );
  }

  requestAnalysis();
}

// --- EVENT DELEGATION ---
// Single capture-phase listener on document handles all agree-button clicks.
// Resilient to React re-rendering DOM nodes.
let interceptActive = false;
const acknowledgedDomains = new Set();

// Key acknowledgments + cache by REGISTRABLE domain (eTLD+1) so a "Sign In" on
// www.x.com and the "Log In" on its auth subdomain login.x.com are treated as
// one site — no double-fire across the landing→auth hop, shared cache. (FIXPLAN #1)
function currentDomainKey() { return registrableDomain(window.location.hostname); }

// --- "Show on the next page" (FIXPLAN #5) ---
// An agree-click on a button that navigates (e.g. "Get Started" → a signup subdomain)
// tears this page down before the overlay can be seen, while the analysis keeps
// running in the background and caches under the registrable domain. We persist a
// short-lived marker on intercept; the destination page (same registrable domain)
// re-shows the overlay on load so the user still sees the analysis. Cleared on
// proceed/leave so it doesn't re-fire on later same-domain navigation.
const PENDING_OVERLAY_TTL_MS = 120000;
function markPendingOverlay() {
  try { browser.storage.local.set({ tosPendingOverlay: { domain: currentDomainKey(), ts: Date.now() } }); } catch (e) {}
}
function clearPendingOverlay() {
  try { browser.storage.local.remove("tosPendingOverlay"); } catch (e) {}
}
function maybeShowPendingOverlay() {
  if (acknowledgedDomains.has(currentDomainKey())) return;
  if (document.getElementById("tos-guardian-overlay")) return;
  // Only re-show in a tab the user is actually looking at. The document fetcher
  // loads legal docs in HIDDEN background tabs (background.js tabs.create
  // active:false); content.js runs in those too, and because the pending marker
  // is keyed by REGISTRABLE domain (#1) a hidden tab on www.acorns.com matches a
  // marker set on signup.acorns.com → it would spawn a PHANTOM second relay from
  // inside the fetcher's own throwaway tab (observed on Acorns + Navy Federal).
  // A hidden fetch tab is never visible, so gate on visibility; a legitimately
  // background-opened destination tab re-shows once the user focuses it. (FIXPLAN #5/#13)
  if (document.visibilityState !== "visible") {
    document.addEventListener("visibilitychange", function onVis() {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVis);
      maybeShowPendingOverlay();
    });
    return;
  }
  try {
    browser.storage.local.get("tosPendingOverlay", (data) => {
      if (browser.runtime.lastError) return; // context gone — nothing to re-show
      const pending = data && data.tosPendingOverlay;
      if (!pending || pending.domain !== currentDomainKey()) return;
      if (Date.now() - pending.ts > PENDING_OVERLAY_TTL_MS) { clearPendingOverlay(); return; }
      if (acknowledgedDomains.has(currentDomainKey())) { clearPendingOverlay(); return; }
      if (document.getElementById("tos-guardian-overlay")) return;
      console.log("[TOS Guardian] Re-showing analysis on the destination page after navigation");
      interceptActive = true;
      setTimeout(() => { interceptActive = false; }, 5000);
      const synthetic = { preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {}, target: document.body, currentTarget: document.body };
      showGuardianOverlay(synthetic, null);
      clearPendingOverlay();
    });
  } catch (e) {}
}

document.addEventListener("click", (event) => {
  if (acknowledgedDomains.has(currentDomainKey())) return;
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

  const domain = currentDomainKey();
  // Persist BEFORE any navigation can tear this page down, so the destination page
  // can re-show the analysis. (FIXPLAN #5)
  markPendingOverlay();

  let responded = false;
  const fallbackTimer = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.warn('[TOS Guardian] Background service worker did not respond — showing overlay');
      showGuardianOverlay(event, hookedEl);
    }
  }, 8000);

  sendMessageWithRetry(
    { action: "checkCache" },
    (response, err) => {
      if (responded) return;
      responded = true;
      clearTimeout(fallbackTimer);

      if (err) {
        console.warn('[TOS Guardian] Message channel error:', err.message);
        showGuardianOverlay(event, hookedEl);
        return;
      }
      if (response && response.acknowledged) {
        interceptActive = false;
        acknowledgedDomains.add(response.domain || domain);
        return;
      }
      showGuardianOverlay(event, hookedEl);
    }
  );
}, true);

document.addEventListener("submit", (event) => {
  if (acknowledgedDomains.has(currentDomainKey())) return;
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
  markPendingOverlay(); // FIXPLAN #5 — survive a navigating submit
  showGuardianOverlay(syntheticEvent, agreeBtn || form);
}, true);

// Enter key on a FORMLESS login field (React/JS logins with no real <form>, where
// no submit event ever fires). Native-form fields are skipped — the submit listener
// above owns those (it runs on the native submit event even when the site's JS
// later cancels it). Only the genuinely formless case needs this path.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (acknowledgedDomains.has(currentDomainKey())) return;
  if (interceptActive) return;

  const field = event.target;
  if (!field || field.form) return;             // native form → submit listener handles it
  if (!shouldFireOnEnterField(field)) return;

  // No <form> means Enter has no default submit to cancel — stop propagation so the
  // site's own keydown handler can't log the user in before they see the overlay.
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
  interceptActive = true;
  setTimeout(() => { interceptActive = false; }, 5000);

  console.log('[TOS Guardian] Intercepted Enter on auth field:', field.tagName);
  markPendingOverlay(); // FIXPLAN #5 — survive a navigating submit
  showGuardianOverlay(event, field);
}, true);

// --- BUTTON MARKING ---
// Marking (data-tg-hooked) is a FAST-PATH HINT only — the click handler always
// falls back to live classification (findAgreeControl over the composedPath),
// so a button the scanner missed still gets intercepted on click. That's what
// makes scoped scanning safe: a missed mark costs a few ms at click time, never
// a missed interception. No per-element listeners are ever attached.

function markIfAgreeButton(el) {
  if (!el || el.dataset?.tgHooked === "true") return;
  if (isAgreeButton(el)) {
    el.dataset.tgHooked = "true";
    console.log('[TOS Guardian] Marked button:', el.innerText?.trim().substring(0, 30));
  }
}

// Scan ONE subtree (the element itself, its button-like descendants, and any
// shadow roots inside it). Scoped scans keep mutation handling proportional to
// what actually changed instead of re-walking the whole page (perf: FIXPLAN
// audit #4 — full-document rescans on every mutation made heavy SPAs sluggish).
function scanSubtree(root) {
  if (!root || root.isConnected === false) return; // removed again before the debounce fired
  if (typeof root.matches === "function" && root.matches("button, a, [role='button']")) {
    markIfAgreeButton(root);
  }
  if (typeof root.querySelectorAll === "function") {
    root.querySelectorAll("button, a, [role='button']").forEach(markIfAgreeButton);
    hookShadowButtons(root);
  }
}

// Full-page scan — used at init and as the fallback when a mutation burst is so
// large that per-subtree scanning would just be a slower full scan.
function attachToButtons() {
  scanSubtree(document.body);
}

function attachToForms() {
  // Forms are handled by the document-level submit listener — no per-form hooking needed
}

let domainIsKnown = false;

function initTosGuardian() {
  if (!shouldRunInFrame()) return;

  const domain = currentDomainKey();

  let initResponded = false;
  const initFallback = setTimeout(() => {
    if (!initResponded) {
      initResponded = true;
      console.warn('[TOS Guardian] Init: service worker did not respond — hooking buttons without site check');
      attachToButtons();
    }
  }, 2000);

  sendMessageWithRetry({ action: "checkCache" }, (response, err) => {
    if (initResponded) return;
    initResponded = true;
    clearTimeout(initFallback);

    if (err) {
      console.warn('[TOS Guardian] Init: message channel error:', err.message);
    } else {
      if (response && response.knownSite) domainIsKnown = true;
      if (response && response.acknowledged) acknowledgedDomains.add(response.domain || domain);
    }
    attachToButtons();
    // If an agree-click on this registrable domain got cut off by navigation, re-show
    // the analysis here (it's cached under the registrable domain). (FIXPLAN #5)
    maybeShowPendingOverlay();
    setTimeout(() => { attachToButtons(); }, 2000);
    setTimeout(() => { attachToButtons(); }, 4000);
  });

  // Scoped mutation handling: instead of rescanning the whole document on any
  // change, accumulate the nodes that actually changed across the debounce
  // window and scan only those subtrees. Two escape hatches keep it bounded:
  //  - a burst larger than MUTATION_BURST_LIMIT roots falls back to ONE full
  //    scan (at that size most of the page changed anyway, and the containment
  //    filter below would cost more than it saves);
  //  - a root nested inside another pending root is skipped (its parent's scan
  //    already covers it), so React re-renders don't trigger duplicate walks.
  const MUTATION_BURST_LIMIT = 50;
  let debounceTimer = null;
  const pendingScanRoots = new Set();
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) pendingScanRoots.add(n); // element nodes only
        }
      } else if (m.type === "attributes" && m.target && m.target.nodeType === 1) {
        pendingScanRoots.add(m.target);
      }
    }
    if (pendingScanRoots.size === 0) return; // e.g. only text/removal mutations
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const roots = [...pendingScanRoots];
      pendingScanRoots.clear();
      if (roots.length > MUTATION_BURST_LIMIT) {
        attachToButtons();
        return;
      }
      for (const root of roots) {
        const covered = roots.some(other =>
          other !== root && typeof other.contains === "function" && other.contains(root));
        if (!covered) scanSubtree(root);
      }
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class'] });
}

if (document.body) { initTosGuardian(); }
else { document.addEventListener('DOMContentLoaded', initTosGuardian); }

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getText") {
    sendResponse({
      text: boundMessageField(document.body.innerText, MAX_BACKGROUND_TEXT_CHARS),
      html: boundMessageField(document.documentElement.innerHTML, MAX_BACKGROUND_HTML_CHARS)
    });
  }
});
