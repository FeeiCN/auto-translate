# Chrome Web Store Listing Draft - auto-translate

## Short description

Translate supported content on X, abc.com, and YouTube, with auto-translate, manual translate, and bilingual subtitles.

## Detailed description

auto-translate helps you read supported web content faster by adding in-place translation on X (Twitter) and bilingual subtitles on abc.com and YouTube.

Key features:
- Translate visible tweet text automatically
- Translate a single tweet manually with one click
- Add Chinese translation after each English subtitle line on supported abc.com videos
- Add target-language translation after English auto captions on YouTube
- Skip translation for Chinese tweets
- Hide promoted ad tweets labeled as "Ad"
- Choose target language in popup settings
- Cache translations for faster repeat loads
- Built-in request throttling to improve stability

## Category

Productivity

## Language

English (you can also provide a Chinese listing variant)

## Permissions justification

- `storage`: Save user settings and local translation cache.
- `x.com` / `twitter.com` host permission: Detect tweet text and render translation results.
- `abc.com` / `*.media.dssott.com` host permission: Intercept subtitle requests and rewrite returned subtitle text for bilingual playback.
- YouTube host permission: Intercept English `json3` subtitle requests and rewrite returned subtitle text for bilingual playback.
- Translation API host permission: Send text for translation and receive translated output.

## Privacy practices summary

- Not selling user data
- No account login required
- Data sent only to translation provider for translation
- Local cache retained for up to 7 days

## Store assets checklist

- Extension icon: 128x128 (done)
- Promo tile images (small/marquee): pending
- Screenshots (at least 1): pending
- Privacy policy URL/page: pending (use `PRIVACY.md` content on a public URL)

## Pre-publish checklist

1. Replace MVP translation provider if needed for production SLA.
2. Add support contact email and homepage URL.
3. Publish privacy policy to a public HTTPS URL.
4. Capture screenshots on real X timeline pages.
5. Validate extension behavior in latest Chrome stable.
