(() => {
  const HOOK_SOURCE = 'xt-youtube-subtitle-hook';
  const TIMEDTEXT_XHR_START_TYPE = 'xt-youtube-timedtext-xhr-start';
  const TIMEDTEXT_XHR_COMPLETE_TYPE = 'xt-youtube-timedtext-xhr-complete';

  if (window.__xtYoutubeSubtitleHookInstalled) {
    return;
  }

  window.__xtYoutubeSubtitleHookInstalled = true;

  function shouldObserveTimedtextUrl(url) {
    try {
      const parsedUrl = new URL(String(url || ''), window.location.href);
      if (parsedUrl.hostname !== 'www.youtube.com' && parsedUrl.hostname !== 'youtube.com') {
        return false;
      }

      if (parsedUrl.pathname !== '/api/timedtext') {
        return false;
      }

      const format = parsedUrl.searchParams.get('fmt');
      const language = parsedUrl.searchParams.get('lang');
      return (!format || format === 'json3') && (!language || language === 'en' || language.startsWith('en-'));
    } catch (_error) {
      return false;
    }
  }

  function postTimedtextXhrStart(url) {
    window.postMessage(
      {
        source: HOOK_SOURCE,
        type: TIMEDTEXT_XHR_START_TYPE,
        url: String(url || '')
      },
      '*'
    );
  }

  function postTimedtextXhrComplete({ url, ok, jsonText = '', error = '' }) {
    window.postMessage(
      {
        source: HOOK_SOURCE,
        type: TIMEDTEXT_XHR_COMPLETE_TYPE,
        url: String(url || ''),
        ok: Boolean(ok),
        jsonText: String(jsonText || ''),
        error: String(error || '')
      },
      '*'
    );
  }

  function installTimedtextXhrObserver() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function observedOpen(method, url, async = true, ...rest) {
      this.__xtYoutubeTimedtextUrl =
        String(method || 'GET').toUpperCase() === 'GET' &&
        async !== false &&
        shouldObserveTimedtextUrl(url)
          ? String(url || '')
          : '';

      return originalOpen.call(this, method, url, async, ...rest);
    };

    XMLHttpRequest.prototype.send = function observedSend(...args) {
      const timedtextUrl = this.__xtYoutubeTimedtextUrl || '';
      if (timedtextUrl) {
        postTimedtextXhrStart(timedtextUrl);
        this.addEventListener('loadend', () => {
          try {
            if (this.status < 200 || this.status >= 300) {
              postTimedtextXhrComplete({
                url: timedtextUrl,
                ok: false,
                error: `YouTube subtitle HTTP ${this.status}`
              });
              return;
            }

            const jsonText =
              typeof this.responseText === 'string'
                ? this.responseText
                : typeof this.response === 'string'
                  ? this.response
                  : this.response
                    ? JSON.stringify(this.response)
                    : '';

            postTimedtextXhrComplete({
              url: timedtextUrl,
              ok: Boolean(jsonText.trim()),
              jsonText,
              error: jsonText.trim() ? '' : 'Empty subtitle JSON3 text'
            });
          } catch (error) {
            postTimedtextXhrComplete({
              url: timedtextUrl,
              ok: false,
              error: error && error.message ? error.message : 'Failed to read subtitle JSON3 text'
            });
          }
        }, { once: true });
      }

      return originalSend.apply(this, args);
    };
  }

  installTimedtextXhrObserver();
})();
