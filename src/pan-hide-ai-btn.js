const DEFAULT_SETTINGS = { enabled: true };
const STYLE_ID = 'xt-pan-hide-ai-btn-style';
const HIDE_CSS = `
div.vp-chat-ai-btn.margin-left-24 {
  display: none !important;
  visibility: hidden !important;
}
`.trim();

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  syncStyle(settings.enabled !== false);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.enabled) {
      return;
    }
    syncStyle(changes.enabled.newValue !== false);
  });
}

function syncStyle(enabled) {
  const existing = document.getElementById(STYLE_ID);

  if (!enabled) {
    if (existing) {
      existing.remove();
    }
    return;
  }

  if (existing) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = HIDE_CSS;
  (document.head || document.documentElement).appendChild(style);
}
