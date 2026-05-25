# Privacy Policy - auto-translate

Effective date: March 7, 2026

## What this extension does

auto-translate translates supported page content for the user, including tweet text on `x.com` / `twitter.com` and subtitle text on supported `abc.com` videos.

## Data we process

- Tweet text and subtitle text selected for translation
- Extension settings stored in Chrome storage (`enabled`, `autoTranslate`, `targetLanguage`)
- Translation cache entries stored locally in Chrome storage (`chrome.storage.local`)

## How data is used

- Tweet text and subtitle text are sent to the configured translation providers only for translation.
- Settings are used to control extension behavior.
- Cache is used to reduce repeated translation requests and improve speed.

## Data sharing

- We do not sell personal data.
- Tweet text and subtitle text are sent to translation providers strictly to return translated text.

## Data retention

- Local translation cache expires automatically after 7 days.
- Users can clear extension data via Chrome extension settings.

## Permissions

- `storage`: save settings and translation cache.
- Host access to `x.com` / `twitter.com`: read tweet text and render translation UI.
- Host access to `abc.com` / `*.media.dssott.com`: intercept subtitle requests and return bilingual subtitle text for playback.
- Host access to translation API domains: send translation requests.

## Security

- This MVP does not include account login or server-side user profile storage.
- Future versions may change providers and data handling; this policy should be updated accordingly.

## Contact

For support/privacy questions, provide a project contact email before store submission.
