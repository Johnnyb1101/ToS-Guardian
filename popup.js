const browser = globalThis.browser || chrome;

// Show a plain status message in the loading area and clear any summary.
function setStatus(text) {
  const loading = document.getElementById("loading");
  if (loading) {
    loading.style.display = "block";
    loading.innerText = text;
  }
}

function renderSummary(result) {
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "none";
  const summary = document.getElementById("summary");
  if (summary) {
    summary.innerHTML = formatSummary(
      result?.summary || "Could not analyze this page.",
      result?.optOutLinks || [],
      result?.unreadableDocs || []
    );
  }
}

browser.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (browser.runtime.lastError || !tabs || !tabs[0]) {
    setStatus("TOS Guardian could not access the current tab.");
    return;
  }
  const currentTab = tabs[0];

  browser.tabs.sendMessage(currentTab.id, { action: "getText" }, (response) => {
    // No content script on this page (e.g. chrome:// pages, the Web Store, PDFs).
    if (browser.runtime.lastError) {
      setStatus("TOS Guardian can't run on this page. Open it on a normal website and try again.");
      return;
    }
    if (!response || !response.text) {
      setStatus("No ToS text found on this page.");
      return;
    }

    browser.runtime.sendMessage(
      { action: "analyzeTos", text: response.text, pageUrl: currentTab.url },
      (result) => {
        // The service worker may be asleep or have errored — surface it instead
        // of silently showing "Could not analyze".
        if (browser.runtime.lastError) {
          setStatus("TOS Guardian could not reach the background service. Reload the extension and try again.");
          return;
        }
        renderSummary(result);
      }
    );
  });
});
