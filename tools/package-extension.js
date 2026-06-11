// TOS Guardian — release packager
//
// Copies ONLY the files the extension needs at runtime into a clean ./dist
// folder. Dev/test files (devtest.*, test.html, tests/, tools/, build logs)
// are left behind, so they never ship to users.
//
// This is an ALLOWLIST: list exactly what goes in. Anything not named here is
// excluded automatically — including any new dev file added later — so the
// release can't accidentally pick up scratch files.
//
// Usage:  npm run build
// Result: ./dist contains the loadable/zippable extension.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// Every file the extension references at runtime (from manifest.json):
// background service worker + the scripts it importScripts(), the content
// scripts, the popup, the options page, and the icons.
const RUNTIME_FILES = [
  "manifest.json",
  // background service worker + its imported modules
  "background.js",
  "orchestrator.js",
  "evaluator.js",
  "critic.js",
  "siteDatabase.js",
  "tosUtils.js",
  // content scripts
  "shadowDom.js",
  "content.js",
  // popup (toolbar button)
  "popup.html",
  "popup.js",
  // options page
  "options.html",
  "options.js",
  // icons
  "icon-16.png",
  "icon-48.png",
  "icon-128.png",
];

function build() {
  // Start from a clean slate so a removed file doesn't linger in a stale dist.
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const missing = [];
  for (const name of RUNTIME_FILES) {
    const src = path.join(ROOT, name);
    if (!fs.existsSync(src)) {
      missing.push(name);
      continue;
    }
    fs.copyFileSync(src, path.join(DIST, name));
  }

  if (missing.length > 0) {
    console.error("[package] ERROR — runtime files not found:", missing.join(", "));
    process.exit(1);
  }

  console.log(`[package] Wrote ${RUNTIME_FILES.length} files to ./dist`);
  console.log("[package] Load ./dist as an unpacked extension, or zip it for the Chrome Web Store.");
}

build();
