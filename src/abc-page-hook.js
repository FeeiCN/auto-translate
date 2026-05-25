(() => {
  const HOOK_SOURCE = 'xt-abc-subtitle-hook';
  const REQUEST_TYPE = 'xt-abc-translate-vtt-request';
  const RESPONSE_TYPE = 'xt-abc-translate-vtt-response';
  const SUBTITLE_URL_PATTERN = /^https:\/\/[^?#]+\.media\.dssott\.com\/.+\.vtt(?:[?#].*)?$/i;
  const TRANSLATION_TIMEOUT_MS = 30000;
  const xhrShadowStateMap = new WeakMap();
  let requestSequence = 0;

  if (window.__xtAbcSubtitleHookInstalled) {
    return;
  }

  window.__xtAbcSubtitleHookInstalled = true;
  const originalFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  const pendingTranslationRequests = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) {
      return;
    }

    const { source, type, requestId, ok, vttText, error } = event.data;
    if (source !== HOOK_SOURCE || type !== RESPONSE_TYPE || !requestId) {
      return;
    }

    const pending = pendingTranslationRequests.get(requestId);
    if (!pending) {
      return;
    }

    pendingTranslationRequests.delete(requestId);
    window.clearTimeout(pending.timeoutId);

    if (!ok) {
      pending.reject(new Error(error || 'Subtitle translation failed'));
      return;
    }

    pending.resolve(typeof vttText === 'string' ? vttText : '');
  });

  function shouldInterceptSubtitleUrl(url) {
    return SUBTITLE_URL_PATTERN.test(String(url || '').trim());
  }

  function requestTranslatedVtt({ url, vttText }) {
    const normalizedText = String(vttText || '');
    if (!normalizedText.trim()) {
      return Promise.resolve(normalizedText);
    }

    const requestId = `xt-abc-vtt-${Date.now()}-${requestSequence++}`;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingTranslationRequests.delete(requestId);
        reject(new Error('Subtitle translation timed out'));
      }, TRANSLATION_TIMEOUT_MS);

      pendingTranslationRequests.set(requestId, {
        resolve,
        reject,
        timeoutId
      });

      window.postMessage(
        {
          source: HOOK_SOURCE,
          type: REQUEST_TYPE,
          requestId,
          url: String(url || ''),
          vttText: normalizedText
        },
        '*'
      );
    });
  }

  async function buildTranslatedFetchResponse(response, requestUrl) {
    if (!response || !response.ok) {
      return response;
    }

    const originalText = await response.clone().text();
    if (!originalText.trim()) {
      return response;
    }

    let translatedText = originalText;
    try {
      translatedText = await requestTranslatedVtt({
        url: requestUrl,
        vttText: originalText
      });
    } catch (_error) {
      translatedText = originalText;
    }

    if (!translatedText || translatedText === originalText) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/vtt; charset=utf-8');
    headers.delete('content-length');
    headers.delete('content-encoding');

    return new Response(translatedText, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  function installFetchPatch() {
    if (typeof originalFetch !== 'function') {
      return;
    }

    window.fetch = async function patchedFetch(...args) {
      const requestUrl =
        typeof args[0] === 'string'
          ? args[0]
          : args[0] && typeof args[0].url === 'string'
            ? args[0].url
            : '';

      if (!shouldInterceptSubtitleUrl(requestUrl)) {
        return originalFetch.apply(this, args);
      }

      const response = await originalFetch.apply(this, args);
      return buildTranslatedFetchResponse(response, requestUrl);
    };
  }

  function installXhrPatch() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, async = true, ...rest) {
      this.__xtSubtitleMeta = {
        method: String(method || 'GET').toUpperCase(),
        url: String(url || ''),
        async: async !== false,
        requestHeaders: []
      };

      this.__xtInterceptSubtitleXhr =
        this.__xtSubtitleMeta.method === 'GET' &&
        this.__xtSubtitleMeta.async &&
        shouldInterceptSubtitleUrl(this.__xtSubtitleMeta.url);

      if (this.__xtInterceptSubtitleXhr) {
        installShadowAccessors(this);
      }

      return originalOpen.call(this, method, url, async, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      if (this.__xtInterceptSubtitleXhr && this.__xtSubtitleMeta) {
        this.__xtSubtitleMeta.requestHeaders.push([String(name || ''), String(value || '')]);
      }

      return originalSetRequestHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      if (!this.__xtInterceptSubtitleXhr || !this.__xtSubtitleMeta) {
        return originalSend.apply(this, arguments);
      }

      void fulfillPatchedXhrRequest(this, this.__xtSubtitleMeta, body);
      return;
    };
  }

  function installShadowAccessors(xhr) {
    if (xhrShadowStateMap.has(xhr)) {
      const state = xhrShadowStateMap.get(xhr);
      state.readyState = 1;
      state.status = 0;
      state.statusText = '';
      state.responseURL = '';
      state.responseHeaders = new Map();
      state.responseHeadersText = '';
      state.responseText = '';
      state.responseValue = '';
      state.error = null;
      return;
    }

    const state = {
      readyState: 1,
      status: 0,
      statusText: '',
      responseURL: '',
      responseHeaders: new Map(),
      responseHeadersText: '',
      responseText: '',
      responseValue: '',
      error: null
    };
    xhrShadowStateMap.set(xhr, state);

    Object.defineProperties(xhr, {
      readyState: {
        configurable: true,
        get() {
          return xhrShadowStateMap.get(xhr)?.readyState || 0;
        }
      },
      status: {
        configurable: true,
        get() {
          return xhrShadowStateMap.get(xhr)?.status || 0;
        }
      },
      statusText: {
        configurable: true,
        get() {
          return xhrShadowStateMap.get(xhr)?.statusText || '';
        }
      },
      responseURL: {
        configurable: true,
        get() {
          return xhrShadowStateMap.get(xhr)?.responseURL || '';
        }
      },
      responseText: {
        configurable: true,
        get() {
          return xhrShadowStateMap.get(xhr)?.responseText || '';
        }
      },
      response: {
        configurable: true,
        get() {
          const currentState = xhrShadowStateMap.get(xhr);
          if (!currentState) {
            return '';
          }

          return currentState.responseValue;
        }
      }
    });

    xhr.getAllResponseHeaders = function getAllResponseHeaders() {
      return xhrShadowStateMap.get(xhr)?.responseHeadersText || '';
    };

    xhr.getResponseHeader = function getResponseHeader(name) {
      if (!name) {
        return null;
      }

      const headerName = String(name).toLowerCase();
      const currentState = xhrShadowStateMap.get(xhr);
      if (!currentState || !currentState.responseHeaders.has(headerName)) {
        return null;
      }

      return currentState.responseHeaders.get(headerName);
    };
  }

  async function fulfillPatchedXhrRequest(xhr, meta, body) {
    const state = xhrShadowStateMap.get(xhr);
    if (!state) {
      return;
    }

    try {
      const headers = new Headers();
      for (const [name, value] of meta.requestHeaders) {
        headers.append(name, value);
      }

      if (typeof originalFetch !== 'function') {
        throw new Error('Fetch API unavailable');
      }

      const response = await originalFetch(meta.url, {
        method: meta.method,
        headers,
        body: body == null ? undefined : body,
        credentials: xhr.withCredentials ? 'include' : 'same-origin'
      });

      const originalText = await response.text();
      let translatedText = originalText;

      try {
        translatedText = await requestTranslatedVtt({
          url: meta.url,
          vttText: originalText
        });
      } catch (_error) {
        translatedText = originalText;
      }

      state.status = response.status;
      state.statusText = response.statusText;
      state.responseURL = response.url || meta.url;
      state.responseHeaders = buildHeaderMap(response.headers, {
        'content-type': 'text/vtt; charset=utf-8'
      });
      state.responseHeadersText = buildHeaderText(state.responseHeaders);

      state.readyState = 2;
      emitXhrEvent(xhr, 'readystatechange');

      state.readyState = 3;
      state.responseText = translatedText;
      state.responseValue = buildXhrResponseValue(translatedText, xhr.responseType);
      emitXhrEvent(xhr, 'readystatechange');
      emitXhrEvent(xhr, 'progress');

      state.readyState = 4;
      emitXhrEvent(xhr, 'readystatechange');
      emitXhrEvent(xhr, 'load');
      emitXhrEvent(xhr, 'loadend');
    } catch (error) {
      state.error = error;
      state.readyState = 4;
      state.status = 0;
      state.statusText = '';
      state.responseText = '';
      state.responseValue = buildXhrResponseValue('', xhr.responseType);
      emitXhrEvent(xhr, 'readystatechange');
      emitXhrEvent(xhr, 'error');
      emitXhrEvent(xhr, 'loadend');
    }
  }

  function buildHeaderMap(headers, overrides) {
    const map = new Map();
    headers.forEach((value, key) => {
      const normalizedKey = String(key || '').toLowerCase();
      if (normalizedKey === 'content-length' || normalizedKey === 'content-encoding') {
        return;
      }

      map.set(normalizedKey, String(value || ''));
    });

    for (const [key, value] of Object.entries(overrides || {})) {
      map.set(String(key || '').toLowerCase(), String(value || ''));
    }

    return map;
  }

  function buildHeaderText(headerMap) {
    const lines = [];
    for (const [key, value] of headerMap.entries()) {
      lines.push(`${key}: ${value}`);
    }

    return lines.join('\r\n');
  }

  function buildXhrResponseValue(text, responseType) {
    if (responseType === 'arraybuffer') {
      return new TextEncoder().encode(String(text || '')).buffer;
    }

    if (responseType === 'blob') {
      return new Blob([String(text || '')], {
        type: 'text/vtt; charset=utf-8'
      });
    }

    return String(text || '');
  }

  function emitXhrEvent(xhr, type) {
    const event = new Event(type);
    xhr.dispatchEvent(event);
  }

  installFetchPatch();
  installXhrPatch();
})();
