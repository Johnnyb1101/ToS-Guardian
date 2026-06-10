# TOS Guardian — Build Log

Public changelog. Technical architecture details are maintained separately.

## v1.0.0 — Initial Public Release (April 2026)

### Core Features
- Button interception — intercepts agree/accept buttons before click fires
- Shadow DOM traversal — catches buttons inside modern web component frameworks
- Fetcher Agent — hidden tab rendering for JS-heavy legal pages
- Dual document fetch — retrieves both Terms of Service and Privacy Policy in parallel
- Link Follower Agent — follows opt-out and privacy links buried in documents
- Memory Agent — 15-day cache with change detection fingerprinting and integrity verification
- Site Database — 30+ static entries for instant lookup, self-learning for unknown sites
- Analyzer — 6-category structured privacy analysis via AI
- Evaluator Agent — quality scoring with confidence badge before results reach UI
- Orchestrator — full relay chain coordination with retry and graceful fallback

### Security
- API key storage moved to chrome.storage.local — never in code
- Prompt injection defense in system prompt
- Input sanitization before prompt construction
- URL validation blocking private IPs, localhost, and non-HTTPS URLs
- Cache integrity hash verification on every read
- Content Security Policy in manifest
- WeakSet button hook tracking — inaccessible to page scripts
- Evaluator schema validation — fails closed on unexpected format

### UI
- Civic theme — clean white card, blue shield, DM Sans font
- Overlay intercepts agree buttons inline on the page
- Manual popup via toolbar icon click
- Options page for API key entry and provider selection
- Identical rendering across overlay and popup via shared formatSummary()

### Browser Support
- ✅ Chrome (tested)
- ✅ Microsoft Edge (tested)
- 🔲 Firefox — service worker compatibility issue, deferred

### Known Gaps
- Enter key via input field bypasses button-level interception
- Fingerprint instability on dynamic pages — pgvector semantic similarity planned
- Self-learning site database is single-user until backend is built

## v1.2.0 — May 2026

### New Features
- Form-level submit interception — Enter key inside registration forms now triggers the extension
- Shadow DOM form traversal — forms inside web components are now hooked correctly
- Community caching via Supabase — analysis results shared across users instantly
- Cross-user site database — known site URLs shared across users via Supabase backend
- Semantic similarity via pgvector — ToS change detection uses vector embeddings instead of text hashing
- Automatic model escalation — low-confidence analyses retry with a stronger model before reaching the user
- Server-side document fetching — Next.js and CORS-restricted legal pages fetch via proxy backend
- AI disclaimer on all results — permanent accuracy disclaimer on every analysis surface
- Supabase write validation gate — incomplete or malformed analyses rejected before reaching community cache

## v1.2.1 — May 2026

### Bug Fixes
- Removed anchor tag hooking from Shadow DOM traversal — navigation links no longer incorrectly intercepted as consent buttons
- Fixed overlay reappearing after Proceed on sites with anchor-based buttons (Epic Games)

### Improvements
- Plain English prompt rewrite — analysis results now written for everyday users, not lawyers
- Fixed summary rendering — markdown headers (##) stripped before display so sections render correctly

## v1.2.2 — May 2026

### Performance
- MutationObserver debounce — DOM-heavy pages no longer trigger redundant site lookups on every change

### UI Polish
- Footer buttons now lock to identical width across all sites and screen sizes

### Site Database Updates
- eBay — corrected URLs to fix help page error responses
- Walmart — added to static site database
- EA — added to static site database

### Testing
- Cross-category validation across 25+ sites (finance, social, shopping, healthcare, gaming, travel, productivity)
- All tested sites returned Strong analyses with full relay completion
- Documented edge cases: sites with opt-out links external to privacy policy documents, sites with JS-heavy help center pages

## v1.2.3 — May 2026

### Security & Reliability
- Shadow DOM traversal is now mark-only and uses the delegated document-level click path
- Added Anthropic, OpenAI, and local Ollama host permissions for direct BYOK/model calls
- Cached community analyses are served only after current document text is fetched and checked through the semantic cache path
- Updated Anthropic escalation model ID to the current Opus 4.1 snapshot

### UX
- Proceed now replays the original button/form action after acknowledgment

### Cleanup
- Removed unused Weak confidence badge styling

## v1.3.0 — June 2026

### Detection
- Reworked agree-button detection to catch sign-up and log-in flows that previously slipped through silently — account-creation with an auth form, any auth action when a password field is present, Terms/Privacy links or auth text near the button, and magic-link "Continue" buttons on auth pages — while still ignoring ordinary e-commerce "Continue" buttons
- First automated test coverage for button detection (18 scenarios)

### Reliability & Quality
- Retrieval-failure guard — an analysis that reports the document wasn't actually retrieved (navigation chrome instead of policy text) is now forced to "Failed" with a clear warning, instead of scored as a confident result
- Fetcher now waits for real legal-document content instead of accepting a page's navigation shell, so JavaScript-rendered legal pages are captured
- Fixed a false-positive contradiction flag — a policy that says it does not sell your data while offering sharing/ad opt-outs is no longer flagged
- Removed a duplicate community-cache write on the escalation path

### Security
- Hardened the outbound-URL gate against SSRF — now blocks internal and cloud-metadata hostnames, single-label hosts, and bare IPv6 literals, on top of private/loopback IPs (including decimal, hex, and IPv6-mapped encodings)

### Performance
- Faster document fetching — hidden tabs resolve as soon as content renders instead of waiting a fixed timeout, and candidate URLs are tried in parallel

### UI
- Overlay action buttons relabeled to "Accept Risk and Continue" (red) and "Go Back Safely" (neutral) for clearer intent
- Retheme'd the injection-warning box and disclaimer to match the light card

### Maintenance
- Updated the Anthropic escalation model to Claude Opus 4.8
- Dropped the non-functional Firefox manifest config — honestly Chromium-only until real Firefox support is built and tested
- Removed dead code and leftover debug logging; hardened the popup against background-service and tab errors with clear messages

### Testing
- Test suite grew to 71 logic + 36 system + 18 detection checks, all passing
