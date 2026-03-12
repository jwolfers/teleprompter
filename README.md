# Teleprompter App

A web-based teleprompter with AI-powered listening mode that tracks your speech and advances automatically.

## Project Status

**In Progress** - Setting up the basic structure.

## Features (Planned)

### Core Teleprompter
- Paste text from Google Docs with full formatting preserved (bold, italic, colors, links)
- Adjustable: font size, font family, text color, background color, screen width, line spacing
- Manual scroll mode with adjustable speed
- Fullscreen mode (no browser chrome)
- PWA support (install as app)

### Listening Mode (AI-Powered)
- Uses **OpenAI GPT-4o-mini-transcribe** for speech-to-text ($0.003/min)
- Uses **Claude 3.5 Sonnet** for semantic matching (understands context, not just words)
- Handles speaker reordering words, tangents, and natural speech patterns
- **Riff detection**: Text in *italics* or after "riff" signals a tangent - teleprompter waits
- **Stage directions**: Text in [square brackets] is not spoken - displayed differently

## Tech Stack

- Plain HTML / CSS / JavaScript (no framework)
- No build step required
- Just open `index.html` in a browser

## Setup Instructions

### 1. Get API Keys

You'll need two API keys:

1. **OpenAI API Key** (for speech-to-text)
   - Go to https://platform.openai.com/api-keys
   - Create a new secret key
   - Copy it

2. **Anthropic API Key** (for semantic matching with Claude)
   - Go to https://console.anthropic.com/
   - Create an API key
   - Copy it

### 2. Configure API Keys

Edit `config.js` and add your keys:

```javascript
const CONFIG = {
    OPENAI_API_KEY: 'sk-your-openai-key-here',
    ANTHROPIC_API_KEY: 'sk-ant-your-anthropic-key-here'
};
```

**Important**: Never commit `config.js` to git (it's in `.gitignore`).

### 3. Run the App

Simply open `index.html` in your browser. That's it!

For best results, use Chrome (best Web Speech API support as fallback).

## File Structure

```
Teleprompter/
├── index.html      # Main app page
├── style.css       # All styling
├── app.js          # Main application logic
├── config.js       # Your API keys (DO NOT COMMIT)
├── config.example.js  # Template for config.js
├── .gitignore      # Ignores config.js
└── README.md       # This file
```

## Architecture Decisions

1. **No framework** - Plain HTML/CSS/JS for simplicity
2. **No build step** - Just open the HTML file
3. **Config file for keys** - Simple, no server needed for local use
4. **OpenAI for speech-to-text** - Best accuracy at $0.003/min (GPT-4o-mini-transcribe)
5. **Claude for semantic matching** - Excellent at understanding context and detecting riffs

## How Listening Mode Works

1. **Speech capture** → Browser microphone access
2. **Transcription** → Audio sent to OpenAI Realtime API → text
3. **Semantic matching** → Recent transcript + full script sent to Claude
4. **Position update** → Claude returns current position + riff status
5. **Scroll** → Teleprompter advances to match (or waits during riffs)

## Resuming Development

If you're coming back to this project with Claude Code:

1. Open the Teleprompter folder in your terminal/IDE
2. Run Claude Code
3. Say: "Let's continue building the teleprompter. Check the README and todo list."

## Current Todo List

- [x] Project planning and architecture
- [ ] Create project structure (HTML, CSS, JS, config)
- [ ] Build rich text editor with paste formatting support
- [ ] Create teleprompter display component
- [ ] Add customization controls
- [ ] Implement manual scroll mode
- [ ] Implement speech-to-text with OpenAI
- [ ] Implement semantic matching with Claude
- [ ] Handle riff/italics detection and bracketed text
- [ ] Add fullscreen mode and PWA support

## Browser Support

- **Chrome** (recommended) - Best microphone and speech API support
- **Edge** - Good support
- **Firefox** - Works, some features may vary
- **Safari** - Works, some features may vary

## App-Like Experience (No Browser Chrome)

To use the teleprompter without browser menus/address bar:

1. Open [index.html](index.html) in Chrome
2. Click the **install icon** (⊕ or computer icon) in the address bar
3. Click "Install"
4. The app opens in its own window with no browser UI

Or manually: Chrome Menu → More Tools → Create Shortcut → Check "Open as window"

This gives you a clean, app-like interface without using fullscreen mode.

## Cost Estimates (Listening Mode)

| Usage | OpenAI (speech-to-text) | Claude (matching) |
|-------|------------------------|-------------------|
| 1 hour | ~$0.18 | ~$0.10-0.30 |
| 10 hours | ~$1.80 | ~$1-3 |

Costs depend on how frequently we poll Claude for position updates (every 3-5 seconds likely).
