const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};
const PAGE_HOOK_SOURCE = 'xt-abc-subtitle-hook';
const PAGE_HOOK_REQUEST_TYPE = 'xt-abc-translate-vtt-request';
const PAGE_HOOK_RESPONSE_TYPE = 'xt-abc-translate-vtt-response';
const ABC_SUBTITLE_TARGET_LANGUAGE = 'zh-CN';

let settings = { ...DEFAULT_SETTINGS };

init().catch((error) => {
  console.warn('[auto-translate] Failed to initialize ABC subtitle relay:', error);
});

async function init() {
  settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  injectPageHook();
  window.addEventListener('message', handlePageMessage);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') {
      return;
    }

    for (const [key, value] of Object.entries(changes)) {
      settings[key] = value.newValue;
    }
  });
}

function injectPageHook() {
  if (window !== window.top) {
    return;
  }

  if (document.documentElement?.dataset.xtAbcPageHookInjected === '1') {
    return;
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/abc-page-hook.js');
  script.async = false;
  script.dataset.xtAbcPageHook = '1';
  script.addEventListener('load', () => {
    script.remove();
  });
  script.addEventListener('error', () => {
    script.remove();
  });

  document.documentElement.dataset.xtAbcPageHookInjected = '1';
  (document.head || document.documentElement).appendChild(script);
}

function handlePageMessage(event) {
  if (event.source !== window || !event.data) {
    return;
  }

  const { source, type, requestId, url, vttText } = event.data;
  if (source !== PAGE_HOOK_SOURCE || type !== PAGE_HOOK_REQUEST_TYPE || !requestId) {
    return;
  }

  relayTranslatedVtt({ requestId, url, vttText }).catch((error) => {
    postRelayResponse({
      requestId,
      ok: false,
      error: error.message || 'Subtitle translation failed',
      vttText: String(vttText || '')
    });
  });
}

async function relayTranslatedVtt({ requestId, url, vttText }) {
  const originalVttText = String(vttText || '');
  if (!settings.enabled || !originalVttText.trim()) {
    postRelayResponse({
      requestId,
      ok: true,
      vttText: originalVttText
    });
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'translate-subtitle-vtt-text',
    url: String(url || ''),
    vttText: originalVttText,
    sourceLanguage: 'en',
    targetLanguage: ABC_SUBTITLE_TARGET_LANGUAGE
  });

  if (!response || !response.ok || typeof response.vtt !== 'string') {
    throw new Error((response && response.error) || 'Subtitle translation failed');
  }

  postRelayResponse({
    requestId,
    ok: true,
    vttText: response.vtt
  });
}

function postRelayResponse(payload) {
  window.postMessage(
    {
      source: PAGE_HOOK_SOURCE,
      type: PAGE_HOOK_RESPONSE_TYPE,
      ...payload
    },
    '*'
  );
}
