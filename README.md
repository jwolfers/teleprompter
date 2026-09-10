# Teleprompter

A teleprompter that scrolls your script up the screen at a pace you control, so you can keep
your eyes up while you speak. It runs entirely on your own machine — your script and settings
stay local, and the only network access is fetching a Google Doc you explicitly link.

Runs as a desktop app (Windows/macOS), or straight from `index.html` in a browser.

## Features

### Getting a script in
- **Paste** directly into the prompter area. Blank paragraphs are stripped; you can edit in
  place whenever playback is paused.
- **Import a Google Doc** and stay linked to it — the prompter re-checks the doc every 10
  seconds and picks up your edits mid-read, holding your place at the guide line. It leaves
  the script alone when nothing has actually changed, so an untouched doc never causes a jump.
- **Multi-tab docs** read their first tab and list the others so you can switch with one click.
- Imported docs keep their structure: **bold**, italic, underline, headings, bullets,
  numbering, indents, block quotes, tables, links, and images/charts.

### Reading
- Speed set in **words per minute**, converted to a scroll rate from how densely the current
  script lays out on screen — so font size, spacing and width changes hold the same pace.
- A blue **guide line** marks the line to read; text above it dims as already-read.
- Bottom bar shows elapsed time, time remaining, and the **clock time you'll finish** at the
  current speed. Handy for hitting an exact slot: nudge the speed until the finish time matches.
- 3-2-1 countdown on play. Mouse wheel or touch-drag scrubs anywhere in the script.

### Script conventions
- *Italics* become highlighted **riff sections** — points to improvise around rather than read
  word-for-word.
- `[Bracketed text]` becomes a dimmed **stage direction** that isn't meant to be spoken.

### Display
- Font, size, line spacing, column width, and text/background colours, with a ☀️/🌙 button to
  swap between dark and light schemes. Settings are remembered between sessions.
- **Mirror** flips the text horizontally for beam-splitter rigs.
- **Fullscreen** hides everything but the script.
- In the desktop app the window is frameless, always-on-top, and has an **opacity** slider so it
  can float see-through over other apps.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| <kbd>Space</kbd> | Play / pause |
| <kbd>↑</kbd> <kbd>↓</kbd> | Speed up / slow down |
| <kbd>←</kbd> <kbd>→</kbd> | Jump back / forward |
| <kbd>,</kbd> <kbd>.</kbd> | Nudge back / forward one line |
| <kbd>[</kbd> <kbd>]</kbd> | Window opacity down / up |
| <kbd>F</kbd> | Fullscreen |
| <kbd>M</kbd> | Mirror |
| <kbd>R</kbd> | Reset to top |
| <kbd>?</kbd> | Quick shortcut overlay |

Full instructions and an FAQ are in the app itself — the **?** button, top right.

## Running it

No API keys, no accounts, no build step for the web version.

**Browser:** open `index.html`. Chrome or Edge recommended.

**Desktop app (from source):**

```
npm install
npm start
```

On Windows, `Start Teleprompter.bat` does both of those for you, installing Node.js first if
it isn't present.

**Prebuilt executable:** `Teleprompter.exe` in the repo root is a portable Windows build — copy
it anywhere and run it, no install required. (It's gitignored; build your own with the commands
below.)

## Building

```
npm run build:win     # portable Teleprompter.exe -> dist/
npm run build:mac     # Teleprompter.dmg -> dist/
npm run build         # both
npm run icons         # regenerate icon PNGs from the SVG
```

## Google Docs notes

The doc must be shared as **"Anyone with the link can view"** — the app reads the doc's public
web export directly rather than signing in to your Google account, so nothing is uploaded and
no one can edit your doc through the link.

Google's HTML export puts nearly all formatting in generated CSS class names and re-signs image
URLs on every request, so the importer resolves the export's stylesheet before reading the
markup, and compares a fingerprint of words and structure (not raw HTML) to decide whether
anything really changed.

Listing a doc's tabs officially requires OAuth, which this app deliberately avoids. Instead it
reads the tab tree out of the doc's own editor page, where Google ships it in `DOCS_modelChunk`:
a `mkch` chunk names the first tab, and one `ac` chunk per tab after it carries that tab's id and
name. That is the only place a tab's *name* exists — the HTML export contains content and nothing
else — and the chunks are already in tab order. If that can't be read, it falls back to scraping
candidate tab ids and confirming each by exporting it, which still works but can only label tabs
by their opening line.

Worth knowing: exporting **without** a `tab` parameter returns every tab concatenated, not the
first tab. So once tabs are known the app always names one explicitly.

## File structure

```
Teleprompter/
├── index.html          # Whole UI: prompter, side panel, modals
├── app.js              # All application logic
├── style.css           # All styling
├── main.js             # Electron main process (frameless, always-on-top window)
├── manifest.json       # PWA manifest
├── package.json        # Scripts and electron-builder config
├── Start Teleprompter.bat   # Windows launcher (installs Node if needed)
├── tools/              # Icon generation
└── icon*.png, *.ico, favicon.svg
```

`config.js` / `config.example.js` are leftovers from an earlier plan for AI features and are not
loaded by the app.

## Architecture decisions

1. **No framework, no build step** — plain HTML/CSS/JS; the browser version is just a file you open.
2. **The prompter *is* the editor** — one `contenteditable` area, rather than a separate edit view.
3. **Public web export instead of the Google Docs API** — avoids OAuth entirely, at the cost of
   needing link sharing and some scraping for tabs.
4. **Speed in words per minute** rather than pixels per second, so the setting means the same
   thing across fonts and layouts.
5. **Sentence anchoring on sync** — when a linked doc updates mid-read, the sentence at the
   guide line stays put rather than the pixel offset.

## Not implemented

An AI "listening mode" (speech-to-text plus semantic matching to auto-advance the script) was
part of the original plan and is described in early commits, but none of it is in the code. The
riff/stage-direction conventions above are the surviving pieces of that design.
