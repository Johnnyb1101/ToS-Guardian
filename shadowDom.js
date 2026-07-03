// shadowDom.js — Shadow DOM traversal utility
// Recursively walks shadow roots to find and hook agree buttons
// that are invisible to standard querySelectorAll

function walkShadowDOM(root, callback) {
  // The root itself may HOST a shadow root: scoped mutation scans (content.js)
  // pass the added/changed element, not document.body, so a custom element
  // that just attached its shadow root would otherwise never be entered.
  if (root.shadowRoot) {
    walkShadowDOM(root.shadowRoot, callback);
  }

  // Get all elements inside this root (normal DOM or shadow root)
  const elements = root.querySelectorAll('*');

  elements.forEach(el => {
    // Run the callback on every element (e.g. check if it's an agree button)
    callback(el);

    // If this element has a shadow root, step inside and keep searching
    if (el.shadowRoot) {
      walkShadowDOM(el.shadowRoot, callback);
    }
  });
}

function hookShadowButtons(root) {
  walkShadowDOM(root, (el) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const isButtonLike = tag === 'button' ||
      (tag === 'input' && (el.type === 'submit' || el.type === 'button')) ||
      el.getAttribute('role') === 'button';

    if (!isButtonLike) return;
    if (hookedButtons.has(el)) return;

    if (typeof isAgreeButton === 'function' && isAgreeButton(el)) {
      hookedButtons.add(el);
      el.dataset.tgHooked = 'true'; // DOM hint only — not authoritative
      console.log('[ShadowDOM] Marked agree button inside shadow root:', el);
    }
  });
}
