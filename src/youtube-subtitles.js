const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};
const PAGE_HOOK_SOURCE = 'xt-youtube-subtitle-hook';
const PAGE_HOOK_TIMEDTEXT_XHR_START_TYPE = 'xt-youtube-timedtext-xhr-start';
const PAGE_HOOK_TIMEDTEXT_XHR_COMPLETE_TYPE = 'xt-youtube-timedtext-xhr-complete';
const TRANSCRIPT_PANEL_ID = 'xt-youtube-transcript-panel';
const TRANSCRIPT_LIST_ID = 'xt-youtube-transcript-list';
const TRANSCRIPT_STYLE_ID = 'xt-youtube-transcript-style';
const TRANSCRIPT_TRANSLATION_BATCH_SIZE = 80;

let settings = { ...DEFAULT_SETTINGS };
let activeTranscriptUrl = '';
let transcriptItems = [];
let transcriptStatusText = '';
let transcriptTranslationRunId = 0;
let currentVideo = null;
let currentTranscriptKey = '';

init().catch((error) => {
  console.warn('[auto-translate] Failed to initialize YouTube transcript panel:', error);
});

async function init() {
  settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  window.addEventListener('message', handlePageMessage);
  injectPageHook();
  installTranscriptStyle();
  attachVideoListeners();
  window.addEventListener('yt-navigate-finish', handleYoutubeNavigation, true);
  window.addEventListener('yt-navigate-finish', attachVideoListeners, true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') {
      return;
    }

    for (const [key, value] of Object.entries(changes)) {
      settings[key] = value.newValue;
    }

    if (!settings.enabled) {
      hideTranscriptPanel();
      return;
    }

    renderTranscriptPanel();
  });
}

function injectPageHook() {
  if (window !== window.top) {
    return;
  }

  if (document.documentElement?.dataset.xtYoutubePageHookInjected === '1') {
    return;
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/youtube-page-hook.js');
  script.async = false;
  script.dataset.xtYoutubePageHook = '1';
  script.addEventListener('load', () => {
    script.remove();
  });
  script.addEventListener('error', () => {
    script.remove();
  });

  document.documentElement.dataset.xtYoutubePageHookInjected = '1';
  (document.head || document.documentElement).appendChild(script);
}

function handlePageMessage(event) {
  if (event.source !== window || !event.data) {
    return;
  }

  const { source, type, url, jsonText, ok, error } = event.data;
  if (source !== PAGE_HOOK_SOURCE) {
    return;
  }

  if (type === PAGE_HOOK_TIMEDTEXT_XHR_START_TYPE) {
    activeTranscriptUrl = String(url || '');
    transcriptItems = [];
    transcriptStatusText = '正在加载 YouTube 字幕...';
    transcriptTranslationRunId += 1;
    currentTranscriptKey = '';
    renderTranscriptPanel();
    return;
  }

  if (type !== PAGE_HOOK_TIMEDTEXT_XHR_COMPLETE_TYPE) {
    return;
  }

  if (!ok || !String(jsonText || '').trim()) {
    transcriptItems = [];
    transcriptStatusText = error ? `字幕加载失败：${error}` : '字幕加载失败';
    transcriptTranslationRunId += 1;
    renderTranscriptPanel();
    return;
  }

  loadTranscriptFromJson3Text({
    url: String(url || ''),
    jsonText: String(jsonText || '')
  }).catch((loadError) => {
    transcriptItems = [];
    transcriptStatusText = loadError.message || '字幕解析失败';
    transcriptTranslationRunId += 1;
    renderTranscriptPanel();
  });
}

async function loadTranscriptFromJson3Text({ url = '', jsonText = '' }) {
  const response = await chrome.runtime.sendMessage({
    type: 'parse-youtube-subtitle-cues',
    jsonText
  });

  if (!response || !response.ok || !Array.isArray(response.cues)) {
    throw new Error((response && response.error) || '字幕解析失败');
  }

  activeTranscriptUrl = String(url || activeTranscriptUrl || '');
  transcriptItems = buildTranscriptItems(response.cues);
  transcriptStatusText = transcriptItems.length > 0 ? '' : '字幕为空';
  transcriptTranslationRunId += 1;
  currentTranscriptKey = '';
  renderTranscriptPanel();
  void translateTranscriptItems();
}

function buildTranscriptItems(cues) {
  const items = [];
  let currentText = '';
  let currentStartMs = 0;
  let currentEndMs = 0;

  for (const cue of cues || []) {
    const text = normalizeTranscriptText(cue && cue.text);
    if (!text) {
      continue;
    }

    if (!currentText) {
      currentStartMs = Number(cue.startMs) || 0;
      currentText = text;
    } else {
      currentText = `${currentText} ${text}`;
    }

    currentEndMs = Number(cue.endMs) || currentStartMs;
    if (shouldFlushTranscriptSentence(currentText)) {
      items.push(buildTranscriptItem(items.length, currentStartMs, currentEndMs, currentText));
      currentText = '';
      currentStartMs = 0;
      currentEndMs = 0;
    }
  }

  if (currentText) {
    items.push(buildTranscriptItem(items.length, currentStartMs, currentEndMs, currentText));
  }

  return items;
}

function normalizeTranscriptText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldFlushTranscriptSentence(text) {
  const value = String(text || '').trim();
  return /[.!?]["')\]]?$/.test(value) || value.length >= 180;
}

function buildTranscriptItem(index, startMs, endMs, text) {
  return {
    key: `transcript:${startMs}:${endMs}:${index}`,
    startMs,
    endMs,
    text: String(text || '').trim(),
    translatedText: ''
  };
}

function installTranscriptStyle() {
  if (document.getElementById(TRANSCRIPT_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = TRANSCRIPT_STYLE_ID;
  style.textContent = `
    #${TRANSCRIPT_PANEL_ID} {
      position: fixed;
      top: 88px;
      right: 16px;
      z-index: 2147483647;
      width: min(420px, 34vw);
      max-height: calc(100vh - 120px);
      display: none;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 8px;
      background: rgba(15, 15, 15, 0.94);
      color: #f5f5f5;
      font-family: Arial, Helvetica, sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    #${TRANSCRIPT_PANEL_ID}.xt-visible {
      display: flex;
      flex-direction: column;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      font-size: 13px;
      font-weight: 700;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-close {
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
      color: #f5f5f5;
      cursor: pointer;
      font-size: 18px;
      line-height: 20px;
    }
    #${TRANSCRIPT_LIST_ID} {
      overflow-y: auto;
      padding: 8px 0;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-item {
      padding: 8px 12px;
      border-left: 3px solid transparent;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-item.xt-current {
      border-left-color: #3ea6ff;
      background: rgba(62, 166, 255, 0.12);
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-time {
      margin-bottom: 3px;
      color: #aaa;
      font-size: 11px;
      line-height: 1.2;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-en {
      color: #fff;
      font-size: 13px;
      line-height: 1.35;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-zh {
      margin-top: 4px;
      color: #9bd37a;
      font-size: 13px;
      line-height: 1.4;
      min-height: 1em;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-loading {
      color: #888;
      font-style: italic;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-status {
      padding: 14px 12px;
      color: #bbb;
      font-size: 13px;
      line-height: 1.4;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function renderTranscriptPanel() {
  const panel = getOrCreateTranscriptPanel();
  const list = document.getElementById(TRANSCRIPT_LIST_ID);
  if (!list) {
    return;
  }

  const shouldShowPanel = settings.enabled && (transcriptItems.length > 0 || Boolean(transcriptStatusText));
  panel.classList.toggle('xt-visible', shouldShowPanel);
  list.textContent = '';

  if (transcriptItems.length === 0 && transcriptStatusText) {
    const status = document.createElement('div');
    status.className = 'xt-transcript-status';
    status.textContent = transcriptStatusText;
    list.appendChild(status);
    return;
  }

  for (const item of transcriptItems) {
    list.appendChild(renderTranscriptItem(item));
  }

  updateTranscriptCurrentItem();
}

function getOrCreateTranscriptPanel() {
  let panel = document.getElementById(TRANSCRIPT_PANEL_ID);
  if (panel) {
    return panel;
  }

  panel = document.createElement('aside');
  panel.id = TRANSCRIPT_PANEL_ID;
  panel.setAttribute('aria-label', 'Translated transcript');

  const header = document.createElement('div');
  header.className = 'xt-transcript-header';

  const title = document.createElement('span');
  title.textContent = '字幕翻译';
  header.appendChild(title);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'xt-transcript-close';
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => {
    panel.classList.remove('xt-visible');
  });
  header.appendChild(closeButton);

  const list = document.createElement('div');
  list.id = TRANSCRIPT_LIST_ID;

  panel.appendChild(header);
  panel.appendChild(list);
  document.documentElement.appendChild(panel);
  return panel;
}

function renderTranscriptItem(item) {
  const row = document.createElement('div');
  row.className = 'xt-transcript-item';
  row.dataset.key = item.key;
  row.dataset.startMs = String(item.startMs);
  row.dataset.endMs = String(item.endMs);

  const time = document.createElement('div');
  time.className = 'xt-transcript-time';
  time.textContent = formatTranscriptTime(item.startMs);
  row.appendChild(time);

  const english = document.createElement('div');
  english.className = 'xt-transcript-en';
  english.textContent = item.text;
  row.appendChild(english);

  const chinese = document.createElement('div');
  chinese.className = 'xt-transcript-zh';
  chinese.textContent = item.translatedText || '翻译中...';
  chinese.classList.toggle('xt-transcript-loading', !item.translatedText);
  row.appendChild(chinese);

  return row;
}

function formatTranscriptTime(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function attachVideoListeners() {
  const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
  if (!video || currentVideo === video) {
    return;
  }

  if (currentVideo) {
    currentVideo.removeEventListener('timeupdate', updateTranscriptCurrentItem);
    currentVideo.removeEventListener('seeked', updateTranscriptCurrentItem);
  }

  currentVideo = video;
  currentVideo.addEventListener('timeupdate', updateTranscriptCurrentItem);
  currentVideo.addEventListener('seeked', updateTranscriptCurrentItem);
  updateTranscriptCurrentItem();
}

function updateTranscriptCurrentItem() {
  if (!currentVideo || transcriptItems.length === 0) {
    return;
  }

  const currentMs = Math.max(0, Math.round(currentVideo.currentTime * 1000));
  const currentItem = transcriptItems.find((item) => currentMs >= item.startMs && currentMs <= item.endMs);
  const nextKey = currentItem ? currentItem.key : '';
  if (nextKey === currentTranscriptKey) {
    return;
  }

  if (currentTranscriptKey) {
    const previousRow = findTranscriptRow(currentTranscriptKey);
    if (previousRow) {
      previousRow.classList.remove('xt-current');
    }
  }

  currentTranscriptKey = nextKey;
  const activeRow = nextKey ? findTranscriptRow(nextKey) : null;
  if (activeRow) {
    activeRow.classList.add('xt-current');
    if (!isTranscriptRowVisible(activeRow)) {
      activeRow.scrollIntoView({ block: 'center' });
    }
  }
}

function findTranscriptRow(key) {
  if (!key) {
    return null;
  }

  return document.querySelector(`#${TRANSCRIPT_LIST_ID} .xt-transcript-item[data-key="${cssEscape(key)}"]`);
}

function isTranscriptRowVisible(row) {
  const list = document.getElementById(TRANSCRIPT_LIST_ID);
  if (!list || !row) {
    return true;
  }

  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom;
}

async function translateTranscriptItems() {
  const runId = transcriptTranslationRunId;
  const targetLanguage = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;

  for (let start = 0; start < transcriptItems.length; start += TRANSCRIPT_TRANSLATION_BATCH_SIZE) {
    if (runId !== transcriptTranslationRunId || !settings.enabled) {
      return;
    }

    const batch = transcriptItems
      .slice(start, start + TRANSCRIPT_TRANSLATION_BATCH_SIZE)
      .filter((item) => item.text && !item.translatedText);
    if (batch.length === 0) {
      continue;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'translate-youtube-subtitle-cue-texts',
        cues: batch.map((item) => ({
          key: item.key,
          text: item.text
        })),
        sourceLanguage: 'en',
        targetLanguage
      });

      if (!response || !response.ok || !Array.isArray(response.translations)) {
        continue;
      }

      const translationMap = new Map();
      for (const item of response.translations) {
        translationMap.set(String(item.key || ''), String(item.text || '').trim());
      }

      for (const item of batch) {
        const translatedText = translationMap.get(item.key) || '';
        if (translatedText && translatedText !== item.text) {
          item.translatedText = translatedText;
        }
      }

      updateTranscriptTranslations(batch);
    } catch (_error) {}
  }
}

function updateTranscriptTranslations(items) {
  for (const item of items) {
    const row = findTranscriptRow(item.key);
    if (!row) {
      continue;
    }

    const chinese = row.querySelector('.xt-transcript-zh');
    if (!chinese) {
      continue;
    }

    chinese.textContent = item.translatedText || '翻译中...';
    chinese.classList.toggle('xt-transcript-loading', !item.translatedText);
  }
}

function handleYoutubeNavigation() {
  activeTranscriptUrl = '';
  transcriptItems = [];
  transcriptStatusText = '';
  transcriptTranslationRunId += 1;
  currentTranscriptKey = '';
  renderTranscriptPanel();
}

function hideTranscriptPanel() {
  const panel = document.getElementById(TRANSCRIPT_PANEL_ID);
  if (panel) {
    panel.classList.remove('xt-visible');
  }
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(String(value || ''));
  }

  return String(value || '').replace(/["\\]/g, '\\$&');
}
