const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};
const CACHE_VERSION = 'v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_MIN_INTERVAL_MS = 800;
const MAX_RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1200;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const SUBTITLE_BATCH_MAX_CHARS = 1400;
const ABC_SUBTITLE_INDEX_CACHE = new Map();
const ABC_SUBTITLE_CUE_CACHE = new Map();
const ABC_TRANSLATED_VTT_CACHE = new Map();
const GROK_WEB_URL = 'https://grok.com/';
const GROK_INJECTION_RETRY = 8;
const GROK_INJECTION_RETRY_INTERVAL_MS = 700;
const GROK_IMAGE_UPLOAD_WAIT_MS = 3200;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_RESIZE_STEPS = [
  { maxDimension: 2048, quality: 0.85 },
  { maxDimension: 1600, quality: 0.74 },
  { maxDimension: 1280, quality: 0.64 }
];
const CONTEXT_MENU_SEND_TEXT_TO_GROK = 'send-selection-to-grok';
const CONTEXT_MENU_SEND_IMAGE_TO_GROK = 'send-image-to-grok';
const TRANSLATION_PROVIDERS = [
  { id: 'mymemory' },
  { id: 'googlegtx' },
  { id: 'libretranslate' }
];

const inflightRequests = new Map();
let lastRequestAt = 0;
let throttleQueue = Promise.resolve();
const providerCooldownUntil = {};
let currentProviderIndex = 0;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
  await setupContextMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupContextMenus();
});

setupContextMenus().catch(() => {});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_SEND_TEXT_TO_GROK) {
    const text = String(info.selectionText || '').trim();
    if (!text) {
      return;
    }

    await openGrokAndInjectPrompt(buildTextPrompt(text));
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_SEND_IMAGE_TO_GROK) {
    const srcUrl = String(info.srcUrl || '').trim();
    if (!srcUrl) {
      return;
    }

    var imagePayload = await fetchImagePayload(srcUrl);
    if (!imagePayload || !imagePayload.base64Data) {
      console.warn('[auto-translate] Skip image to Grok: payload unavailable or too large.');
      return;
    }

    if (tab && tab.id) {
      await copyImageToClipboard(tab.id, srcUrl, imagePayload);
    }

    const prompt = buildImagePrompt();
    await openGrokAndInjectPrompt(prompt, {
      pasteImageFromClipboard: true,
      manualPasteOnly: false,
      uploadWaitMs: GROK_IMAGE_UPLOAD_WAIT_MS,
      imageBase64: imagePayload.base64Data,
      imageMime: imagePayload.mimeType
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === 'translate') {
    translateText(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Translation failed' });
      });

    return true;
  }

  if (message.type === 'translate-subtitle-track') {
    translateSubtitleTrack(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Subtitle translation failed' });
      });

    return true;
  }

  if (message.type === 'translate-subtitle-vtt-text') {
    translateSubtitleVttText(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Subtitle translation failed' });
      });

    return true;
  }

  if (message.type === 'load-abc-subtitle-cues') {
    loadAbcSubtitleCues(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Failed to load subtitle cues' });
      });

    return true;
  }

  if (message.type === 'load-abc-subtitle-index') {
    loadAbcSubtitleIndex(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Failed to load subtitle index' });
      });

    return true;
  }

  if (message.type === 'load-abc-subtitle-segment-cues') {
    loadAbcSubtitleSegmentCues(message)
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Failed to load subtitle segment' });
      });

    return true;
  }
});

async function setupContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: CONTEXT_MENU_SEND_TEXT_TO_GROK,
    title: '使用Grok分析选定文字',
    contexts: ['selection']
  });

  chrome.contextMenus.create({
    id: CONTEXT_MENU_SEND_IMAGE_TO_GROK,
    title: '让Grok分析图片内容',
    contexts: ['image']
  });
}

async function openGrokAndInjectPrompt(prompt, options) {
  const opts = options || {};
  const tab = await chrome.tabs.create({
    url: GROK_WEB_URL,
    active: true
  });

  await waitForTabReady(tab.id);

  for (let i = 0; i < GROK_INJECTION_RETRY; i += 1) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [prompt, opts],
      func: function (text, options) {
        var selectors = [
          '.tiptap.ProseMirror[contenteditable="true"]',
          '[contenteditable="true"].ProseMirror',
          'div[contenteditable="true"][translate="no"]',
          'textarea',
          'div[role="textbox"]'
        ];

        function getInput() {
          for (var i = 0; i < selectors.length; i += 1) {
            var node = document.querySelector(selectors[i]);
            if (node) {
              return node;
            }
          }
          return null;
        }

        function safeDispatchInputEvents(el, value) {
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              data: value,
              inputType: 'insertText'
            }));
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              data: value,
              inputType: 'insertText'
            }));
          } catch (e) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function insertIntoContentEditable(el, value) {
          if (el && typeof el.focus === 'function') {
            el.focus();
          }

          var selection = window.getSelection();
          if (!selection) {
            return false;
          }

          selection.removeAllRanges();
          var range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          selection.addRange(range);

          var inserted = false;
          try {
            inserted = document.execCommand('insertText', false, value);
          } catch (e) {
            inserted = false;
          }

          if (!inserted) {
            el.textContent = value;
          }

          safeDispatchInputEvents(el, value);
          return true;
        }

        function clickSubmitButton() {
          var buttonSelectors = [
            'button[aria-label="Submit"]:not([disabled])',
            'button[type="submit"]:not([disabled])',
            'button[data-testid="send-button"]:not([disabled])'
          ];

          for (var i = 0; i < buttonSelectors.length; i += 1) {
            var button = document.querySelector(buttonSelectors[i]);
            if (button && typeof button.click === 'function') {
              button.click();
              return true;
            }
          }

          return false;
        }

        function trySubmit(el, delayMs) {
          var waitMs = typeof delayMs === 'number' ? delayMs : 0;
          var safeWaitMs = waitMs > 0 ? waitMs : 0;

          setTimeout(function () {
            if (el && typeof el.focus === 'function') {
              el.focus();
            }

            var eventInit = {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true
            };

            el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
            el.dispatchEvent(new KeyboardEvent('keypress', eventInit));
            el.dispatchEvent(new KeyboardEvent('keyup', eventInit));

            if (clickSubmitButton()) {
              return;
            }

            for (var i = 0; i < 10; i += 1) {
              setTimeout(clickSubmitButton, 300 * (i + 1));
            }
          }, safeWaitMs);
        }

        var input = getInput();
        if (!input) {
          return false;
        }

        var opts = options || {};
        var value = String(text || '');
        if (!value && !opts.pasteImageFromClipboard) {
          return false;
        }

        if (input && typeof input.focus === 'function') {
          input.focus();
        }

        function decodeBase64ToBytes(base64) {
          var binary = atob(base64);
          var len = binary.length;
          var bytes = new Uint8Array(len);
          for (var i = 0; i < len; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          return bytes;
        }

        function attachImageViaFileInput(base64, mimeType) {
          if (!base64) {
            return false;
          }

          var fileInput = document.querySelector('input[type="file"]');
          if (!fileInput) {
            return false;
          }

          try {
            var bytes = decodeBase64ToBytes(base64);
            var mime = mimeType || 'image/png';
            var ext = mime.indexOf('jpeg') !== -1 ? 'jpg' : (mime.split('/')[1] || 'png');
            var fileName = 'x-tweet-translator-image.' + ext;
            var file = new File([bytes], fileName, { type: mime });
            var dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          } catch (e) {
            return false;
          }
        }

        var hasValueField = false;
        try {
          hasValueField = input && ('value' in input);
        } catch (e) {
          hasValueField = false;
        }

        var textInserted = false;
        if (hasValueField && value) {
          input.value = value;
          safeDispatchInputEvents(input, value);
          textInserted = true;
        } else {
          textInserted = value ? insertIntoContentEditable(input, value) : true;
        }

        if (!textInserted) {
          return false;
        }

        var imageAttached = false;
        if (opts.imageBase64) {
          imageAttached = attachImageViaFileInput(opts.imageBase64, opts.imageMime);
        }

        if (!imageAttached && opts.pasteImageFromClipboard) {
          var pasteEventInit = {
            key: 'v',
            code: 'KeyV',
            keyCode: 86,
            which: 86,
            bubbles: true,
            cancelable: true,
            metaKey: true
          };
          input.dispatchEvent(new KeyboardEvent('keydown', pasteEventInit));
          input.dispatchEvent(new KeyboardEvent('keypress', pasteEventInit));
          input.dispatchEvent(new KeyboardEvent('keyup', pasteEventInit));

          var ctrlPasteEventInit = {
            key: 'v',
            code: 'KeyV',
            keyCode: 86,
            which: 86,
            bubbles: true,
            cancelable: true,
            ctrlKey: true
          };
          input.dispatchEvent(new KeyboardEvent('keydown', ctrlPasteEventInit));
          input.dispatchEvent(new KeyboardEvent('keypress', ctrlPasteEventInit));
          input.dispatchEvent(new KeyboardEvent('keyup', ctrlPasteEventInit));

          try {
            document.execCommand('paste');
            imageAttached = true;
          } catch (e) {}
        }

        if (textInserted) {
          if (!opts.manualPasteOnly) {
            if (opts.pasteImageFromClipboard || opts.imageBase64) {
              trySubmit(input, opts.uploadWaitMs);
            } else {
              trySubmit(input, 0);
            }
          }
        }

        return textInserted;
      }
    });

    if (result && result.result) {
      return;
    }

    await sleep(GROK_INJECTION_RETRY_INTERVAL_MS);
  }
}

async function fetchImagePayload(srcUrl) {
  if (!srcUrl) {
    return null;
  }

  var response;
  try {
    response = await fetch(srcUrl, { method: 'GET', credentials: 'omit' });
  } catch (e) {
    return null;
  }

  if (!response || !response.ok) {
    return null;
  }

  var blob;
  try {
    blob = await response.blob();
  } catch (e) {
    return null;
  }

  if (!blob || !blob.size) {
    return null;
  }

  var preparedBlob = await prepareImageBlobForTransport(blob);
  if (!preparedBlob || !preparedBlob.size || preparedBlob.size > MAX_IMAGE_BYTES) {
    return null;
  }

  var mimeType = preparedBlob.type || 'image/jpeg';
  var buffer;
  try {
    buffer = await preparedBlob.arrayBuffer();
  } catch (e) {
    return null;
  }

  var base64Data;
  try {
    base64Data = arrayBufferToBase64(buffer);
  } catch (e) {
    return null;
  }

  return {
    mimeType: mimeType,
    base64Data: base64Data
  };
}

async function prepareImageBlobForTransport(blob) {
  if (!blob || !blob.size) {
    return null;
  }

  if (blob.size <= MAX_IMAGE_BYTES) {
    return blob;
  }

  var currentBlob = blob;
  for (const step of IMAGE_RESIZE_STEPS) {
    const resizedBlob = await resizeImageBlob(currentBlob, step);
    if (!resizedBlob || !resizedBlob.size) {
      continue;
    }

    if (resizedBlob.size < currentBlob.size) {
      currentBlob = resizedBlob;
    }

    if (currentBlob.size <= MAX_IMAGE_BYTES) {
      return currentBlob;
    }
  }

  return null;
}

async function resizeImageBlob(blob, options) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return null;
  }

  var settings = options || {};
  var maxDimension = Number(settings.maxDimension) || 1600;
  var quality = Number(settings.quality);
  if (!Number.isFinite(quality)) {
    quality = 0.8;
  }

  var imageBitmap;
  try {
    imageBitmap = await createImageBitmap(blob);
  } catch (e) {
    return null;
  }

  try {
    var width = imageBitmap.width || 0;
    var height = imageBitmap.height || 0;
    if (!width || !height) {
      return null;
    }

    var longestSide = Math.max(width, height);
    var scale = longestSide > maxDimension ? maxDimension / longestSide : 1;
    var targetWidth = Math.max(1, Math.round(width * scale));
    var targetHeight = Math.max(1, Math.round(height * scale));

    var canvas = new OffscreenCanvas(targetWidth, targetHeight);
    var context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      return null;
    }

    context.drawImage(imageBitmap, 0, 0, targetWidth, targetHeight);
    var safeQuality = Math.min(0.95, Math.max(0.3, quality));
    return await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: safeQuality
    });
  } catch (e) {
    return null;
  } finally {
    if (imageBitmap && typeof imageBitmap.close === 'function') {
      imageBitmap.close();
    }
  }
}

async function copyImageToClipboard(sourceTabId, srcUrl, imagePayload) {
  if (!sourceTabId || !srcUrl) {
    return false;
  }

  var payload = imagePayload || await fetchImagePayload(srcUrl);
  if (!payload || !payload.base64Data) {
    return false;
  }

  var scriptResult = await chrome.scripting.executeScript({
    target: { tabId: sourceTabId },
    args: [payload.base64Data, payload.mimeType],
    func: async function (base64, type) {
      if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
        return false;
      }

      try {
        var binary = atob(base64);
        var len = binary.length;
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }

        var mime = type || 'image/png';
        var imageBlob = new Blob([bytes], { type: mime });
        var itemData = {};
        itemData[mime] = imageBlob;
        await navigator.clipboard.write([new ClipboardItem(itemData)]);
        return true;
      } catch (e) {
        try {
          var binaryFallback = atob(base64);
          var lenFallback = binaryFallback.length;
          var bytesFallback = new Uint8Array(lenFallback);
          for (var j = 0; j < lenFallback; j += 1) {
            bytesFallback[j] = binaryFallback.charCodeAt(j);
          }

          var pngBlob = new Blob([bytesFallback], { type: 'image/png' });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          return true;
        } catch (err) {
          return false;
        }
      }
    }
  });

  var first = scriptResult && scriptResult[0];
  return !!(first && first.result);
}

function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunkSize = 0x8000;
  var binary = '';

  for (var i = 0; i < bytes.length; i += chunkSize) {
    var chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }

  return btoa(binary);
}

async function waitForTabReady(tabId) {
  if (!tabId) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') {
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete' || settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function translateText({ text, sourceLanguage = '', targetLanguage = 'zh-CN' }) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) {
    throw new Error('Empty text');
  }

  const maxLength = 450;
  const safeText = cleanText.length > maxLength ? `${cleanText.slice(0, maxLength)}...` : cleanText;
  const normalizedTarget = normalizeLanguageCode(targetLanguage) || 'zh-CN';
  const normalizedSource =
    normalizeLanguageCode(sourceLanguage) ||
    detectSourceLanguage(safeText) ||
    '';
  const sourceForCache = normalizedSource || 'auto';

  if (normalizedSource && normalizedSource.toLowerCase().startsWith('zh')) {
    return {
      translatedText: safeText,
      providerId: 'local',
      providerLabel: getProviderLabel('local')
    };
  }

  if (normalizedSource && normalizedSource.toLowerCase() === normalizedTarget.toLowerCase()) {
    return {
      translatedText: safeText,
      providerId: 'local',
      providerLabel: getProviderLabel('local')
    };
  }

  const cacheKey = buildCacheKey({
    sourceLanguage: sourceForCache,
    targetLanguage: normalizedTarget,
    text: safeText
  });

  let cached = '';
  try {
    cached = await getCachedTranslation(cacheKey);
  } catch (error) {
    console.warn('[auto-translate] Failed to read translation cache:', error);
  }

  if (cached) {
    const cachedProviderId = cached.providerId || 'mymemory';
    return {
      translatedText: cached.value,
      providerId: cachedProviderId,
      providerLabel: `${getProviderLabel(cachedProviderId)}(Cache)`
    };
  }

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const requestPromise = fetchAndCacheTranslation({
    cacheKey,
    safeText,
    normalizedSource,
    normalizedTarget
  }).finally(() => {
    inflightRequests.delete(cacheKey);
  });

  inflightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

async function fetchAndCacheTranslation({
  cacheKey,
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  const providers = getProviderOrder(normalizedSource);
  const errors = [];

  for (const provider of providers) {
    const cooldownMs = getProviderCooldownMs(provider.id);
    if (cooldownMs > 0) {
      errors.push(`${provider.id}: rate-limited (${Math.ceil(cooldownMs / 1000)}s left)`);
      continue;
    }

    try {
      const translatedText = await runProviderWithRetries({
        provider,
        safeText,
        normalizedSource,
        normalizedTarget
      });

      currentProviderIndex = TRANSLATION_PROVIDERS.findIndex((item) => item.id === provider.id);
      try {
        await setCachedTranslation(cacheKey, translatedText, provider.id);
      } catch (cacheError) {
        console.warn('[auto-translate] Failed to write translation cache:', cacheError);
      }
      return {
        translatedText,
        providerId: provider.id,
        providerLabel: getProviderLabel(provider.id)
      };
    } catch (error) {
      if (error && error.isRateLimited) {
        const cooldownMs = error.retryAfterMs || RATE_LIMIT_COOLDOWN_MS;
        setProviderCooldown(provider.id, cooldownMs);
        errors.push(`${provider.id}: ${buildRateLimitMessage(cooldownMs)}`);
        continue;
      }

      errors.push(`${provider.id}: ${error.message || 'Translation failed'}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`All providers failed. ${errors.join(' | ')}`);
  }

  throw new Error('No translation providers available');
}

async function translateSubtitleTrack({ url, sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const subtitleUrl = String(url || '').trim();
  if (!subtitleUrl) {
    throw new Error('Empty subtitle URL');
  }

  const response = await fetch(subtitleUrl, {
    method: 'GET',
    headers: {
      Accept: 'text/vtt,text/plain,*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`Subtitle HTTP ${response.status}`);
  }

  const vttText = await response.text();
  const bilingualVtt = await buildBilingualVtt(vttText, {
    sourceLanguage,
    targetLanguage
  });

  return {
    vtt: bilingualVtt,
    providerId: 'googlegtx',
    providerLabel: getProviderLabel('googlegtx')
  };
}

async function translateSubtitleVttText({ url = '', vttText = '', sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const normalizedText = String(vttText || '');
  if (!normalizedText.trim()) {
    throw new Error('Empty subtitle VTT text');
  }

  const normalizedTarget = normalizeLanguageCode(targetLanguage) || 'zh-CN';
  const cacheIdentity = String(url || '').trim() || simpleHash(normalizedText);
  const cacheKey = `${normalizedTarget}::${cacheIdentity}`;

  if (ABC_TRANSLATED_VTT_CACHE.has(cacheKey)) {
    return ABC_TRANSLATED_VTT_CACHE.get(cacheKey);
  }

  const request = buildBilingualVtt(normalizedText, {
    sourceLanguage,
    targetLanguage: normalizedTarget
  })
    .then((bilingualVtt) => ({
      vtt: bilingualVtt,
      providerId: 'googlegtx',
      providerLabel: getProviderLabel('googlegtx')
    }))
    .catch((error) => {
      ABC_TRANSLATED_VTT_CACHE.delete(cacheKey);
      throw error;
    });

  ABC_TRANSLATED_VTT_CACHE.set(cacheKey, request);
  return request;
}

async function loadAbcSubtitleIndex({ masterUrl }) {
  const normalizedMasterUrl = String(masterUrl || '').trim();
  if (!normalizedMasterUrl) {
    throw new Error('Empty master playlist URL');
  }

  if (ABC_SUBTITLE_INDEX_CACHE.has(normalizedMasterUrl)) {
    return ABC_SUBTITLE_INDEX_CACHE.get(normalizedMasterUrl);
  }

  const request = buildAbcSubtitleIndexPayload({
    masterUrl: normalizedMasterUrl
  }).catch((error) => {
    ABC_SUBTITLE_INDEX_CACHE.delete(normalizedMasterUrl);
    throw error;
  });

  ABC_SUBTITLE_INDEX_CACHE.set(normalizedMasterUrl, request);
  return request;
}

async function buildAbcSubtitleIndexPayload({ masterUrl }) {
  const masterPlaylistText = await fetchTextResource(masterUrl, 'application/vnd.apple.mpegurl,text/plain,*/*');
  const subtitlePlaylistUrl = extractSubtitlePlaylistUrl(masterPlaylistText, masterUrl);
  if (!subtitlePlaylistUrl) {
    throw new Error('No subtitle playlist found in master manifest');
  }

  const subtitlePlaylistText = await fetchTextResource(
    subtitlePlaylistUrl,
    'application/vnd.apple.mpegurl,text/plain,*/*'
  );
  const segments = extractSubtitleSegments(subtitlePlaylistText, subtitlePlaylistUrl);
  if (segments.length === 0) {
    throw new Error('No subtitle segments found');
  }

  return {
    masterUrl,
    subtitlePlaylistUrl,
    segments
  };
}

async function loadAbcSubtitleSegmentCues({ segmentUrl, sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const normalizedSegmentUrl = String(segmentUrl || '').trim();
  if (!normalizedSegmentUrl) {
    throw new Error('Empty subtitle segment URL');
  }

  const cacheKey = `${normalizeLanguageCode(targetLanguage) || 'zh-CN'}::${normalizedSegmentUrl}`;
  if (ABC_SUBTITLE_CUE_CACHE.has(cacheKey)) {
    return ABC_SUBTITLE_CUE_CACHE.get(cacheKey);
  }

  const request = translateSubtitleTrack({
    url: normalizedSegmentUrl,
    sourceLanguage,
    targetLanguage
  })
    .then((translated) => ({
      segmentUrl: normalizedSegmentUrl,
      cues: parseBilingualVttCues(translated.vtt || '')
    }))
    .catch((error) => {
      ABC_SUBTITLE_CUE_CACHE.delete(cacheKey);
      throw error;
    });

  ABC_SUBTITLE_CUE_CACHE.set(cacheKey, request);
  return request;
}

async function loadAbcSubtitleCues({ masterUrl, sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const normalizedMasterUrl = String(masterUrl || '').trim();
  if (!normalizedMasterUrl) {
    throw new Error('Empty master playlist URL');
  }

  const cacheKey = `${normalizeLanguageCode(targetLanguage) || 'zh-CN'}::${normalizedMasterUrl}`;
  if (ABC_SUBTITLE_CUE_CACHE.has(cacheKey)) {
    return ABC_SUBTITLE_CUE_CACHE.get(cacheKey);
  }

  const request = buildAbcSubtitleCuePayload({
    masterUrl: normalizedMasterUrl,
    sourceLanguage,
    targetLanguage
  }).catch((error) => {
    ABC_SUBTITLE_CUE_CACHE.delete(cacheKey);
    throw error;
  });

  ABC_SUBTITLE_CUE_CACHE.set(cacheKey, request);
  return request;
}

async function buildAbcSubtitleCuePayload({ masterUrl, sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const masterPlaylistText = await fetchTextResource(masterUrl, 'application/vnd.apple.mpegurl,text/plain,*/*');
  const subtitlePlaylistUrl = extractSubtitlePlaylistUrl(masterPlaylistText, masterUrl);
  if (!subtitlePlaylistUrl) {
    throw new Error('No subtitle playlist found in master manifest');
  }

  const subtitlePlaylistText = await fetchTextResource(
    subtitlePlaylistUrl,
    'application/vnd.apple.mpegurl,text/plain,*/*'
  );
  const subtitleSegmentUrls = extractSubtitleSegmentUrls(subtitlePlaylistText, subtitlePlaylistUrl);
  if (subtitleSegmentUrls.length === 0) {
    throw new Error('No subtitle segments found');
  }

  const cues = [];
  const seenCueKeys = new Set();

  for (const segmentUrl of subtitleSegmentUrls) {
    const translated = await translateSubtitleTrack({
      url: segmentUrl,
      sourceLanguage,
      targetLanguage
    });

    const segmentCues = parseBilingualVttCues(translated.vtt || '');
    for (const cue of segmentCues) {
      const cueKey = `${cue.startMs}|${cue.endMs}|${cue.text}`;
      if (seenCueKeys.has(cueKey)) {
        continue;
      }

      seenCueKeys.add(cueKey);
      cues.push(cue);
    }
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return {
    masterUrl,
    subtitlePlaylistUrl,
    cues
  };
}

async function fetchTextResource(url, accept) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: accept || 'text/plain,*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

function extractSubtitlePlaylistUrl(masterPlaylistText, masterUrl) {
  const lines = String(masterPlaylistText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  for (const line of lines) {
    if (!/^#EXT-X-MEDIA:TYPE=SUBTITLES/i.test(line)) {
      continue;
    }

    const uriMatch = line.match(/URI="([^"]+)"/i);
    if (!uriMatch || !uriMatch[1]) {
      continue;
    }

    return resolveRelativeUrl(masterUrl, uriMatch[1]);
  }

  return '';
}

function extractSubtitleSegmentUrls(playlistText, playlistUrl) {
  const urls = [];
  const lines = String(playlistText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    urls.push(resolveRelativeUrl(playlistUrl, trimmed));
  }

  return urls.filter(Boolean);
}

function extractSubtitleSegments(playlistText, playlistUrl) {
  const lines = String(playlistText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const segments = [];
  let pendingDurationMs = 0;
  let accumulatedMs = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('#EXTINF:')) {
      const durationValue = Number(trimmed.slice(8).split(',')[0] || 0);
      pendingDurationMs = Number.isFinite(durationValue) ? Math.max(0, Math.round(durationValue * 1000)) : 0;
      continue;
    }

    if (trimmed.startsWith('#')) {
      continue;
    }

    const url = resolveRelativeUrl(playlistUrl, trimmed);
    if (!url) {
      continue;
    }

    const ptsStartMs = parsePtsMsFromSegmentUrl(url);
    const startMs = Number.isFinite(ptsStartMs) ? ptsStartMs : accumulatedMs;
    const durationMs = pendingDurationMs;

    segments.push({
      index: segments.length,
      url,
      startMs,
      endMs: startMs + durationMs,
      durationMs
    });

    accumulatedMs = startMs + durationMs;
    pendingDurationMs = 0;
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    const nextStartMs = segments[i + 1].startMs;
    if (Number.isFinite(nextStartMs) && nextStartMs >= segments[i].startMs) {
      segments[i].endMs = nextStartMs;
    }
  }

  return segments;
}

function parsePtsMsFromSegmentUrl(segmentUrl) {
  const match = String(segmentUrl || '').match(/\/pts_(\d+)\.vtt(?:$|[?#])/i);
  if (!match) {
    return NaN;
  }

  return Number(match[1] || NaN);
}

function resolveRelativeUrl(baseUrl, input) {
  try {
    return new URL(String(input || ''), String(baseUrl || '')).href;
  } catch (_error) {
    return '';
  }
}

function parseBilingualVttCues(vttText) {
  const blocks = String(vttText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const cue = parseBilingualVttCue(block);
    if (!cue) {
      continue;
    }

    cues.push(cue);
  }

  return cues;
}

function parseBilingualVttCue(blockText) {
  const lines = String(blockText || '').split('\n');
  const timingLine = lines.find((line) => line.includes('-->'));
  if (!timingLine) {
    return null;
  }

  const parts = timingLine.split('-->');
  if (parts.length < 2) {
    return null;
  }

  const startMs = parseVttTimestampToMs(parts[0]);
  const endMs = parseVttTimestampToMs(parts[1]);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }

  const timingIndex = lines.findIndex((line) => line === timingLine);
  const payloadLines = lines
    .slice(timingIndex + 1)
    .map((line) => line.trim())
    .filter(Boolean);
  if (payloadLines.length === 0) {
    return null;
  }

  return {
    startMs,
    endMs,
    text: payloadLines.join('\n')
  };
}

function parseVttTimestampToMs(value) {
  const match = String(value || '')
    .trim()
    .match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) {
    return NaN;
  }

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const milliseconds = Number(match[4] || 0);
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

async function buildBilingualVtt(vttText, { sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const normalizedVtt = String(vttText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const blocks = normalizedVtt.split(/\n{2,}/);
  const parsedCues = [];
  const cueTexts = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const cue = parseVttCueBlock(blocks[i]);
    parsedCues.push(cue);

    if (!cue) {
      continue;
    }

    const cueText = cue.payloadLines.join('\n').trim();
    if (!shouldTranslateCueText(cueText)) {
      continue;
    }

    cueTexts.push({
      blockIndex: i,
      text: cueText
    });
  }

  if (cueTexts.length === 0) {
    return normalizedVtt;
  }

  const translatedTexts = await translateCuePayloads(
    cueTexts.map((item) => item.text),
    { sourceLanguage, targetLanguage }
  );

  for (let i = 0; i < cueTexts.length; i += 1) {
    const item = cueTexts[i];
    const translatedText = trimTranslatedCueText(translatedTexts[i] || '');
    if (!translatedText || translatedText === item.text) {
      continue;
    }

    const cue = parsedCues[item.blockIndex];
    cue.payloadLines = cue.payloadLines.concat(translatedText.split('\n'));
    blocks[item.blockIndex] = renderVttCueBlock(cue);
  }

  return blocks.join('\n\n');
}

function parseVttCueBlock(blockText) {
  const lines = String(blockText || '').split('\n');
  const timingIndex = lines.findIndex((line) => line.includes('-->'));
  if (timingIndex === -1) {
    return null;
  }

  return {
    identifierLines: lines.slice(0, timingIndex),
    timingLine: lines[timingIndex],
    payloadLines: lines.slice(timingIndex + 1)
  };
}

function renderVttCueBlock(cue) {
  return [
    ...cue.identifierLines,
    cue.timingLine,
    ...cue.payloadLines
  ].join('\n');
}

function shouldTranslateCueText(text) {
  const value = trimTranslatedCueText(text);
  if (!value) {
    return false;
  }

  if (/^[\s\u266a]+$/.test(value)) {
    return false;
  }

  return !normalizeLanguageCode(detectSourceLanguage(value)).startsWith('zh');
}

async function translateCuePayloads(payloads, { sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const results = new Array(payloads.length);
  const batches = buildSubtitleBatches(payloads);

  for (const batch of batches) {
    try {
      const translatedBatch = await translateSubtitleBatch(batch, {
        sourceLanguage,
        targetLanguage
      });

      for (let i = 0; i < batch.length; i += 1) {
        results[batch[i].index] = translatedBatch[i];
      }
    } catch (_error) {
      for (const item of batch) {
        const response = await translateText({
          text: item.text,
          sourceLanguage,
          targetLanguage
        });
        results[item.index] = trimTranslatedCueText(response.translatedText || '');
      }
    }
  }

  return results;
}

function buildSubtitleBatches(payloads) {
  const batches = [];
  let currentBatch = [];
  let currentLength = 0;

  for (let i = 0; i < payloads.length; i += 1) {
    const text = trimTranslatedCueText(payloads[i]);
    if (!text) {
      continue;
    }

    const separatorOverhead = currentBatch.length === 0 ? 0 : 24;
    const nextLength = currentLength + separatorOverhead + text.length;
    if (currentBatch.length > 0 && nextLength > SUBTITLE_BATCH_MAX_CHARS) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLength = 0;
    }

    currentBatch.push({
      index: i,
      text
    });
    currentLength += (currentBatch.length === 1 ? 0 : 24) + text.length;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

async function translateSubtitleBatch(batch, { sourceLanguage = 'en', targetLanguage = 'zh-CN' }) {
  const separatorTokens = [];
  let joinedText = '';

  for (let i = 0; i < batch.length; i += 1) {
    if (i > 0) {
      const token = `[[XT_SUB_SPLIT_${i - 1}]]`;
      separatorTokens.push(token);
      joinedText += `\n${token}\n`;
    }

    joinedText += batch[i].text;
  }

  const translatedText = await runProviderWithRetries({
    provider: { id: 'googlegtx' },
    safeText: joinedText,
    normalizedSource:
      normalizeLanguageCode(sourceLanguage) ||
      detectSourceLanguage(joinedText) ||
      'en',
    normalizedTarget: normalizeLanguageCode(targetLanguage) || 'zh-CN'
  });

  return splitTranslatedSubtitleBatch(translatedText, separatorTokens);
}

function splitTranslatedSubtitleBatch(translatedText, separatorTokens) {
  const parts = [];
  let remaining = String(translatedText || '');

  for (const token of separatorTokens) {
    const tokenIndex = remaining.indexOf(token);
    if (tokenIndex === -1) {
      throw new Error('Subtitle batch separator lost during translation');
    }

    parts.push(trimTranslatedCueText(remaining.slice(0, tokenIndex)));
    remaining = remaining.slice(tokenIndex + token.length);
  }

  parts.push(trimTranslatedCueText(remaining));
  return parts;
}

function trimTranslatedCueText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

async function runProviderWithRetries({
  provider,
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await waitForThrottleWindow();
      return await requestTranslation({
        provider,
        safeText,
        normalizedSource,
        normalizedTarget
      });
    } catch (error) {
      lastError = error;
      if (error && error.isRateLimited) {
        throw error;
      }

      const isLastAttempt = attempt === MAX_RETRY_ATTEMPTS;
      if (isLastAttempt || !isRetryableError(error)) {
        throw error;
      }

      await sleep(getRetryDelayMs(attempt));
    }
  }

  throw lastError || new Error('Translation failed');
}

async function waitForThrottleWindow() {
  const task = throttleQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, REQUEST_MIN_INTERVAL_MS - (now - lastRequestAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
  });

  throttleQueue = task.catch(() => {});
  await task;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt) {
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function isRetryableError(error) {
  const message = String((error && error.message) || '');
  return (
    message.startsWith('HTTP 5') ||
    message.startsWith('HTTP 429') ||
    message.startsWith('API error 5') ||
    message.startsWith('API error 429') ||
    message.includes('Failed to fetch')
  );
}

function buildRateLimitMessage(cooldownMs) {
  const seconds = Math.max(1, Math.ceil(cooldownMs / 1000));
  return `Rate limited by translation provider. Retry in about ${seconds}s.`;
}

async function requestTranslation({
  provider,
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  if (provider.id === 'mymemory') {
    return requestMyMemory({
      safeText,
      normalizedSource,
      normalizedTarget
    });
  }

  if (provider.id === 'googlegtx') {
    return requestGoogleGTX({
      safeText,
      normalizedSource,
      normalizedTarget
    });
  }

  if (provider.id === 'libretranslate') {
    return requestLibreTranslate({
      safeText,
      normalizedSource,
      normalizedTarget
    });
  }

  throw new Error(`Unknown provider: ${provider.id}`);
}

async function requestMyMemory({
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  const source = mapLanguageForMyMemory(normalizedSource);
  const target = mapLanguageForMyMemory(normalizedTarget);
  if (!source || !target) {
    throw new Error('MyMemory requires explicit source and target languages');
  }

  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', safeText);
  url.searchParams.set('langpair', `${source}|${target}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (response.status === 429) {
    throw rateLimitError(parseRetryAfterMs(response.headers.get('Retry-After')));
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const responseStatus = Number((data && data.responseStatus) || 0);
  if (responseStatus === 429) {
    throw rateLimitError(RATE_LIMIT_COOLDOWN_MS);
  }

  const responseDetails = String((data && data.responseDetails) || '');
  if (/quota exceeded|too many requests|rate limit/i.test(responseDetails)) {
    throw rateLimitError(RATE_LIMIT_COOLDOWN_MS);
  }

  if (responseStatus >= 400) {
    throw new Error((data && data.responseDetails) || `API error ${responseStatus}`);
  }

  const translatedText = String(
    (data && data.responseData && data.responseData.translatedText) || ''
  ).trim();
  if (!translatedText) {
    throw new Error('No translated text returned');
  }

  return translatedText;
}

async function requestLibreTranslate({
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  const source = mapLanguageForLibreTranslate(normalizedSource);
  const target = mapLanguageForLibreTranslate(normalizedTarget);

  const response = await fetch('https://libretranslate.com/translate', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: safeText,
      source,
      target,
      format: 'text'
    })
  });

  if (response.status === 429) {
    throw rateLimitError(parseRetryAfterMs(response.headers.get('Retry-After')));
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (response.status === 400 && contentType.includes('application/json')) {
    const data = await response.json();
    const errorText = String((data && data.error) || '').trim();
    throw new Error(errorText || 'HTTP 400');
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const translatedText = String((data && data.translatedText) || '').trim();
  if (!translatedText) {
    const errorText = String((data && data.error) || '').trim();
    if (/too many requests|rate limit/i.test(errorText)) {
      throw rateLimitError(RATE_LIMIT_COOLDOWN_MS);
    }
    throw new Error(errorText || 'No translated text returned');
  }

  return translatedText;
}

async function requestGoogleGTX({
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  const source = mapLanguageForGoogle(normalizedSource);
  const target = mapLanguageForGoogle(normalizedTarget);

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', source);
  url.searchParams.set('tl', target);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', safeText);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*'
    }
  });

  if (response.status === 429) {
    throw rateLimitError(parseRetryAfterMs(response.headers.get('Retry-After')));
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const segments = Array.isArray(data && data[0]) ? data[0] : [];
  const translatedText = segments
    .map((segment) => (Array.isArray(segment) ? String(segment[0] || '') : ''))
    .join('')
    .trim();

  if (!translatedText) {
    throw new Error('No translated text returned');
  }

  return translatedText;
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) {
    return RATE_LIMIT_COOLDOWN_MS;
  }

  const asSeconds = Number(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.round(asSeconds * 1000);
  }

  return RATE_LIMIT_COOLDOWN_MS;
}

function rateLimitError(retryAfterMs) {
  const error = new Error('HTTP 429');
  error.isRateLimited = true;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function getProviderOrder(sourceLanguage = '') {
  const size = TRANSLATION_PROVIDERS.length;
  if (size === 0) {
    return [];
  }

  const start = ((currentProviderIndex % size) + size) % size;
  const ordered = [];
  const hasSourceLanguage = !!normalizeLanguageCode(sourceLanguage);

  for (let i = 0; i < size; i += 1) {
    const provider = TRANSLATION_PROVIDERS[(start + i) % size];
    if (!hasSourceLanguage && provider.id === 'mymemory') {
      continue;
    }
    ordered.push(provider);
  }

  if (ordered.length > 0) {
    return ordered;
  }

  for (let i = 0; i < size; i += 1) {
    ordered.push(TRANSLATION_PROVIDERS[(start + i) % size]);
  }

  return ordered;
}

function setProviderCooldown(providerId, cooldownMs) {
  providerCooldownUntil[providerId] = Date.now() + Math.max(1, cooldownMs);
}

function getProviderCooldownMs(providerId) {
  const until = providerCooldownUntil[providerId] || 0;
  return Math.max(0, until - Date.now());
}

function buildCacheKey({ sourceLanguage, targetLanguage, text }) {
  const raw = `${CACHE_VERSION}|${sourceLanguage}|${targetLanguage}|${text}`;
  return `translation:${simpleHash(raw)}`;
}

function simpleHash(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }

  return (hash >>> 0).toString(36);
}

async function getCachedTranslation(cacheKey) {
  const stored = await chrome.storage.local.get(cacheKey);
  const record = stored && stored[cacheKey];
  if (!record) {
    return '';
  }

  if (typeof record === 'string') {
    return {
      value: record,
      createdAt: Date.now(),
      providerId: 'cache'
    };
  }

  if (!record || !record.value || typeof record.createdAt !== 'number') {
    return '';
  }

  if (Date.now() - record.createdAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(cacheKey);
    return '';
  }

  return {
    value: record.value,
    createdAt: record.createdAt,
    providerId: record.providerId || 'cache'
  };
}

async function setCachedTranslation(cacheKey, value, providerId) {
  await chrome.storage.local.set({
    [cacheKey]: {
      value,
      createdAt: Date.now(),
      providerId
    }
  });
}

function normalizeLanguageCode(input) {
  if (!input) {
    return '';
  }

  const value = String(input).trim();
  if (!value) {
    return '';
  }
  if (value.toLowerCase() === 'auto') {
    return '';
  }

  if (value.includes('-')) {
    const [base, region] = value.split('-');
    if (!base || !region) {
      return '';
    }

    return `${base.toLowerCase()}-${region.toUpperCase()}`;
  }

  return value.toLowerCase();
}

function detectSourceLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) {
    return 'ja';
  }

  if (/[\uac00-\ud7af]/.test(text)) {
    return 'ko';
  }

  if (/[\u4e00-\u9fff]/.test(text)) {
    return 'zh-CN';
  }

  if (/[\u0400-\u04ff]/.test(text)) {
    return 'ru';
  }

  if (/[\u0600-\u06ff]/.test(text)) {
    return 'ar';
  }

  if (/[\u0590-\u05ff]/.test(text)) {
    return 'he';
  }

  if (/[\u0e00-\u0e7f]/.test(text)) {
    return 'th';
  }

  if (/[\u0900-\u097f]/.test(text)) {
    return 'hi';
  }

  if (/[a-zA-Z]/.test(text)) {
    return 'en';
  }

  return '';
}

function mapLanguageForMyMemory(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);
  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('zh')) {
    return normalized.includes('-') ? normalized : 'zh-CN';
  }

  return normalized;
}

function mapLanguageForLibreTranslate(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);
  if (!normalized) {
    return 'auto';
  }

  if (normalized.startsWith('zh')) {
    return 'zh';
  }

  if (normalized.includes('-')) {
    return normalized.split('-')[0];
  }

  return normalized;
}

function mapLanguageForGoogle(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);
  if (!normalized) {
    return 'auto';
  }

  return normalized;
}

function buildTextPrompt(text) {
  return `请介绍这个：\n${text}`;
}

function buildImagePrompt() {
  return '中文介绍图片内容。';
}

function getProviderLabel(providerId) {
  if (providerId === 'mymemory') {
    return 'MyMemory';
  }
  if (providerId === 'googlegtx') {
    return 'Google GTX';
  }
  if (providerId === 'libretranslate') {
    return 'LibreTranslate';
  }
  if (providerId === 'local') {
    return 'Local';
  }
  if (providerId === 'cache') {
    return 'MyMemory';
  }

  return 'MyMemory';
}
