// TOS Guardian — Site Database
// Standalone file. Loaded into service worker scope via importScripts('siteDatabase.js') in background.js.
//
// PURPOSE:
// Maps known domains to their confirmed ToS and Privacy Policy URLs.
// When the Orchestrator finds a match here, the Fetcher skips all candidate
// URL guessing and hidden tab scanning — it goes straight to the known URLs.
//
// TWO LAYERS:
// 1. STATIC_SITES  — hardcoded, never expire. Offline fallback if proxy unreachable.
// 2. Supabase      — cross-user learned sites via proxy GET/POST /site/:domain

// ---------------------------------------------------------------------------
// Static database — hardcoded, never expire, offline fallback
// ---------------------------------------------------------------------------
const STATIC_SITES = {
  "reddit.com":       { tos: "https://www.redditinc.com/policies/user-agreement", privacy: "https://www.redditinc.com/policies/privacy-policy" },
  "twitter.com":      { tos: "https://twitter.com/en/tos", privacy: "https://twitter.com/en/privacy" },
  "x.com":            { tos: "https://twitter.com/en/tos", privacy: "https://twitter.com/en/privacy" },
  "facebook.com":     { tos: "https://www.facebook.com/terms.php", privacy: "https://www.facebook.com/privacy/policy/" },
  "instagram.com":    { tos: "https://help.instagram.com/581066165581870", privacy: "https://privacycenter.instagram.com/policy" },
  "linkedin.com":     { tos: "https://www.linkedin.com/legal/user-agreement", privacy: "https://www.linkedin.com/legal/privacy-policy" },
  "discord.com":      { tos: "https://discord.com/terms", privacy: "https://discord.com/privacy" },
  "tiktok.com":       { tos: "https://www.tiktok.com/legal/page/us/terms-of-service/en", privacy: "https://www.tiktok.com/legal/page/us/privacy-policy/en" },
  "spotify.com":      { tos: "https://www.spotify.com/us/legal/end-user-agreement/", privacy: "https://www.spotify.com/us/legal/privacy-policy/" },
  "netflix.com":      { tos: "https://help.netflix.com/legal/termsofuse", privacy: "https://help.netflix.com/legal/privacy" },
  "youtube.com":      { tos: "https://www.youtube.com/t/terms", privacy: "https://policies.google.com/privacy" },
  "twitch.tv":        { tos: "https://www.twitch.tv/p/en/legal/terms-of-service/", privacy: "https://www.twitch.tv/p/en/legal/privacy-notice/" },
  "amazon.com":       { tos: "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088", privacy: "https://www.amazon.com/gp/help/customer/display.html?nodeId=468496" },
  "ebay.com":         { tos: "https://www.ebay.com/help/policies/member-behaviour-policies/user-agreement?id=4259", privacy: "https://www.ebay.com/help/policies/member-behaviour-policies/user-privacy-notice-privacy-policy?id=4260" },
  "etsy.com":         { tos: "https://www.etsy.com/legal/terms-of-use/", privacy: "https://www.etsy.com/legal/privacy/" },
  "paypal.com":       { tos: "https://www.paypal.com/us/legalhub/useragreement-full", privacy: "https://www.paypal.com/us/legalhub/privacy-full" },
  "airbnb.com":       { tos: "https://www.airbnb.com/help/article/2908", privacy: "https://www.airbnb.com/help/article/2855" },
  "uber.com":         { tos: "https://www.uber.com/legal/en/document/?name=general-terms-of-use&country=united-states&lang=en", privacy: "https://www.uber.com/legal/en/document/?name=privacy-notice&country=united-states&lang=en" },
  "google.com":       { tos: "https://policies.google.com/terms", privacy: "https://policies.google.com/privacy" },
  "apple.com":        { tos: "https://www.apple.com/legal/internet-services/terms/site.html", privacy: "https://www.apple.com/legal/privacy/" },
  "microsoft.com":    { tos: "https://www.microsoft.com/en-us/servicesagreement/", privacy: "https://privacy.microsoft.com/en-us/privacystatement" },
  "github.com":       { tos: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service", privacy: "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" },
  "zoom.us":          { tos: "https://explore.zoom.us/en/terms/", privacy: "https://explore.zoom.us/en/privacy/" },
  "slack.com":        { tos: "https://slack.com/terms-of-service", privacy: "https://slack.com/privacy-policy" },
  "steampowered.com": { tos: "https://store.steampowered.com/subscriber_agreement/", privacy: "https://store.steampowered.com/privacy_agreement/" },
  "epicgames.com":    { tos: "https://www.epicgames.com/tos", privacy: "https://www.epicgames.com/privacypolicy" },
  "walmart.com":      { tos: "https://www.walmart.com/help/article/walmart-com-terms-of-use/3b75080af40340d6bbd596f116fae5a0", privacy: "https://www.walmart.com/help/article/walmart-privacy-notice/308b8b3a2c5747dc8a06f40af4ff4ead" },
  "capitalone.com":   { tos: "https://www.capitalone.com/digital/terms-conditions/", privacy: "https://www.capitalone.com/privacy/", supplemental: ["https://www.capitalone.com/privacy/notice/en-us", "https://www.capitalone.com/privacy/online-privacy-policy/", "https://www.capitalone.com/privacy/ccpa-disclosure/"] },
  "ea.com":           { tos: "https://tos.ea.com/legalapp/WEBTERMS/US/en/PC/", privacy: "https://www.ea.com/legal/privacy-policy" }
};

// ---------------------------------------------------------------------------
// lookupSite(pageUrl)
// Priority: (1) STATIC_SITES, (2) Supabase via proxy, (3) null → Fetcher guesses
// ---------------------------------------------------------------------------
async function lookupSite(pageUrl) {
  try {
    // Key by registrable domain (eTLD+1) so a learned site is found from ANY of its
    // subdomains — e.g. signup.acorns.com / oak.acorns.com resolve to acorns.com's
    // learned ToS+privacy URLs, so the fetcher gets the REAL docs instead of the auth
    // subdomain's empty SPA shells (which otherwise defeat the cache). (FIXPLAN #1b)
    const hostname = registrableDomain(new URL(pageUrl).hostname);

    if (STATIC_SITES[hostname]) {
      console.log(`[SiteDB] ✅ Static match: ${hostname}`);
      return STATIC_SITES[hostname];
    }

    const parts = hostname.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join(".");
      if (STATIC_SITES[candidate]) {
        console.log(`[SiteDB] ✅ Static match (subdomain): ${hostname} → ${candidate}`);
        return STATIC_SITES[candidate];
      }
    }

    try {
      const response = await proxyFetch(`${PROXY_URL}/site/${encodeURIComponent(hostname)}`);
      if (response.status === 429) {
        console.warn(`[SiteDB] Rate limited for ${hostname}`);
        return null;
      }
      if (response.ok) {
        const data = await response.json();
        if (data && data.tos && data.privacy) {
          if (!data.is_static) {
            const ageInDays = (Date.now() - new Date(data.updated_at).getTime()) / (1000 * 60 * 60 * 24);
            if (ageInDays > 15) {
              console.log(`[SiteDB] ⏰ Supabase entry expired for ${hostname}`);
              return null;
            }
          }
          console.log(`[SiteDB] ✅ Supabase match: ${hostname}`);
          return { tos: data.tos, privacy: data.privacy, supplemental: data.supplemental || [] };
        }
      }
    } catch (e) {
      console.warn(`[SiteDB] Supabase lookup failed for ${hostname}:`, e.message);
    }

    console.log(`[SiteDB] ❓ Unknown site: ${hostname} — Fetcher will use candidate URLs`);
    return null;

  } catch (e) {
    console.warn("[SiteDB] lookupSite error:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// learnSite(pageUrl, tosUrl, privacyUrl)
// Saves to Supabase via proxy POST /site. Never overwrites static entries.
// ---------------------------------------------------------------------------
async function learnSite(pageUrl, tosUrl, privacyUrl) {
  try {
    // Store under the registrable domain so every subdomain shares one entry. (FIXPLAN #1b)
    const hostname = registrableDomain(new URL(pageUrl).hostname);

    if (STATIC_SITES[hostname]) return;

    proxyFetch(`${PROXY_URL}/site`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: hostname, tos_url: tosUrl, privacy_url: privacyUrl })
    }).then(r => r.json())
      .then(d => { if (d.success) console.log(`[SiteDB] ☁️ Learned and saved: ${hostname}`); })
      .catch(e => console.warn(`[SiteDB] Supabase write failed for ${hostname}:`, e.message));

  } catch (e) {
    console.warn("[SiteDB] learnSite error:", e);
  }
}
