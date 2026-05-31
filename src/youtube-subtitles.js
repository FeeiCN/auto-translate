const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};
const PAGE_HOOK_SOURCE = 'xt-youtube-subtitle-hook';
const PAGE_HOOK_TIMEDTEXT_XHR_START_TYPE = 'xt-youtube-timedtext-xhr-start';
const PAGE_HOOK_TIMEDTEXT_XHR_COMPLETE_TYPE = 'xt-youtube-timedtext-xhr-complete';
const TRANSCRIPT_PANEL_ID = 'xt-youtube-transcript-panel';
const TRANSCRIPT_TOGGLE_ID = 'xt-youtube-transcript-toggle';
const TRANSCRIPT_LIST_ID = 'xt-youtube-transcript-list';
const TRANSCRIPT_STYLE_ID = 'xt-youtube-transcript-style';
const TRANSCRIPT_TRANSLATION_BATCH_SIZE = 80;
const YT_VIDEO_TITLE_SELECTOR = 'span.ytAttributedStringHost[role="text"]:not(.ytContentMetadataViewModelMetadataText), yt-formatted-string.ytd-watch-metadata, yt-formatted-string#title.ytd-channel-video-player-renderer';
const YT_TITLE_BOUND_ATTR = 'data-xt-title-bound';
const YT_TITLE_SCAN_DEBOUNCE_MS = 300;

let settings = { ...DEFAULT_SETTINGS };
let activeTranscriptUrl = '';
let transcriptItems = [];
let transcriptStatusText = '';
let transcriptTranslationRunId = 0;
let currentVideo = null;
let currentTranscriptKey = '';
let transcriptCollapsed = false;
let ytTitleObserver = null;
let ytTitleScanTimer = 0;
const ytTitlePendingRoots = new Set();

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
  window.addEventListener('yt-navigate-finish', () => {
    resetYtWatchPageTitle();
    queueYtTitleScan(document.body);
  }, true);

  installYtTitleStyle();
  observeYtTitles();
  queueYtTitleScan(document.body);

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

function isYoutubeWatchPage() {
  return window.location.pathname === '/watch' && Boolean(new URLSearchParams(window.location.search).get('v'));
}

function handlePageMessage(event) {
  if (event.source !== window || !event.data) {
    return;
  }

  const { source, type, url, jsonText, ok, error } = event.data;
  if (source !== PAGE_HOOK_SOURCE) {
    return;
  }

  if (!isYoutubeWatchPage()) {
    return;
  }

  if (type === PAGE_HOOK_TIMEDTEXT_XHR_START_TYPE) {
    activeTranscriptUrl = String(url || '');
    transcriptItems = [];
    transcriptStatusText = '正在加载 YouTube 字幕...';
    transcriptTranslationRunId += 1;
    currentTranscriptKey = '';
    transcriptCollapsed = false;
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
  const joined = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return maybeToSentenceCase(joined);
}

function maybeToSentenceCase(text) {
  const letters = text.match(/[a-zA-Z]/g);
  if (!letters || letters.length < 4) {
    return text;
  }
  const upperCount = letters.filter((c) => c >= 'A' && c <= 'Z').length;
  if (upperCount / letters.length < 0.8) {
    return text;
  }
  return text
    .toLowerCase()
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase())
    .replace(/\bi\b/g, 'I');
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
      background: #0f0f0f;
      color: #f5f5f5;
      font-family: Arial, Helvetica, sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    #${TRANSCRIPT_PANEL_ID}.xt-visible {
      display: flex;
      flex-direction: column;
    }
    #${TRANSCRIPT_PANEL_ID}.xt-collapsed {
      display: none;
    }
    #${TRANSCRIPT_TOGGLE_ID} {
      position: fixed;
      top: 88px;
      right: 16px;
      z-index: 2147483647;
      display: none;
      width: 36px;
      min-height: 104px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 8px;
      background: #0f0f0f;
      color: #f5f5f5;
      cursor: pointer;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.2;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    #${TRANSCRIPT_TOGGLE_ID}.xt-visible {
      display: block;
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
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-title {
      position: relative;
      flex: 1;
      min-width: 0;
      border-radius: 3px;
      overflow: hidden;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-title-progress {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      width: 0%;
      background: rgba(62, 166, 255, 0.28);
      border-radius: 3px;
      transition: width 0.4s ease;
      pointer-events: none;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-title-text {
      position: relative;
      z-index: 1;
      padding: 1px 2px;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-collapse,
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-copy {
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.1);
      color: #f5f5f5;
      cursor: pointer;
      font-size: 14px;
      line-height: 24px;
      text-align: center;
      flex-shrink: 0;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-collapse {
      font-size: 18px;
      line-height: 20px;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-copy {
      display: none;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-copy.xt-ready {
      display: block;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-copy.xt-copied {
      color: #9bd37a;
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
      font-size: 15px;
      line-height: 1.35;
    }
    #${TRANSCRIPT_PANEL_ID} .xt-transcript-zh {
      margin-top: 4px;
      color: #9bd37a;
      font-size: 15px;
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
  const toggle = getOrCreateTranscriptToggle();
  const list = document.getElementById(TRANSCRIPT_LIST_ID);
  if (!list) {
    return;
  }

  const shouldShowPanel = settings.enabled && (transcriptItems.length > 0 || Boolean(transcriptStatusText));
  panel.classList.toggle('xt-visible', shouldShowPanel && !transcriptCollapsed);
  panel.classList.toggle('xt-collapsed', shouldShowPanel && transcriptCollapsed);
  toggle.classList.toggle('xt-visible', shouldShowPanel && transcriptCollapsed);
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
  updateTranscriptProgress();
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

  const titleWrapper = document.createElement('div');
  titleWrapper.className = 'xt-transcript-title';

  const titleProgress = document.createElement('div');
  titleProgress.className = 'xt-transcript-title-progress';
  titleWrapper.appendChild(titleProgress);

  const titleText = document.createElement('span');
  titleText.className = 'xt-transcript-title-text';
  titleText.textContent = '字幕翻译';
  titleWrapper.appendChild(titleText);

  header.appendChild(titleWrapper);

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'xt-transcript-copy';
  copyButton.textContent = '⎘';
  copyButton.title = '复制所有中文翻译';
  copyButton.addEventListener('click', () => {
    const translations = transcriptItems
      .map((item) => item.translatedText)
      .filter(Boolean)
      .join('\n');
    if (!translations) {
      return;
    }
    const meta = getYoutubeVideoMeta();
    const lines = [
      `平台：YouTube`,
      meta.title ? `标题：${meta.title}` : null,
      meta.translatedTitle ? `标题译文：${meta.translatedTitle}` : null,
      meta.author ? `作者：${meta.author}` : null,
      meta.publishDate ? `时间：${meta.publishDate}` : null,
      meta.url ? `链接：${meta.url}` : null,
      '',
      translations
    ].filter((line) => line !== null).join('\n');
    navigator.clipboard.writeText(lines).then(() => {
      copyButton.textContent = '✓';
      copyButton.classList.add('xt-copied');
      setTimeout(() => {
        copyButton.textContent = '⎘';
        copyButton.classList.remove('xt-copied');
      }, 1500);
    });
  });
  header.appendChild(copyButton);

  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'xt-transcript-collapse';
  collapseButton.textContent = '›';
  collapseButton.title = '折叠字幕稿';
  collapseButton.addEventListener('click', () => {
    transcriptCollapsed = true;
    renderTranscriptPanel();
  });
  header.appendChild(collapseButton);

  const list = document.createElement('div');
  list.id = TRANSCRIPT_LIST_ID;

  panel.appendChild(header);
  panel.appendChild(list);
  document.documentElement.appendChild(panel);
  return panel;
}

function getOrCreateTranscriptToggle() {
  let toggle = document.getElementById(TRANSCRIPT_TOGGLE_ID);
  if (toggle) {
    return toggle;
  }

  toggle = document.createElement('button');
  toggle.id = TRANSCRIPT_TOGGLE_ID;
  toggle.type = 'button';
  toggle.textContent = '字幕稿';
  toggle.addEventListener('click', () => {
    transcriptCollapsed = false;
    renderTranscriptPanel();
  });
  document.documentElement.appendChild(toggle);
  return toggle;
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
    activeRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

  updateTranscriptProgress();
}

function handleYoutubeNavigation() {
  activeTranscriptUrl = '';
  transcriptItems = [];
  transcriptStatusText = '';
  transcriptTranslationRunId += 1;
  currentTranscriptKey = '';
  transcriptCollapsed = false;
  if (isYoutubeWatchPage()) {
    renderTranscriptPanel();
  } else {
    hideTranscriptPanel();
  }
}

function hideTranscriptPanel() {
  const panel = document.getElementById(TRANSCRIPT_PANEL_ID);
  if (panel) {
    panel.classList.remove('xt-visible');
    panel.classList.remove('xt-collapsed');
  }

  const toggle = document.getElementById(TRANSCRIPT_TOGGLE_ID);
  if (toggle) {
    toggle.classList.remove('xt-visible');
  }
}

function updateTranscriptProgress() {
  const panel = document.getElementById(TRANSCRIPT_PANEL_ID);
  if (!panel) {
    return;
  }

  const total = transcriptItems.length;
  const done = transcriptItems.filter((item) => item.translatedText).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const allDone = total > 0 && done === total;

  const progressBar = panel.querySelector('.xt-transcript-title-progress');
  if (progressBar) {
    progressBar.style.width = allDone ? '0%' : `${pct}%`;
  }

  const copyButton = panel.querySelector('.xt-transcript-copy');
  if (copyButton) {
    copyButton.classList.toggle('xt-ready', allDone);
  }
}

function resetYtWatchPageTitle() {
  for (const el of document.querySelectorAll('yt-formatted-string.ytd-watch-metadata')) {
    el.removeAttribute(YT_TITLE_BOUND_ATTR);
    const next = el.nextElementSibling;
    if (next?.classList.contains('xt-yt-title-zh')) {
      next.remove();
    }
  }
}

function installYtTitleStyle() {
  if (document.getElementById('xt-yt-title-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'xt-yt-title-style';
  style.textContent = `
    .xt-yt-title-zh {
      color: #9bd37a;
      font-size: 14px;
      font-weight: 400;
      line-height: 1.4;
      margin-top: 4px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function observeYtTitles() {
  if (ytTitleObserver || !document.body) {
    if (!document.body) {
      window.setTimeout(observeYtTitles, 200);
    }
    return;
  }

  ytTitleObserver = new MutationObserver((mutations) => {
    if (!settings.enabled) {
      return;
    }
    for (const mutation of mutations) {
      queueYtTitleScan(mutation.target);
      for (const node of mutation.addedNodes) {
        queueYtTitleScan(node);
      }
    }
  });

  ytTitleObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function queueYtTitleScan(root) {
  const el = root?.nodeType === Node.TEXT_NODE ? root.parentElement : root;
  if (!el || (el.nodeType !== Node.ELEMENT_NODE && el.nodeType !== Node.DOCUMENT_NODE)) {
    return;
  }
  ytTitlePendingRoots.add(el.nodeType === Node.DOCUMENT_NODE ? document.body : el);
  window.clearTimeout(ytTitleScanTimer);
  ytTitleScanTimer = window.setTimeout(processYtTitleScans, YT_TITLE_SCAN_DEBOUNCE_MS);
}

function processYtTitleScans() {
  ytTitleScanTimer = 0;
  if (!settings.enabled) {
    ytTitlePendingRoots.clear();
    return;
  }
  const roots = Array.from(ytTitlePendingRoots);
  ytTitlePendingRoots.clear();
  for (const root of roots) {
    scanYtTitles(root);
  }
}

function scanYtTitles(root) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return;
  }

  const nodes = [];
  if (root instanceof Element && root.matches(YT_VIDEO_TITLE_SELECTOR)) {
    nodes.push(root);
  }
  for (const node of root.querySelectorAll(YT_VIDEO_TITLE_SELECTOR)) {
    nodes.push(node);
  }

  for (const node of nodes) {
    if (node.getAttribute(YT_TITLE_BOUND_ATTR) === '1') {
      continue;
    }
    const text = node.textContent?.trim() || '';
    if (!text) {
      continue;
    }
    if (!isVideoTitleContext(node)) {
      continue;
    }
    node.setAttribute(YT_TITLE_BOUND_ATTR, '1');
    if (isYtTitleChinese(text)) {
      continue;
    }
    translateYtTitle(node, text);
  }
}

function isVideoTitleContext(node) {
  const text = node.textContent?.trim() || '';
  if (text.length < 10) {
    return false;
  }
  let el = node.parentElement;
  let depth = 0;
  while (el && depth < 15) {
    const tag = el.tagName?.toLowerCase() || '';
    if (
      tag === 'ytd-masthead' ||
      tag === 'ytd-searchbox' ||
      tag === 'ytd-guide-renderer' ||
      tag === 'ytd-mini-guide-renderer' ||
      tag === 'ytd-guide-entry-renderer' ||
      tag === 'ytd-endscreen-element-renderer' ||
      tag === 'ytd-comment-renderer' ||
      tag === 'ytd-comment-thread-renderer'
    ) {
      return false;
    }
    el = el.parentElement;
    depth++;
  }
  return true;
}

function isYtTitleChinese(text) {
  const value = String(text || '');
  if (/[぀-ヿ]/.test(value)) {
    return false;
  }
  return /[㐀-䶿一-鿿豈-﫿]/.test(value);
}

async function translateYtTitle(node, text) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'translate',
      text,
      targetLanguage: settings.targetLanguage || 'zh-CN'
    });

    if (!response?.ok || !response.translatedText || response.translatedText === text) {
      return;
    }

    // Insert after <h3> (outside anchor/yt-formatted-string) to avoid overflow:hidden clipping
    let anchor = node;
    let el = node.parentElement;
    while (el) {
      const tag = el.tagName?.toLowerCase() || '';
      if (tag === 'h3') {
        anchor = el;
        break;
      }
      if (tag === 'yt-formatted-string') {
        anchor = el;
      }
      if (tag === 'body') break;
      el = el.parentElement;
    }

    const existing = anchor.parentElement?.querySelector('.xt-yt-title-zh');
    if (existing) {
      existing.textContent = response.translatedText;
      return;
    }

    const zh = document.createElement('div');
    zh.className = 'xt-yt-title-zh';
    zh.textContent = response.translatedText;
    anchor.insertAdjacentElement('afterend', zh);
  } catch (_error) {}
}

function getYoutubeVideoMeta() {
  const titleEl =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
    document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string') ||
    null;

  const title =
    titleEl?.textContent?.trim() ||
    document.title?.replace(/\s*-\s*YouTube$/, '').trim() ||
    '';

  const translatedTitle =
    (titleEl?.nextElementSibling?.classList.contains('xt-yt-title-zh')
      ? titleEl.nextElementSibling.textContent?.trim()
      : '') || '';

  const author =
    document.querySelector('ytd-channel-name #channel-name a')?.textContent?.trim() ||
    document.querySelector('#owner #channel-name a')?.textContent?.trim() ||
    document.querySelector('ytd-video-owner-renderer #channel-name a')?.textContent?.trim() ||
    '';

  const publishDate =
    document.querySelector('ytd-watch-metadata #info-strings yt-formatted-string')?.textContent?.trim() ||
    document.querySelector('#info-strings yt-formatted-string')?.textContent?.trim() ||
    '';

  const url = window.location.href;

  return { title, translatedTitle, author, publishDate, url };
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(String(value || ''));
  }

  return String(value || '').replace(/["\\]/g, '\\$&');
}
