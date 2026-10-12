# Melt Timer — files

A calm focus timer: a candle burns down or an ice cube melts as your session runs.

## Folder

```
melt-timer/
├── index.html              page markup
├── styles.css              all styling
├── app.js                  timer, drawing, sound synthesis, settings
├── sw.js                   service worker (offline use, installable app)
├── manifest.webmanifest    app name, colours, icons, store screenshots
├── icons/
│   ├── favicon.svg         browser tab icon (scales to any size)
│   ├── favicon-32.png
│   ├── apple-touch-icon.png  180×180, iPhone/iPad home screen
│   ├── icon-192.png
│   ├── icon-512.png
│   └── icon-maskable-512.png  Android adaptive icon (content kept in the safe zone)
├── images/
│   ├── og-image.png        1200×630 link-preview image
│   ├── renders/            1200×1200, candle-00 … candle-done, ice-00 … ice-done
│   └── screenshots/        desktop (2880×1800) and mobile (1170×2532), both modes
└── sounds/
    ├── ambient-*.wav       6 seamless 30-second loops
    └── chime-*.wav         session-end and break-end chimes
```

`melt-timer-single-file.html` (next to this folder in the zip) is the same app in one file.

## Running it

- **Quick look:** open `index.html` in a browser. Everything works except offline mode and installing.
- **Full experience:** put the `melt-timer` folder on any static web host that serves HTTPS. Served that way,
  the app works offline, phones offer "Add to Home Screen" / "Install", and the screen stays awake during
  sessions (browsers only allow that on secure pages).
- For link previews on social sites, change the `og:image` line in `index.html` to your full URL,
  e.g. `https://example.com/melt-timer/images/og-image.png`.
- After editing any file, change `CACHE` in `sw.js` (e.g. `melt-timer-v2`) so returning visitors get the update.

## Sounds

The app still generates all of its sound live in code; it does not load these WAV files. They are exports of the
same synthesis for use elsewhere — videos, other apps, or a playlist.

- 44.1 kHz, 16-bit, stereo.
- Ambient files loop seamlessly; set your player to repeat.
- Levels are matched by loudness, so they sit together when mixed. The candle crackle is intentionally soft.
