// ===== STATE =====
const state = {
    mode: 'scroll',         // 'scroll' or 'listen'
    playing: false,
    speed: 30,              // pixels per second
    scrollPosition: 0,
    mirrored: false,
    animationFrame: null,
    lastTimestamp: null,

    // Script versions
    originalScript: '',     // Original pasted content
    editedScript: '',       // Current working version with all edits

    // Listen mode
    listening: false,
    speechEngine: 'openai', // 'webspeech', 'openai', 'openai-full'
    recognition: null,       // Web Speech API recognition object
    openaiWs: null,          // OpenAI WebSocket
    audioContext: null,
    audioWorklet: null,
    mediaStream: null,
    audioProcessor: null,    // ScriptProcessorNode reference for cleanup
    transcript: '',
    interimTranscript: '',   // Current in-progress speech (deltas)
    currentParagraphIndex: 0,
    paragraphs: [],
    riffing: false,
    listenStartTime: null,
    listenCost: 0,
    costTickerInterval: null, // Track cost ticker to prevent stacking
    reconnectAttempts: 0,     // Track reconnection attempts for backoff
    maxReconnectAttempts: 10, // Cap reconnection attempts

    // Adaptive scroll (listen mode)
    listenScrollSpeed: 0,    // Current adaptive px/sec
    baseListenSpeed: 0,      // Estimated speaking-pace px/sec
    targetScrollPosition: 0, // Where speech matching says we should be
    scriptIndex: null,       // {wordMap, bigramIndex} for continuous position matching
    wasRiffing: false,       // Track riff→resume transitions for wider jumps

    // Adaptive pace learning
    recentWordTimestamps: [], // {time, wordCount} entries for measuring actual wps
    measuredWps: 2.5,        // Measured words-per-second, starts at estimate

    // Timer
    prompterStartTime: null,
    timerInterval: null,

    // Remote control
    broadcastChannel: null,
};

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const editView = $('#edit-view');
const prompterView = $('#prompter-view');
const editor = $('#editor');
const prompterContent = $('#prompter-content');
const prompterContainer = $('#prompter-container');

// Controls
const ctrlFont = $('#ctrl-font');
const ctrlFontSize = $('#ctrl-font-size');
const ctrlWidth = $('#ctrl-width');
const ctrlLineHeight = $('#ctrl-line-height');
const ctrlTextColor = $('#ctrl-text-color');
const ctrlBgColor = $('#ctrl-bg-color');
const ctrlSpeed = $('#ctrl-speed');
const ctrlMode = $('#ctrl-mode');
const ctrlSpeechEngine = $('#ctrl-speech-engine');

// Buttons
const btnStart = $('#btn-start');
const btnBack = $('#btn-back');
const btnPlayPause = $('#btn-play-pause');
const btnReset = $('#btn-reset');
const btnFullscreen = $('#btn-fullscreen');
const btnMirror = $('#btn-mirror');
const btnClear = $('#btn-clear');

// Spinner inputs (number inputs next to sliders)
const fontSizeVal = $('#font-size-val');
const widthVal = $('#width-val');
const lineHeightVal = $('#line-height-val');
const speedVal = $('#speed-val');

// Listen mode
const listenStatus = $('#listen-status');
const listenText = $('#listen-text');
const listenCost = $('#listen-cost');
const speechEngineGroup = $('#speech-engine-group');
const modeScrollLabel = $('#mode-scroll-label');
const modeListenLabel = $('#mode-listen-label');

// New UI elements
const progressFill = $('#progress-fill');
const timerDisplay = $('#timer-display');
const countdownOverlay = $('#countdown-overlay');
const keyboardHints = $('#keyboard-hints');


// ===== EDITOR =====

editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');

    if (html) {
        const cleaned = cleanGoogleDocsHtml(html);
        document.execCommand('insertHTML', false, cleaned);
    } else {
        document.execCommand('insertText', false, text);
    }

    // After paste, adjust editor background to ensure text is visible
    requestAnimationFrame(() => {
        adjustEditorBackground();
        // Store original script on first paste (if empty before)
        if (!state.originalScript) {
            state.originalScript = editor.innerHTML;
        }
        // Update edited script
        state.editedScript = editor.innerHTML;
    });
});

editor.addEventListener('focus', () => {
    if (editor.textContent.trim() === 'Paste your script here...') {
        editor.innerHTML = '<p><br></p>';
    }
});

// Track edits in the editor
editor.addEventListener('input', () => {
    state.editedScript = editor.innerHTML;
});

function cleanGoogleDocsHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;

    body.querySelectorAll('*').forEach(el => {
        el.removeAttribute('class');
        el.removeAttribute('id');

        if (el.style) {
            const keepStyles = {};
            const relevant = ['font-weight', 'font-style', 'text-decoration',
                'color', 'background-color', 'font-size', 'text-align'];
            relevant.forEach(prop => {
                const val = el.style.getPropertyValue(prop);
                if (val) keepStyles[prop] = val;
            });
            el.removeAttribute('style');
            Object.entries(keepStyles).forEach(([prop, val]) => {
                el.style.setProperty(prop, val);
            });
        }
    });

    body.querySelectorAll('span').forEach(span => {
        if (!span.style.cssText && !span.hasChildNodes()) {
            span.remove();
        } else if (!span.style.cssText) {
            span.replaceWith(...span.childNodes);
        }
    });

    return body.innerHTML;
}

// Scan pasted text colors and pick a background that makes them visible
function adjustEditorBackground() {
    const elements = editor.querySelectorAll('*');
    let darkCount = 0;
    let lightCount = 0;

    // Check explicit color styles on elements
    elements.forEach(el => {
        const color = el.style.color;
        if (color) {
            const brightness = getColorBrightness(color);
            if (brightness !== null) {
                if (brightness < 128) darkCount++;
                else lightCount++;
            }
        }
    });

    // Also check unstyled text (inherits default color — typically black from Google Docs)
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (parent && !parent.style.color && walker.currentNode.textContent.trim()) {
            // No explicit color = default (black in Google Docs)
            darkCount++;
        }
    }

    // If most text is dark, use light background; if most is light, use dark background
    if (darkCount >= lightCount) {
        editor.classList.remove('dark-bg');
    } else {
        editor.classList.add('dark-bg');
    }
}

// Parse a CSS color string and return its brightness (0-255)
function getColorBrightness(colorStr) {
    // Handle rgb(r, g, b) format
    const rgbMatch = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
        const r = parseInt(rgbMatch[1]);
        const g = parseInt(rgbMatch[2]);
        const b = parseInt(rgbMatch[3]);
        return (r * 299 + g * 587 + b * 114) / 1000;
    }

    // Handle hex format
    const hexMatch = colorStr.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (hexMatch) {
        let hex = hexMatch[1];
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return (r * 299 + g * 587 + b * 114) / 1000;
    }

    // Named colors we commonly see
    const namedColors = {
        black: 0, white: 255, red: 76, blue: 29, green: 150,
        yellow: 226, gray: 128, grey: 128,
    };
    const lower = colorStr.toLowerCase().trim();
    if (lower in namedColors) return namedColors[lower];

    return null;
}


// ===== PROMPTER =====

function startPrompter() {
    const content = state.editedScript || editor.innerHTML;
    if (!content || editor.textContent.trim() === '' ||
        editor.textContent.trim() === 'Paste your script here...') {
        return;
    }

    // Store edited script if not already set
    if (!state.editedScript) {
        state.editedScript = content;
    }

    prompterContent.innerHTML = processContentForDisplay(content);
    state.paragraphs = parseParagraphs();
    applySettings();

    state.scrollPosition = 0;
    state.currentParagraphIndex = 0;
    state.transcript = '';
    state.riffing = false;

    // Make prompter content editable when paused
    prompterContent.setAttribute('contenteditable', 'true');
    prompterContent.setAttribute('spellcheck', 'false');

    editView.classList.add('hidden');
    prompterView.classList.remove('hidden');

    // Set initial position after view is rendered
    // Position so first line is visible at the bottom (70% from top)
    requestAnimationFrame(() => {
        const containerHeight = prompterContainer.offsetHeight;
        prompterContent.style.top = (containerHeight * 0.7) + 'px';
    });
}

function processContentForDisplay(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;

    // Process bracketed text [like this] -> stage directions
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach(node => {
        const text = node.textContent;
        if (text.includes('[') && text.includes(']')) {
            const fragment = document.createDocumentFragment();
            const parts = text.split(/(\[[^\]]*\])/g);
            parts.forEach(part => {
                if (part.startsWith('[') && part.endsWith(']')) {
                    const span = document.createElement('span');
                    span.className = 'stage-direction';
                    span.textContent = part;
                    span.setAttribute('data-stage-direction', 'true');
                    fragment.appendChild(span);
                } else {
                    fragment.appendChild(document.createTextNode(part));
                }
            });
            node.replaceWith(fragment);
        }
    });

    // Mark italic sections and "riff:" sections
    body.querySelectorAll('i, em, [style*="font-style: italic"]').forEach(el => {
        el.classList.add('riff-section');
        el.setAttribute('data-riff', 'true');
    });

    // Strip color/background/font-size from all elements (use prompter's default styling)
    body.querySelectorAll('*').forEach(el => {
        if (el.style) {
            el.style.removeProperty('color');
            el.style.removeProperty('background-color');
            el.style.removeProperty('background');
            el.style.removeProperty('font-size');
        }
    });

    // Add paragraph markers for position tracking
    let paraIndex = 0;
    body.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li').forEach(el => {
        if (el.textContent.trim()) {
            el.setAttribute('data-para-index', paraIndex++);
        }
    });

    return body.innerHTML;
}

function parseParagraphs() {
    const elements = prompterContent.querySelectorAll('[data-para-index]');
    return Array.from(elements).map(el => ({
        index: parseInt(el.getAttribute('data-para-index')),
        text: el.textContent.trim(),
        element: el,
        isRiff: el.querySelector('[data-riff]') !== null || el.hasAttribute('data-riff'),
        isStageDirection: el.querySelector('[data-stage-direction]') !== null,
        offsetTop: el.offsetTop,
    }));
}

function backToEditor() {
    stopScrolling();
    stopListening();

    // Sync prompter edits back to editor
    const cleanedContent = reverseProcessContent(prompterContent.innerHTML);
    state.editedScript = cleanedContent;
    editor.innerHTML = cleanedContent;

    prompterView.classList.add('hidden');
    editView.classList.remove('hidden');
}

// Reverse the processing done in processContentForDisplay
function reverseProcessContent(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;

    body.querySelectorAll('.stage-direction').forEach(span => {
        span.replaceWith(span.textContent);
    });

    body.querySelectorAll('.riff-section').forEach(el => {
        el.classList.remove('riff-section');
        el.removeAttribute('data-riff');
    });

    body.querySelectorAll('.current-position').forEach(el => {
        el.classList.remove('current-position');
    });

    body.querySelectorAll('[data-para-index]').forEach(el => {
        el.removeAttribute('data-para-index');
    });

    body.querySelectorAll('[data-stage-direction]').forEach(el => {
        el.removeAttribute('data-stage-direction');
    });

    return body.innerHTML;
}


// ===== SETTINGS =====

function applySettings() {
    prompterContent.style.fontFamily = ctrlFont.value;
    prompterContent.style.fontSize = ctrlFontSize.value + 'px';
    prompterContent.style.width = ctrlWidth.value + '%';
    prompterContent.style.lineHeight = (ctrlLineHeight.value / 100).toFixed(1);
    prompterContent.style.color = ctrlTextColor.value;
    prompterContainer.style.background = ctrlBgColor.value;
    state.speed = parseInt(ctrlSpeed.value);
}

ctrlFont.addEventListener('change', applySettings);

// Font size: slider <-> spinner sync
ctrlFontSize.addEventListener('input', () => {
    fontSizeVal.value = ctrlFontSize.value;
    applySettings();
});
fontSizeVal.addEventListener('input', () => {
    ctrlFontSize.value = fontSizeVal.value;
    applySettings();
});

// Width: slider <-> spinner sync
ctrlWidth.addEventListener('input', () => {
    widthVal.value = ctrlWidth.value;
    applySettings();
});
widthVal.addEventListener('input', () => {
    ctrlWidth.value = widthVal.value;
    applySettings();
});

// Line height: slider <-> spinner sync
ctrlLineHeight.addEventListener('input', () => {
    lineHeightVal.value = ctrlLineHeight.value;
    applySettings();
});
lineHeightVal.addEventListener('input', () => {
    ctrlLineHeight.value = lineHeightVal.value;
    applySettings();
});

// Speed: slider <-> spinner sync
ctrlSpeed.addEventListener('input', () => {
    speedVal.value = ctrlSpeed.value;
    state.speed = parseInt(ctrlSpeed.value);
});
speedVal.addEventListener('input', () => {
    ctrlSpeed.value = speedVal.value;
    state.speed = parseInt(speedVal.value);
});

ctrlTextColor.addEventListener('input', applySettings);
ctrlBgColor.addEventListener('input', applySettings);


// ===== SCROLL MODE =====

function togglePlayPause() {
    if (state.mode === 'listen') {
        toggleListening();
        return;
    }

    if (state.playing) {
        stopScrolling();
    } else {
        startScrolling();
    }
}

function startScrolling() {
    // Show countdown on first play (scrollPosition near 0)
    if (state.scrollPosition < 10 && !state.playing) {
        showCountdown(() => {
            doStartScrolling();
        });
        return;
    }
    doStartScrolling();
}

function doStartScrolling() {
    state.playing = true;
    state.lastTimestamp = null;
    if (!state.prompterStartTime) state.prompterStartTime = Date.now();
    startTimer();
    btnPlayPause.innerHTML = '&#9646;&#9646; Pause';
    // Disable editing while scrolling
    prompterContent.setAttribute('contenteditable', 'false');
    state.animationFrame = requestAnimationFrame(animate);
}

function stopScrolling() {
    state.playing = false;
    stopTimer();
    btnPlayPause.innerHTML = '&#9654; Play';
    // Enable editing when paused
    prompterContent.setAttribute('contenteditable', 'true');
    if (state.animationFrame) {
        cancelAnimationFrame(state.animationFrame);
        state.animationFrame = null;
    }
}

function animate(timestamp) {
    if (!state.playing) return;

    if (state.lastTimestamp === null) {
        state.lastTimestamp = timestamp;
        state.animationFrame = requestAnimationFrame(animate);
        return;
    }

    const delta = (timestamp - state.lastTimestamp) / 1000;
    state.lastTimestamp = timestamp;

    state.scrollPosition += state.speed * delta;

    const containerHeight = prompterContainer.offsetHeight;
    const contentHeight = prompterContent.scrollHeight;
    const startPosition = containerHeight * 0.7;
    const maxScroll = startPosition + contentHeight;

    if (state.scrollPosition >= maxScroll) {
        stopScrolling();
        return;
    }

    prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
    updateProgress(state.scrollPosition, maxScroll);

    state.animationFrame = requestAnimationFrame(animate);
}

// Listen mode animation: continuous scroll at adaptive speaking pace
function animateListen(timestamp) {
    if (!state.listening || !state.playing) return;

    if (state.lastTimestamp === null) {
        state.lastTimestamp = timestamp;
        state.animationFrame = requestAnimationFrame(animateListen);
        return;
    }

    const delta = (timestamp - state.lastTimestamp) / 1000;
    state.lastTimestamp = timestamp;

    // Scroll at adaptive speed (adjusted by speech matching)
    state.scrollPosition += state.listenScrollSpeed * delta;

    const containerHeight = prompterContainer.offsetHeight;
    const contentHeight = prompterContent.scrollHeight;
    const startPosition = containerHeight * 0.7;
    const maxScroll = startPosition + contentHeight;

    state.scrollPosition = Math.max(0, Math.min(state.scrollPosition, maxScroll));

    prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
    updateProgress(state.scrollPosition, maxScroll);

    // Track which paragraph is at the guide line (30% from top)
    // so n-gram search window stays centered on visible content
    const guidePx = state.scrollPosition - (containerHeight * 0.7) + (containerHeight * 0.3);
    for (let i = state.paragraphs.length - 1; i >= 0; i--) {
        const p = state.paragraphs[i];
        if (p.element && p.element.offsetTop <= guidePx) {
            if (i > state.currentParagraphIndex) {
                state.currentParagraphIndex = i;

                // Auto-pause when scroll reaches a riff paragraph
                if (p.isRiff && !state.riffing) {
                    state.riffing = true;
                    state.listenScrollSpeed = 0;
                    listenText.textContent = 'Riffing... (paused)';
                    console.log('[Listen Mode] Hit riff paragraph', i, '— pausing');
                }

                // Auto-skip pure stage directions (speed up briefly)
                const isPureStageDir = p.isStageDirection &&
                    !p.text.replace(/\[.*?\]/g, '').trim();
                if (isPureStageDir && !state.riffing) {
                    state.listenScrollSpeed = state.baseListenSpeed * 2;
                }
            }
            break;
        }
    }

    state.animationFrame = requestAnimationFrame(animateListen);
}

function resetScroll() {
    stopScrolling();
    state.scrollPosition = 0;
    state.prompterStartTime = null;
    timerDisplay.textContent = '';
    updateProgress(0, 1);
    const containerHeight = prompterContainer.offsetHeight;
    prompterContent.style.top = (containerHeight * 0.7) + 'px';
    state.currentParagraphIndex = 0;

    prompterContent.querySelectorAll('.current-position').forEach(el => {
        el.classList.remove('current-position');
    });
}


// ===== MIRROR =====

function toggleMirror() {
    state.mirrored = !state.mirrored;
    prompterContent.classList.toggle('mirrored', state.mirrored);
    btnMirror.style.background = state.mirrored ? '#4a6fa5' : '';
}


// ===== FULLSCREEN =====

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        prompterView.requestFullscreen();
    }
}


// ===== MODE SWITCHING =====

function setMode(mode) {
    state.mode = mode;
    ctrlMode.checked = (mode === 'listen');

    if (mode === 'scroll') {
        modeScrollLabel.classList.add('active');
        modeListenLabel.classList.remove('active');
        stopListening();
        listenStatus.classList.add('hidden');
        speechEngineGroup.classList.add('hidden');
        btnPlayPause.innerHTML = '&#9654; Play';
    } else {
        modeScrollLabel.classList.remove('active');
        modeListenLabel.classList.add('active');
        stopScrolling();
        speechEngineGroup.classList.remove('hidden');
        btnPlayPause.innerHTML = '&#127908; Start Listening';
    }
}

ctrlMode.addEventListener('change', () => {
    setMode(ctrlMode.checked ? 'listen' : 'scroll');
});

ctrlSpeechEngine.addEventListener('change', () => {
    state.speechEngine = ctrlSpeechEngine.value;
});


// ===== LISTEN MODE =====

function toggleListening() {
    if (state.listening) {
        stopListening();
    } else {
        startListening();
    }
}

function startListening() {
    // Show countdown on first listen start
    if (state.scrollPosition < 10) {
        showCountdown(() => doStartListening());
        return;
    }
    doStartListening();
}

function doStartListening() {
    state.listening = true;
    state.transcript = '';
    state.currentParagraphIndex = 0;
    state.riffing = false;
    state.listenStartTime = Date.now();
    state.listenCost = 0;
    state.reconnectAttempts = 0;
    state.recentWordTimestamps = [];
    state.measuredWps = 2.5;
    listenStatus.classList.remove('hidden');
    btnPlayPause.innerHTML = '&#9632; Stop Listening';
    listenText.textContent = 'Starting...';
    listenCost.textContent = '$0.00';

    // Refresh paragraph offsets (may have changed since layout)
    refreshParagraphOffsets();
    buildScriptIndex();

    // Calculate base speaking-pace scroll speed
    // ~150 wpm = 2.5 words/sec; estimate total words from script paragraphs
    const spokenParagraphs = state.paragraphs.filter(p =>
        !p.isStageDirection && !p.isRiff
    );
    const totalWords = spokenParagraphs.reduce((sum, p) =>
        sum + p.text.split(/\s+/).length, 0);
    const totalHeight = prompterContent.scrollHeight;
    const wordsPerSecond = 2.5;
    const estimatedDuration = Math.max(10, totalWords / wordsPerSecond);
    state.baseListenSpeed = totalHeight / estimatedDuration;
    state.listenScrollSpeed = state.baseListenSpeed;
    state.targetScrollPosition = state.scrollPosition;

    // Start continuous scroll animation
    state.playing = true;
    state.lastTimestamp = null;
    if (!state.prompterStartTime) state.prompterStartTime = Date.now();
    startTimer();
    prompterContent.setAttribute('contenteditable', 'false');
    state.animationFrame = requestAnimationFrame(animateListen);

    const engine = ctrlSpeechEngine.value;
    state.speechEngine = engine;

    if (engine === 'webspeech') {
        startWebSpeechRecognition();
    } else {
        startOpenAIRecognition(engine === 'openai-full' ? 'gpt-4o-transcribe' : 'gpt-4o-mini-transcribe');
    }

    startCostTicker();
}

function stopListening() {
    state.listening = false;
    state.playing = false;
    stopTimer();
    if (state.animationFrame) {
        cancelAnimationFrame(state.animationFrame);
        state.animationFrame = null;
    }
    prompterContent.setAttribute('contenteditable', 'true');

    // Clear timers so no orphan API calls fire
    clearTimeout(matchDebounceTimer);
    matchDebounceTimer = null;
    clearTimeout(interimThrottleTimer);
    interimThrottleTimer = null;
    state.interimTranscript = '';

    // Clear cost ticker
    if (state.costTickerInterval) {
        clearInterval(state.costTickerInterval);
        state.costTickerInterval = null;
    }

    // Stop Web Speech API
    if (state.recognition) {
        state.recognition.stop();
        state.recognition = null;
    }

    // Stop OpenAI WebSocket
    if (state.openaiWs) {
        state.openaiWs.close();
        state.openaiWs = null;
    }

    // Disconnect audio processor
    if (state.audioProcessor) {
        state.audioProcessor.disconnect();
        state.audioProcessor = null;
    }

    // Stop microphone
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(t => t.stop());
        state.mediaStream = null;
    }

    // Close audio context
    if (state.audioContext) {
        state.audioContext.close();
        state.audioContext = null;
    }

    listenStatus.classList.add('hidden');
    btnPlayPause.innerHTML = '&#127908; Start Listening';
}

// Refresh paragraph offsetTop values (call after layout changes)
function refreshParagraphOffsets() {
    state.paragraphs.forEach(p => {
        if (p.element) {
            p.offsetTop = p.element.offsetTop;
        }
    });
}


// ===== COST TICKER =====

function startCostTicker() {
    // Clear any existing ticker to prevent stacking
    if (state.costTickerInterval) {
        clearInterval(state.costTickerInterval);
    }

    const engine = state.speechEngine;
    const costPerMinute = engine === 'openai-full' ? 0.006 :
                          engine === 'openai' ? 0.003 : 0;

    state.costTickerInterval = setInterval(() => {
        if (!state.listening) {
            clearInterval(state.costTickerInterval);
            state.costTickerInterval = null;
            return;
        }
        const minutes = (Date.now() - state.listenStartTime) / 60000;
        state.listenCost = minutes * costPerMinute;
        listenCost.textContent = costPerMinute > 0
            ? `$${state.listenCost.toFixed(3)}`
            : 'Free';
    }, 1000);
}


// ===== WEB SPEECH API =====

function startWebSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        listenText.textContent = 'Web Speech API not supported — try Chrome or use OpenAI';
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.recognition = new SpeechRecognition();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.lang = 'en-US';

    state.recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
                finalTranscript += result[0].transcript;
            } else {
                interimTranscript += result[0].transcript;
            }
        }

        if (finalTranscript) {
            console.log('[Listen Mode] Web Speech transcript:', finalTranscript);
            state.transcript += ' ' + finalTranscript;
            state.interimTranscript = '';
            trimTranscript();
            listenText.textContent = finalTranscript.slice(-60);
            recordWordTimestamp(finalTranscript.trim().split(/\s+/).length);
            matchPosition(state.transcript);
        } else if (interimTranscript) {
            state.interimTranscript = interimTranscript;
            listenText.textContent = interimTranscript.slice(-60) + '...';
            // Real-time interim matching on partial speech
            matchPositionInterim(state.transcript + ' ' + interimTranscript);
        }
    };

    state.recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error !== 'no-speech') {
            listenText.textContent = 'Error: ' + event.error;
        }
    };

    state.recognition.onend = () => {
        if (state.listening && state.speechEngine === 'webspeech') {
            state.recognition.start();
        }
    };

    state.recognition.start();
    listenText.textContent = 'Listening (Web Speech)...';
}


// ===== OPENAI REALTIME API =====

async function startOpenAIRecognition(model) {
    const apiKey = CONFIG.OPENAI_API_KEY;
    if (!apiKey) {
        listenText.textContent = 'No OpenAI API key — click API Keys to set one';
        return;
    }

    console.log('[Listen Mode] API key starts with:', apiKey.slice(0, 12) + '...');
    listenText.textContent = 'Connecting to OpenAI...';

    try {
        // Only request mic if we don't already have a stream (avoids repeated permission popups)
        if (!state.mediaStream || !state.mediaStream.active) {
            state.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 24000,
                    echoCancellation: true,
                    noiseSuppression: true,
                }
            });
        }

        // Only create audio context + processor if not already set up
        if (!state.audioContext || state.audioContext.state === 'closed') {
            state.audioContext = new AudioContext({ sampleRate: 24000 });
            const source = state.audioContext.createMediaStreamSource(state.mediaStream);
            const processor = state.audioContext.createScriptProcessor(4096, 1, 1);
            state.audioProcessor = processor;
            source.connect(processor);
            processor.connect(state.audioContext.destination);
        }

        // Connect WebSocket to OpenAI Realtime API
        const wsUrl = `wss://api.openai.com/v1/realtime?intent=transcription`;
        console.log('[Listen Mode] Connecting WebSocket to:', wsUrl);
        const ws = new WebSocket(wsUrl, [
            'realtime',
            `openai-insecure-api-key.${apiKey}`,
            'openai-beta.realtime-v1',
        ]);
        state.openaiWs = ws;

        ws.onopen = () => {
            console.log('[Listen Mode] WebSocket connected');
            state.reconnectAttempts = 0;

            // Configure transcription session
            ws.send(JSON.stringify({
                type: 'transcription_session.update',
                session: {
                    input_audio_format: 'pcm16',
                    input_audio_transcription: {
                        model: model,
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.4,
                        silence_duration_ms: 300,
                        prefix_padding_ms: 200,
                    },
                },
            }));
            listenText.textContent = `Listening (${model})...`;
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleOpenAIEvent(data);
        };

        ws.onerror = (error) => {
            console.error('[Listen Mode] WebSocket error:', error);
            listenText.textContent = 'Connection error — check console & API key';
        };

        ws.onclose = (event) => {
            console.warn('[Listen Mode] WebSocket closed — code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
            if (state.listening) {
                state.reconnectAttempts++;
                if (state.reconnectAttempts > state.maxReconnectAttempts) {
                    listenText.textContent = 'Connection lost — too many retries. Stop and restart.';
                    return;
                }
                const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
                listenText.textContent = `Disconnected (code ${event.code}) — retrying in ${Math.round(delay / 1000)}s...`;
                setTimeout(() => {
                    if (state.listening) {
                        // Reconnect WebSocket only — reuse mic and audio context
                        startOpenAIRecognition(model);
                    }
                }, delay);
            }
        };

        // Stream audio to WebSocket
        state.audioProcessor.onaudioprocess = (e) => {
            if (!state.listening || !ws || ws.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            const pcm16 = float32ToPcm16(inputData);
            const base64 = arrayBufferToBase64(pcm16.buffer);

            ws.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: base64,
            }));
        };

    } catch (error) {
        console.error('[Listen Mode] Failed to start:', error);
        listenText.textContent = 'Mic access denied or error — check console';
    }
}

function handleOpenAIEvent(data) {
    switch (data.type) {
        case 'conversation.item.input_audio_transcription.delta':
            if (data.delta) {
                state.interimTranscript += data.delta;
                listenText.textContent = state.interimTranscript.slice(-60) + '...';
                // Real-time interim matching — no debounce, just n-gram
                matchPositionInterim(state.transcript + ' ' + state.interimTranscript);
            }
            break;

        case 'conversation.item.input_audio_transcription.completed':
            if (data.transcript) {
                console.log('[Listen Mode] Transcript received:', data.transcript);
                state.transcript += ' ' + data.transcript;
                state.interimTranscript = '';  // Reset interim buffer
                trimTranscript();
                listenText.textContent = data.transcript.slice(-60);
                // Adaptive pace: record word count for wps measurement
                const wordCount = data.transcript.trim().split(/\s+/).length;
                recordWordTimestamp(wordCount);
                matchPosition(state.transcript);
            }
            break;

        case 'transcription_session.created':
            console.log('Transcription session created');
            break;

        case 'transcription_session.updated':
            console.log('Transcription session configured');
            break;

        case 'input_audio_buffer.speech_started':
            listenText.textContent = 'Hearing speech...';
            break;

        case 'input_audio_buffer.speech_stopped':
            listenText.textContent = 'Processing...';
            break;

        case 'error':
            console.error('OpenAI API error:', data.error);
            listenText.textContent = `Error: ${data.error?.message || 'Unknown'}`;
            break;

        default:
            if (data.type !== 'input_audio_buffer.committed') {
                console.log('OpenAI event:', data.type, data);
            }
    }
}

// Prevent transcript from growing unbounded — keep last ~2000 chars
function trimTranscript() {
    if (state.transcript.length > 2500) {
        state.transcript = state.transcript.slice(-2000);
    }
}

// Convert Float32 audio samples to PCM16 (Int16)
function float32ToPcm16(float32Array) {
    const pcm16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
}

// Convert ArrayBuffer to base64 string
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}


// ===== POSITION MATCHING =====
// Primary: continuous position matching (free, instant)
// Fallback: LLM call when confidence is low (riffing, skipping)

let matchDebounceTimer = null;
let interimThrottleTimer = null;
let lowConfidenceCount = 0;


// ===== CONTINUOUS POSITION MATCHING =====
// Matches speech against a continuous word stream (not per-paragraph).
// Returns a pixel position, enabling sub-line precision and natural
// cross-paragraph tracking.

// Build word-to-pixel map and bigram index for the entire script
function buildScriptIndex() {
    const wordMap = [];
    const bigramIndex = new Map();

    for (const para of state.paragraphs) {
        if (!para.element) continue;
        // Skip pure stage directions entirely
        const isPureStageDir = para.isStageDirection &&
            !para.text.replace(/\[.*?\]/g, '').trim();
        if (isPureStageDir) continue;

        const words = normalizeText(para.text).split(/\s+/).filter(w => w);
        if (!words.length) continue;

        const elTop = para.element.offsetTop;
        const elHeight = para.element.offsetHeight;

        for (let i = 0; i < words.length; i++) {
            const fraction = words.length > 1 ? i / (words.length - 1) : 0.5;
            const idx = wordMap.length;
            wordMap.push({
                word: words[i],
                pixelY: elTop + fraction * elHeight,
                paraIndex: para.index,
                isRiff: para.isRiff,
            });

            // Bigram: previous word + this word (works across paragraph boundaries)
            if (idx > 0) {
                const bg = wordMap[idx - 1].word + ' ' + words[i];
                if (!bigramIndex.has(bg)) bigramIndex.set(bg, []);
                bigramIndex.get(bg).push(idx);
            }
        }
    }

    state.scriptIndex = { wordMap, bigramIndex };
    console.log('[Listen Mode] Built script index:', wordMap.length, 'words,', bigramIndex.size, 'unique bigrams');
}

// Match recent transcript against the continuous word stream
function continuousMatch(transcript) {
    const { wordMap, bigramIndex } = state.scriptIndex || {};
    if (!wordMap || !wordMap.length) return null;

    const recentWords = normalizeText(transcript).split(/\s+/).slice(-15);
    if (recentWords.length < 2) return null;

    // Build transcript bigrams with recency weights
    const transcriptBigrams = [];
    let totalWeight = 0;
    for (let i = 0; i < recentWords.length - 1; i++) {
        const bg = recentWords[i] + ' ' + recentWords[i + 1];
        const weight = 0.5 + (i / Math.max(1, recentWords.length - 2));
        transcriptBigrams.push({ bg, weight });
        totalWeight += weight;
    }

    // Find current word index from scroll position
    const containerHeight = prompterContainer.offsetHeight;
    const guidePx = state.scrollPosition - (containerHeight * 0.7) + (containerHeight * 0.3);
    let currentWordIdx = 0;
    for (let i = 0; i < wordMap.length; i++) {
        if (wordMap[i].pixelY >= guidePx) { currentWordIdx = i; break; }
    }
    if (guidePx > wordMap[wordMap.length - 1].pixelY) {
        currentWordIdx = wordMap.length - 1;
    }

    // Search window: wider when riffing (speaker may have jumped ahead)
    const back = state.riffing ? 80 : 40;
    const ahead = state.riffing ? 250 : 120;
    const searchStart = Math.max(0, currentWordIdx - back);
    const searchEnd = Math.min(wordMap.length, currentWordIdx + ahead);

    // Score word positions based on bigram hits
    const scores = new Float32Array(wordMap.length);
    for (const { bg, weight } of transcriptBigrams) {
        const hits = bigramIndex.get(bg);
        if (!hits) continue;
        for (const pos of hits) {
            if (pos >= searchStart && pos < searchEnd) {
                scores[pos] += weight;
            }
        }
    }

    // Smooth with box window (±4 words) to find the densest match cluster
    const halfWin = 4;
    let bestSmoothed = 0;
    let bestPos = currentWordIdx;

    for (let i = searchStart; i < searchEnd; i++) {
        // Skip positions with no nearby scores (fast path)
        if (scores[i] === 0) {
            let hasNearby = false;
            for (let j = Math.max(0, i - halfWin); j <= Math.min(wordMap.length - 1, i + halfWin); j++) {
                if (scores[j] > 0) { hasNearby = true; break; }
            }
            if (!hasNearby) continue;
        }

        let smoothed = 0;
        for (let j = Math.max(0, i - halfWin); j <= Math.min(wordMap.length - 1, i + halfWin); j++) {
            smoothed += scores[j];
        }

        // Forward bias
        if (i >= currentWordIdx) smoothed *= 1.05;

        if (smoothed > bestSmoothed) {
            bestSmoothed = smoothed;
            bestPos = i;
        }
    }

    // Refine: weighted center of mass around the peak for sub-word precision
    let wSum = 0, posSum = 0;
    for (let j = Math.max(0, bestPos - halfWin); j <= Math.min(wordMap.length - 1, bestPos + halfWin); j++) {
        if (scores[j] > 0) {
            wSum += scores[j];
            posSum += j * scores[j];
        }
    }
    const refinedPos = wSum > 0 ? Math.round(posSum / wSum) : bestPos;
    const finalPos = Math.max(0, Math.min(wordMap.length - 1, refinedPos));

    const confidence = totalWeight > 0 ? bestSmoothed / totalWeight : 0;

    return {
        pixelPosition: wordMap[finalPos].pixelY,
        confidence,
        paraIndex: wordMap[finalPos].paraIndex,
        isRiff: wordMap[finalPos].isRiff,
        wordIndex: finalPos,
    };
}

// Interim matching: fast, throttled, runs on partial speech (no LLM)
function matchPositionInterim(transcript) {
    if (interimThrottleTimer) return;
    interimThrottleTimer = setTimeout(() => { interimThrottleTimer = null; }, 200);

    const result = continuousMatch(transcript);
    if (result && result.confidence >= 0.08) {
        handlePositionUpdate(result);
    }
}

// Final matching: runs on completed speech segments, can trigger LLM fallback
function matchPosition(transcript) {
    clearTimeout(matchDebounceTimer);
    matchDebounceTimer = setTimeout(() => {
        const result = continuousMatch(transcript);
        console.log('[Listen Mode] Continuous match:', result);

        if (result && result.confidence >= 0.06) {
            lowConfidenceCount = 0;
            handlePositionUpdate(result);
        } else {
            lowConfidenceCount++;
            if (lowConfidenceCount >= 3) {
                console.log('[Listen Mode] Low confidence for 3+ segments, calling LLM fallback');
                callSemanticMatch(transcript);
                lowConfidenceCount = 0;
            } else {
                handlePositionUpdate({
                    riffing: true,
                    confidence: result ? result.confidence : 0,
                });
            }
        }
    }, 150);
}

// Normalize text for comparison: lowercase, strip punctuation, collapse whitespace
function normalizeText(text) {
    return text.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}


// ===== LLM FALLBACK (Claude Haiku with prompt caching) =====

async function callSemanticMatch(transcript) {
    if (!CONFIG.ANTHROPIC_API_KEY) {
        console.warn('No Anthropic API key — using n-gram matching only');
        return;
    }

    // Only send paragraphs in a window around current position to reduce tokens
    const windowStart = Math.max(0, state.currentParagraphIndex - 5);
    const windowEnd = Math.min(state.paragraphs.length, state.currentParagraphIndex + 15);
    const windowParagraphs = state.paragraphs.slice(windowStart, windowEnd);

    const scriptWithNumbers = windowParagraphs.map(p =>
        `[PARA ${p.index}]${p.isRiff ? ' [RIFF SECTION]' : ''}${p.isStageDirection ? ' [STAGE DIRECTION - NOT SPOKEN]' : ''} ${p.text}`
    ).join('\n');

    const recentTranscript = transcript.slice(-500);

    console.log('[Listen Mode] Calling LLM fallback with transcript:', recentTranscript.slice(-100));

    const systemPrompt = `You are a teleprompter position tracker. Given a script and recent speech transcript, determine which paragraph the speaker is at and whether they are riffing (going off-script).

Rules:
- Match by MEANING, not exact words — speakers paraphrase and add filler
- [RIFF SECTION] = speaker may go on a tangent here
- [STAGE DIRECTION] = not spoken, skip when matching
- If speech doesn't match nearby paragraphs, the speaker is probably riffing

Respond with JSON only: {"paragraph": <number>, "riffing": <boolean>, "confidence": <0-1>}`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CONFIG.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 100,
                system: [{
                    type: 'text',
                    text: systemPrompt + '\n\nSCRIPT:\n' + scriptWithNumbers,
                    cache_control: { type: 'ephemeral' },
                }],
                messages: [{
                    role: 'user',
                    content: `RECENT SPEECH:\n${recentTranscript}\nPrevious position: paragraph ${state.currentParagraphIndex}\nWhere is the speaker now?`
                }],
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[Listen Mode] API error:', response.status, errorText);
            return;
        }

        const data = await response.json();
        const text = data.content[0].text;
        console.log('[Listen Mode] Claude response:', text);

        const jsonMatch = text.match(/\{[^}]+\}/);
        if (jsonMatch) {
            try {
                const result = JSON.parse(jsonMatch[0]);
                console.log('[Listen Mode] LLM result:', result);
                handlePositionUpdate(result);
            } catch (parseErr) {
                console.warn('[Listen Mode] Failed to parse LLM JSON:', parseErr);
            }
        } else {
            console.warn('[Listen Mode] No JSON found in LLM response');
        }
    } catch (error) {
        console.error('[Listen Mode] LLM fallback error:', error);
    }
}

// Unified position update handler
// Accepts both continuous format {pixelPosition, confidence, paraIndex, isRiff}
// and LLM format {paragraph, riffing, confidence}
function handlePositionUpdate(result) {
    const { pixelPosition, paragraph, riffing, confidence, wordFraction, paraIndex, isRiff } = result;

    // --- Riffing: pause scroll, don't advance ---
    if (riffing) {
        if (!state.riffing) state.wasRiffing = false; // will be set on resume
        state.riffing = true;
        state.listenScrollSpeed = 0;
        listenText.textContent = 'Riffing... (paused)';
        return;
    }

    if (confidence < 0.05) return;

    // --- Resume from riff: mark so we allow bigger jumps ---
    const resumingFromRiff = state.riffing;
    if (state.riffing) {
        state.riffing = false;
        state.wasRiffing = true; // allow bigger forward jump
        state.listenScrollSpeed = state.baseListenSpeed;
    }

    // --- Calculate target scroll position ---
    const containerHeight = prompterContainer.offsetHeight;
    const guideLine = containerHeight * 0.3;
    let targetScrollPos;
    let effectiveParaIndex;

    if (pixelPosition !== undefined) {
        // Continuous matching: pixel position directly
        targetScrollPos = pixelPosition - guideLine + (containerHeight * 0.7);
        effectiveParaIndex = paraIndex;
    } else {
        // LLM fallback: paragraph-based
        const targetEl = prompterContent.querySelector(`[data-para-index="${paragraph}"]`);
        if (!targetEl) return;
        const withinOffset = (wordFraction || 0) * targetEl.offsetHeight;
        targetScrollPos = targetEl.offsetTop + withinOffset - guideLine + (containerHeight * 0.7);
        effectiveParaIndex = paragraph;
    }

    // --- Clamp forward jumps ---
    // After a riff: allow up to 500px forward (speaker may have jumped ahead)
    // Normal: allow up to 120px forward per update (~2-3 lines)
    // No clamp on backward movement (slowing is always fine)
    const maxForward = (resumingFromRiff || state.wasRiffing) ? 500 : 120;
    if (targetScrollPos > state.scrollPosition + maxForward) {
        targetScrollPos = state.scrollPosition + maxForward;
    }
    // Clear wasRiffing after one successful forward catch-up
    if (state.wasRiffing && targetScrollPos <= state.scrollPosition + 50) {
        state.wasRiffing = false;
    }

    state.targetScrollPosition = targetScrollPos;
    if (effectiveParaIndex !== undefined) {
        state.currentParagraphIndex = effectiveParaIndex;
    }

    // --- Direct position nudge when confident ---
    // Blends scroll position toward target for faster, smoother tracking
    const diff = targetScrollPos - state.scrollPosition;
    if (confidence > 0.10) {
        const nudgeFactor = Math.min(0.15, confidence * 0.4);
        state.scrollPosition += diff * nudgeFactor;
        const startPosition = containerHeight * 0.7;
        prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
    }

    // --- Adjust scroll speed based on remaining difference ---
    const newDiff = targetScrollPos - state.scrollPosition;
    const base = state.baseListenSpeed;

    if (newDiff > 20) {
        // Speaker is ahead — speed up (capped at 3x)
        state.listenScrollSpeed = Math.min(base * 3, base * (1 + newDiff / 200));
    } else if (newDiff < -20) {
        // Scroll is ahead — slow down or pause
        state.listenScrollSpeed = Math.max(0, base * (1 + newDiff / 100));
    } else {
        // Close enough — cruise
        state.listenScrollSpeed = base;
    }

    // --- Update visual highlight ---
    prompterContent.querySelectorAll('.current-position').forEach(el => {
        el.classList.remove('current-position');
    });
    if (effectiveParaIndex !== undefined) {
        const targetEl = prompterContent.querySelector(`[data-para-index="${effectiveParaIndex}"]`);
        if (targetEl) targetEl.classList.add('current-position');
    }

    listenText.textContent = `Para ${effectiveParaIndex} (${Math.round(confidence * 100)}%)`;
}

// Smoothly scroll so the target element aligns with the guide line (30% from top)
// Used by scroll mode and LLM fallback; listen mode uses speed adjustment instead
function scrollToElement(element, wordFraction) {
    const containerHeight = prompterContainer.offsetHeight;
    const guideLine = containerHeight * 0.3;

    const elementHeight = element.offsetHeight;
    const withinOffset = (wordFraction || 0) * elementHeight;
    const targetTop = guideLine - element.offsetTop - withinOffset;

    state.scrollPosition = (containerHeight * 0.7) - targetTop;

    prompterContent.style.transition = 'top 0.2s ease-out';
    prompterContent.style.top = targetTop + 'px';

    setTimeout(() => {
        prompterContent.style.transition = '';
    }, 200);
}


// ===== PROGRESS BAR =====

function updateProgress(scrollPos, maxScroll) {
    const pct = Math.min(100, Math.max(0, (scrollPos / maxScroll) * 100));
    progressFill.style.width = pct + '%';
}


// ===== TIMER =====

function startTimer() {
    stopTimer();
    updateTimerDisplay();
    state.timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
}

function updateTimerDisplay() {
    if (!state.prompterStartTime) return;
    const elapsed = Math.floor((Date.now() - state.prompterStartTime) / 1000);
    const elapsedStr = formatTime(elapsed);

    // Estimate remaining based on scroll progress
    const containerHeight = prompterContainer.offsetHeight;
    const contentHeight = prompterContent.scrollHeight;
    const maxScroll = (containerHeight * 0.7) + contentHeight;
    const progress = Math.max(0.01, state.scrollPosition / maxScroll);
    const totalEstimate = elapsed / progress;
    const remaining = Math.max(0, Math.round(totalEstimate - elapsed));
    const remainStr = formatTime(remaining);

    timerDisplay.textContent = `${elapsedStr} / -${remainStr}`;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}


// ===== COUNTDOWN =====

function showCountdown(callback) {
    countdownOverlay.classList.remove('hidden');
    let count = 3;
    countdownOverlay.textContent = count;

    const tick = () => {
        count--;
        if (count > 0) {
            countdownOverlay.textContent = count;
            setTimeout(tick, 800);
        } else {
            countdownOverlay.textContent = '';
            countdownOverlay.classList.add('hidden');
            callback();
        }
    };
    setTimeout(tick, 800);
}


// ===== ADAPTIVE PACE LEARNING =====

function recordWordTimestamp(wordCount) {
    const now = Date.now();
    state.recentWordTimestamps.push({ time: now, wordCount });

    // Keep only last 30 seconds of data
    const cutoff = now - 30000;
    state.recentWordTimestamps = state.recentWordTimestamps.filter(e => e.time > cutoff);

    // Need at least 2 data points spanning 3+ seconds
    if (state.recentWordTimestamps.length >= 2) {
        const oldest = state.recentWordTimestamps[0];
        const newest = state.recentWordTimestamps[state.recentWordTimestamps.length - 1];
        const timeDiff = (newest.time - oldest.time) / 1000;
        if (timeDiff >= 3) {
            const totalWords = state.recentWordTimestamps.reduce((sum, e) => sum + e.wordCount, 0);
            const wps = totalWords / timeDiff;
            // Smooth: blend 70% old, 30% new measurement
            state.measuredWps = state.measuredWps * 0.7 + wps * 0.3;
            // Update base listen speed accordingly
            const totalHeight = prompterContent.scrollHeight;
            const spokenParagraphs = state.paragraphs.filter(p => !p.isStageDirection && !p.isRiff);
            const scriptWords = spokenParagraphs.reduce((sum, p) => sum + p.text.split(/\s+/).length, 0);
            const duration = Math.max(10, scriptWords / state.measuredWps);
            state.baseListenSpeed = totalHeight / duration;
        }
    }
}


// ===== SAVE/LOAD SCRIPTS =====

function saveScript() {
    const content = state.editedScript || editor.innerHTML;
    if (!content || editor.textContent.trim() === '' ||
        editor.textContent.trim() === 'Paste your script here...') {
        return;
    }

    const name = prompt('Name this script:');
    if (!name) return;

    const scripts = JSON.parse(localStorage.getItem('teleprompter_scripts') || '{}');
    scripts[name] = {
        html: content,
        date: new Date().toISOString(),
    };
    localStorage.setItem('teleprompter_scripts', JSON.stringify(scripts));
}

function showLoadScripts() {
    const scripts = JSON.parse(localStorage.getItem('teleprompter_scripts') || '{}');
    const list = $('#scripts-list');
    const modal = $('#scripts-modal');

    if (Object.keys(scripts).length === 0) {
        list.innerHTML = '<p style="color: #666; font-size: 13px;">No saved scripts yet.</p>';
    } else {
        list.innerHTML = '';
        Object.entries(scripts).forEach(([name, data]) => {
            const item = document.createElement('div');
            item.className = 'script-item';
            const date = new Date(data.date).toLocaleDateString();
            item.innerHTML = `
                <span class="script-name">${name}</span>
                <span class="script-date">${date}</span>
                <span class="script-delete" title="Delete">&times;</span>
            `;
            item.querySelector('.script-name').addEventListener('click', () => {
                editor.innerHTML = data.html;
                state.editedScript = data.html;
                adjustEditorBackground();
                modal.classList.add('hidden');
            });
            item.querySelector('.script-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                delete scripts[name];
                localStorage.setItem('teleprompter_scripts', JSON.stringify(scripts));
                item.remove();
                if (Object.keys(scripts).length === 0) {
                    list.innerHTML = '<p style="color: #666; font-size: 13px;">No saved scripts yet.</p>';
                }
            });
            list.appendChild(item);
        });
    }
    modal.classList.remove('hidden');
}


// ===== TOUCH SUPPORT =====

let touchStartY = null;
let touchStartScrollPos = null;

prompterContainer.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
    touchStartScrollPos = state.scrollPosition;
}, { passive: true });

prompterContainer.addEventListener('touchmove', (e) => {
    if (touchStartY === null) return;
    e.preventDefault();
    const deltaY = touchStartY - e.touches[0].clientY;
    state.scrollPosition = Math.max(0, touchStartScrollPos + deltaY);
    const containerHeight = prompterContainer.offsetHeight;
    const startPosition = containerHeight * 0.7;
    prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
}, { passive: false });

prompterContainer.addEventListener('touchend', () => {
    touchStartY = null;
    touchStartScrollPos = null;
}, { passive: true });


// ===== REMOTE CONTROL (BroadcastChannel) =====

function initRemoteControl() {
    if (!('BroadcastChannel' in window)) return;

    state.broadcastChannel = new BroadcastChannel('teleprompter-remote');
    state.broadcastChannel.onmessage = (event) => {
        const { action, value } = event.data;
        switch (action) {
            case 'play': togglePlayPause(); break;
            case 'reset': resetScroll(); break;
            case 'speed':
                ctrlSpeed.value = value;
                speedVal.value = value;
                state.speed = parseInt(value);
                break;
            case 'scroll':
                if (value === 'up') {
                    state.scrollPosition = Math.max(0, state.scrollPosition - 100);
                } else {
                    state.scrollPosition += 100;
                }
                const ch = prompterContainer.offsetHeight;
                prompterContent.style.top = (ch * 0.7 - state.scrollPosition) + 'px';
                break;
        }
    };
}

function broadcastAction(action, value) {
    if (state.broadcastChannel) {
        state.broadcastChannel.postMessage({ action, value });
    }
}

initRemoteControl();


// ===== KEYBOARD SHORTCUTS =====

document.addEventListener('keydown', (e) => {
    if (prompterView.classList.contains('hidden')) return;

    // Don't trigger shortcuts if actively editing the prompter content
    if (document.activeElement === prompterContent &&
        prompterContent.getAttribute('contenteditable') === 'true' &&
        !state.playing) {
        return;
    }

    const containerHeight = prompterContainer.offsetHeight;
    const startPosition = containerHeight * 0.7;

    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'ArrowUp':
            e.preventDefault();
            ctrlSpeed.value = Math.min(100, parseInt(ctrlSpeed.value) + 5);
            speedVal.value = ctrlSpeed.value;
            state.speed = parseInt(ctrlSpeed.value);
            break;
        case 'ArrowDown':
            e.preventDefault();
            ctrlSpeed.value = Math.max(0, parseInt(ctrlSpeed.value) - 5);
            speedVal.value = ctrlSpeed.value;
            state.speed = parseInt(ctrlSpeed.value);
            break;
        case 'ArrowLeft':
            e.preventDefault();
            state.scrollPosition = Math.max(0, state.scrollPosition - 100);
            prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
            break;
        case 'ArrowRight':
            e.preventDefault();
            state.scrollPosition += 100;
            prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
            break;
        case 'f':
            if (!e.ctrlKey && !e.metaKey) toggleFullscreen();
            break;
        case 'm':
            if (!e.ctrlKey && !e.metaKey) toggleMirror();
            break;
        case 'r':
            if (!e.ctrlKey && !e.metaKey) resetScroll();
            break;
        case '?':
            keyboardHints.classList.toggle('hidden');
            break;
        case 'Escape':
            if (!keyboardHints.classList.contains('hidden')) {
                keyboardHints.classList.add('hidden');
            } else if (!document.fullscreenElement) {
                backToEditor();
            }
            break;
    }
});


// ===== EVENT LISTENERS =====

btnStart.addEventListener('click', startPrompter);
btnBack.addEventListener('click', backToEditor);
btnPlayPause.addEventListener('click', togglePlayPause);
btnReset.addEventListener('click', resetScroll);
btnFullscreen.addEventListener('click', toggleFullscreen);
btnMirror.addEventListener('click', toggleMirror);
btnClear.addEventListener('click', () => {
    editor.innerHTML = '<p><br></p>';
    editor.focus();
    state.originalScript = '';
    state.editedScript = '';
});

// Track edits in prompter content
prompterContent.addEventListener('input', () => {
    // Edits will be synced on backToEditor()
});

prompterContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY * 0.5;
    state.scrollPosition += delta;
    state.scrollPosition = Math.max(0, state.scrollPosition);
    const containerHeight = prompterContainer.offsetHeight;
    const startPosition = containerHeight * 0.7;
    prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
}, { passive: false });

// Initialize mode labels
modeScrollLabel.classList.add('active');

// Check API key configuration on startup
if (typeof CONFIG === 'undefined') {
    console.error('CONFIG not loaded! Make sure config.js exists and is loaded before app.js');
} else {
    console.log('API Keys configured:', {
        openai: CONFIG.OPENAI_API_KEY ? 'Set' : 'Missing',
        anthropic: CONFIG.ANTHROPIC_API_KEY ? 'Set' : 'Missing'
    });
}

// ===== SAVE/LOAD SCRIPT BUTTONS =====
$('#btn-save-script').addEventListener('click', saveScript);
$('#btn-load-script').addEventListener('click', showLoadScripts);
$('#btn-close-scripts').addEventListener('click', () => {
    $('#scripts-modal').classList.add('hidden');
});
$('#scripts-modal').addEventListener('click', (e) => {
    if (e.target === $('#scripts-modal')) $('#scripts-modal').classList.add('hidden');
});

// ===== API KEYS MODAL =====

const apiKeysModal = $('#api-keys-modal');
const btnApiKeys = $('#btn-api-keys');
const inputOpenaiKey = $('#input-openai-key');
const inputAnthropicKey = $('#input-anthropic-key');
const btnSaveKeys = $('#btn-save-keys');
const btnClearKeys = $('#btn-clear-keys');

btnApiKeys.addEventListener('click', () => {
    inputOpenaiKey.value = CONFIG.OPENAI_API_KEY || '';
    inputAnthropicKey.value = CONFIG.ANTHROPIC_API_KEY || '';
    apiKeysModal.classList.remove('hidden');
});

btnSaveKeys.addEventListener('click', () => {
    CONFIG.setOpenAIKey(inputOpenaiKey.value.trim());
    CONFIG.setAnthropicKey(inputAnthropicKey.value.trim());
    apiKeysModal.classList.add('hidden');
});

btnClearKeys.addEventListener('click', () => {
    CONFIG.clearKeys();
    inputOpenaiKey.value = '';
    inputAnthropicKey.value = '';
});

apiKeysModal.addEventListener('click', (e) => {
    if (e.target === apiKeysModal) apiKeysModal.classList.add('hidden');
});

// ===== DEMO SCRIPT =====

const btnDemo = $('#btn-demo');
btnDemo.addEventListener('click', () => {
    editor.innerHTML = `
<p>Good evening, and welcome to tonight's presentation on the future of economics.</p>
<p>Before we begin, I want to thank our hosts for putting this event together. It's a real pleasure to be here with all of you tonight.</p>
<p>[Pause for applause]</p>
<p>Let me start with a simple question: Why do economists get such a bad rap? I mean, we predicted nine of the last five recessions. That's got to count for something, right?</p>
<p><em>Riff a bit here about the audience — where they're from, what brought them here tonight. Keep it light and conversational.</em></p>
<p>But seriously, the field of economics is undergoing a revolution. We're moving from a discipline built on theoretical models and simplifying assumptions to one grounded in data, experiments, and real-world evidence.</p>
<p>Think about it this way. Fifty years ago, an economist's toolkit was a chalkboard, a set of equations, and a strong opinion. Today, we have access to billions of data points, randomized controlled trials, and machine learning algorithms that can detect patterns no human ever could.</p>
<p>And this transformation isn't just academic. It's changing how governments make policy, how businesses make decisions, and how ordinary people understand the world around them.</p>
<p>[Show slide: GDP growth chart]</p>
<p>Let me give you a concrete example. Look at this chart. Traditional economic models predicted steady, predictable growth. But the real world doesn't work that way. Growth comes in bursts. Recessions hit without warning. And the distribution of outcomes is far more unequal than any bell curve would suggest.</p>
<p>The new economics embraces this messiness. Instead of assuming rational actors in perfect markets, we study how people actually behave — with all their biases, emotions, and cognitive limitations.</p>
<p><em>This is a good place to take questions from the audience if the energy feels right. Otherwise, push through to the policy section.</em></p>
<p>Now, let's talk about what this means for policy. If people aren't perfectly rational, then the old policy prescriptions don't always work. You can't just set the right price and expect the market to sort everything out.</p>
<p>Instead, we need to think about nudges, defaults, and choice architecture. We need to design systems that work with human psychology, not against it.</p>
<p>Consider retirement savings. For decades, economists said: just give people information and they'll make the right choice. But we know that's not true. When you make enrollment in a retirement plan automatic — an opt-out instead of opt-in — participation rates jump from forty percent to over ninety percent.</p>
<p>Same information. Same incentives. Completely different outcome. That's the power of understanding how people actually make decisions.</p>
<p>And this brings me to my final point. The future of economics isn't just about better predictions or fancier models. It's about building a discipline that genuinely helps people live better lives.</p>
<p>[Pause — let that land]</p>
<p>We have the tools. We have the data. And increasingly, we have the humility to admit when we're wrong and update our thinking. That gives me enormous hope for what the next generation of economists will accomplish.</p>
<p>Thank you very much. I'm happy to take your questions.</p>
<p>[Q&A — aim for 15 minutes]</p>
`.trim();
    state.editedScript = editor.innerHTML;
    adjustEditorBackground();
});

// Version stamp
const VERSION_TIMESTAMP = '2026-03-12 v5 — continuous position matching';
document.getElementById('version-stamp').textContent = VERSION_TIMESTAMP;
