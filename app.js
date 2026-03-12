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
    currentParagraphIndex: 0,
    paragraphs: [],
    riffing: false,
    listenStartTime: null,
    listenCost: 0,
    costTickerInterval: null, // Track cost ticker to prevent stacking
    reconnectAttempts: 0,     // Track reconnection attempts for backoff
    maxReconnectAttempts: 10, // Cap reconnection attempts
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
    state.playing = true;
    state.lastTimestamp = null;
    btnPlayPause.innerHTML = '&#9646;&#9646; Pause';
    // Disable editing while scrolling
    prompterContent.setAttribute('contenteditable', 'false');
    state.animationFrame = requestAnimationFrame(animate);
}

function stopScrolling() {
    state.playing = false;
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

    state.animationFrame = requestAnimationFrame(animate);
}

function resetScroll() {
    stopScrolling();
    state.scrollPosition = 0;
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
    state.listening = true;
    state.transcript = '';
    state.currentParagraphIndex = 0;
    state.riffing = false;
    state.listenStartTime = Date.now();
    state.listenCost = 0;
    state.reconnectAttempts = 0;
    listenStatus.classList.remove('hidden');
    btnPlayPause.innerHTML = '&#9632; Stop Listening';
    listenText.textContent = 'Starting...';
    listenCost.textContent = '$0.00';

    // Refresh paragraph offsets (may have changed since layout)
    refreshParagraphOffsets();

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

    // Clear the debounce timer so no orphan API calls fire
    clearTimeout(matchDebounceTimer);
    matchDebounceTimer = null;

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
            trimTranscript();
            listenText.textContent = finalTranscript.slice(-60);
            matchPosition(state.transcript);
        } else if (interimTranscript) {
            listenText.textContent = interimTranscript.slice(-60) + '...';
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
    if (!CONFIG.OPENAI_API_KEY) {
        listenText.textContent = 'Set OPENAI_API_KEY in config.js';
        return;
    }

    listenText.textContent = 'Connecting to OpenAI...';

    try {
        // Get microphone access
        state.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: 24000,
                echoCancellation: true,
                noiseSuppression: true,
            }
        });

        // Set up AudioContext to capture PCM16 at 24kHz
        state.audioContext = new AudioContext({ sampleRate: 24000 });
        const source = state.audioContext.createMediaStreamSource(state.mediaStream);

        // Use ScriptProcessorNode to capture raw audio
        const processor = state.audioContext.createScriptProcessor(4096, 1, 1);
        state.audioProcessor = processor;
        source.connect(processor);
        processor.connect(state.audioContext.destination);

        // Connect WebSocket to OpenAI Realtime API
        const wsUrl = `wss://api.openai.com/v1/realtime?intent=transcription`;
        const ws = new WebSocket(wsUrl, [
            'realtime',
            `openai-insecure-api-key.${CONFIG.OPENAI_API_KEY}`,
            'openai-beta.realtime-v1',
        ]);
        state.openaiWs = ws;

        ws.onopen = () => {
            // Reset reconnect counter on successful connection
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
                        threshold: 0.5,
                        silence_duration_ms: 500,
                        prefix_padding_ms: 300,
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
            console.error('OpenAI WebSocket error:', error);
            listenText.textContent = 'Connection error — check console & API key';
        };

        ws.onclose = (event) => {
            console.log('OpenAI WebSocket closed:', event.code, event.reason);
            if (state.listening) {
                state.reconnectAttempts++;
                if (state.reconnectAttempts > state.maxReconnectAttempts) {
                    listenText.textContent = 'Connection lost — too many retries. Stop and restart.';
                    return;
                }
                // Exponential backoff: 1s, 2s, 4s, 8s... capped at 30s
                const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
                listenText.textContent = `Disconnected — retrying in ${Math.round(delay / 1000)}s...`;
                setTimeout(() => {
                    if (state.listening) {
                        startOpenAIRecognition(model);
                    }
                }, delay);
            }
        };

        // Stream audio to WebSocket
        processor.onaudioprocess = (e) => {
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
        console.error('Failed to start OpenAI recognition:', error);
        listenText.textContent = 'Mic access denied or error — check console';
    }
}

function handleOpenAIEvent(data) {
    switch (data.type) {
        case 'conversation.item.input_audio_transcription.delta':
            if (data.delta) {
                listenText.textContent = data.delta.slice(-60);
            }
            break;

        case 'conversation.item.input_audio_transcription.completed':
            if (data.transcript) {
                console.log('[Listen Mode] Transcript received:', data.transcript);
                state.transcript += ' ' + data.transcript;
                trimTranscript();
                listenText.textContent = data.transcript.slice(-60);
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
// Primary: fast client-side n-gram matching (free, instant)
// Fallback: LLM call when confidence is low (riffing, skipping)

let matchDebounceTimer = null;
let lowConfidenceCount = 0;  // Track consecutive low-confidence matches

function matchPosition(transcript) {
    clearTimeout(matchDebounceTimer);
    matchDebounceTimer = setTimeout(() => {
        const result = ngramMatch(transcript);
        console.log('[Listen Mode] N-gram match:', result);

        if (result.confidence >= 0.08) {
            // Good match — use it directly
            lowConfidenceCount = 0;
            handlePositionUpdate({
                paragraph: result.paragraph,
                riffing: false,
                confidence: result.confidence,
            });
        } else {
            // Low confidence — might be riffing or skipped ahead
            lowConfidenceCount++;
            if (lowConfidenceCount >= 3) {
                // Persistent low confidence — call LLM for help
                console.log('[Listen Mode] Low confidence for 3+ segments, calling LLM fallback');
                callSemanticMatch(transcript);
                lowConfidenceCount = 0;
            } else {
                // Brief dip — mark as possibly riffing but hold position
                handlePositionUpdate({
                    paragraph: state.currentParagraphIndex,
                    riffing: true,
                    confidence: result.confidence,
                });
            }
        }
    }, 300);
}

// ===== N-GRAM MATCHING (client-side, zero cost) =====

function ngramMatch(transcript) {
    const paragraphs = state.paragraphs;
    if (!paragraphs.length) return { paragraph: 0, confidence: 0 };

    // Extract last ~30 words from transcript
    const recentWords = normalizeText(transcript).split(/\s+/).slice(-30);
    if (recentWords.length < 2) return { paragraph: state.currentParagraphIndex, confidence: 0 };

    // Build n-grams from transcript (trigrams)
    const ngramSize = 3;
    const transcriptNgrams = new Set();
    for (let i = 0; i <= recentWords.length - ngramSize; i++) {
        transcriptNgrams.add(recentWords.slice(i, i + ngramSize).join(' '));
    }
    if (transcriptNgrams.size === 0) {
        // Fall back to bigrams if not enough words for trigrams
        for (let i = 0; i <= recentWords.length - 2; i++) {
            transcriptNgrams.add(recentWords.slice(i, i + 2).join(' '));
        }
    }
    if (transcriptNgrams.size === 0) return { paragraph: state.currentParagraphIndex, confidence: 0 };

    // Search a window around the current position
    // Wider forward window (speaker moves forward), narrower backward window
    const searchStart = Math.max(0, state.currentParagraphIndex - 3);
    const searchEnd = Math.min(paragraphs.length, state.currentParagraphIndex + 10);

    let bestScore = 0;
    let bestIndex = state.currentParagraphIndex;

    for (let i = searchStart; i < searchEnd; i++) {
        const para = paragraphs[i];
        // Skip stage directions (not spoken)
        if (para.isStageDirection && !para.text.replace(/\[.*?\]/g, '').trim()) continue;

        const paraWords = normalizeText(para.text).split(/\s+/);
        if (paraWords.length < ngramSize) continue;

        let hits = 0;
        for (let j = 0; j <= paraWords.length - ngramSize; j++) {
            const ngram = paraWords.slice(j, j + ngramSize).join(' ');
            if (transcriptNgrams.has(ngram)) hits++;
        }

        const score = hits / transcriptNgrams.size;

        // Slight bias toward forward movement (more natural in a speech)
        const forwardBias = (i >= state.currentParagraphIndex) ? 1.05 : 1.0;
        const adjustedScore = score * forwardBias;

        if (adjustedScore > bestScore) {
            bestScore = adjustedScore;
            bestIndex = i;
        }
    }

    return { paragraph: bestIndex, confidence: bestScore };
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
                model: 'claude-haiku-4-5-20250414',
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

function handlePositionUpdate(result) {
    const { paragraph, riffing, confidence } = result;

    console.log('[Listen Mode] Position update:', { paragraph, riffing, confidence });

    state.riffing = riffing;

    if (riffing) {
        listenText.textContent = 'Riffing... (waiting for return to script)';
        return;
    }

    if (confidence < 0.05) {
        console.log('[Listen Mode] Confidence too low:', confidence);
        return;
    }

    state.currentParagraphIndex = paragraph;

    // Update visual highlight
    prompterContent.querySelectorAll('.current-position').forEach(el => {
        el.classList.remove('current-position');
    });

    const currentEl = prompterContent.querySelector(`[data-para-index="${paragraph}"]`);
    if (currentEl) {
        currentEl.classList.add('current-position');
        scrollToElement(currentEl);
        listenText.textContent = `Para ${paragraph} (${Math.round(confidence * 100)}%)`;
    } else {
        console.warn('[Listen Mode] Could not find paragraph element:', paragraph);
    }
}

// Smoothly scroll so the target element aligns with the guide line (30% from top)
function scrollToElement(element) {
    const containerHeight = prompterContainer.offsetHeight;
    const guideLine = containerHeight * 0.3;
    // We want element.offsetTop to align with the guide line
    // prompterContent.style.top = guideLine - element.offsetTop
    const targetTop = guideLine - element.offsetTop;

    // Update scrollPosition to stay in sync with scroll mode
    // In scroll mode: top = (containerHeight * 0.7) - scrollPosition
    // So: scrollPosition = (containerHeight * 0.7) - targetTop
    state.scrollPosition = (containerHeight * 0.7) - targetTop;

    prompterContent.style.transition = 'top 0.4s ease-out';
    prompterContent.style.top = targetTop + 'px';

    setTimeout(() => {
        prompterContent.style.transition = '';
    }, 400);
}


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
        case 'Escape':
            if (!document.fullscreenElement) backToEditor();
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
