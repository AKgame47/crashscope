# CrashScope — AI Accident Detection from Video

Upload dashcam or CCTV footage and let **Google Gemini** detect every accident and
near-miss — with exact timestamps, severity ratings and descriptions. Click any
incident to jump straight to that moment in the video.

**Live site:** https://akgame47.github.io/crashscope/

## How it works

There is **no backend**. The page is static hosting; every request goes from the
visitor's browser straight to Google's Gemini API:

1. Visitor pastes their own free Gemini API key (stored only in their browser's
   local storage, never on any server).
2. They upload a video file or paste a public YouTube link.
3. The browser sends the video to Gemini — inline for clips ≤15 MB, via the
   resumable File API upload for larger files (up to 2 GB), or by YouTube URL.
4. A structured prompt asks Gemini to return every accident / near-miss as JSON:
   timestamps, type, severity, confidence, vehicles, injuries.
5. The page renders a report: summary cards, a clickable incident timeline over
   the video, severity badges, and JSON export.

## Files

- `index.html` — landing page + analyzer UI
- `styles.css` — dark theme
- `app.js` — all logic (upload, File API polling, analysis, rendering, demo mode)
- `favicon.svg` — logo

## Local development

Any static server works, e.g.:

```bash
cd crashscope && python3 -m http.server 8000
```

then open http://localhost:8000. A Gemini API key (free at
https://aistudio.google.com/apikey) is needed for real analyses; the
**Demo** tab works without one.

## Deploy

Push to the `main` branch of this repo — GitHub Pages serves the site from the
repository root.

## Disclaimer

Incident reports are AI-generated and must be verified before being relied upon
for safety, legal or insurance decisions.
