// ===== STATE =====
const state = {
    playing: false,
    speed: 30,              // pixels per second
    scrollPosition: 0,
    mirrored: false,
    animationFrame: null,
    lastTimestamp: null,

    // Script versions
    originalScript: '',     // Original pasted content
    editedScript: '',       // Current working version with all edits

    // Paragraph tracking
    currentParagraphIndex: 0,
    paragraphs: [],

    // Timer
    prompterStartTime: null,
    timerInterval: null,

    // Remote control
    broadcastChannel: null,

    // Google Doc sync
    googleDocId: null,        // Currently linked Google Doc ID
    gdocPollInterval: null,   // Auto-refresh interval
    gdocLastHtml: '',         // Last fetched content for change detection
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
const ctrlOpacity = $('#ctrl-opacity');
const ctrlCleanParas = $('#ctrl-clean-paras');

// Buttons
const btnStart = $('#btn-start');
const btnBack = $('#btn-back');
const btnPlayPause = $('#btn-play-pause');
const btnReset = $('#btn-reset');
const btnFullscreen = $('#btn-fullscreen');
const btnMirror = $('#btn-mirror');
const btnClear = $('#btn-clear');

// Electron close buttons
const isElectron = navigator.userAgent.includes('Electron');
if (isElectron) {
    document.querySelectorAll('.electron-only').forEach(el => {
        el.classList.remove('electron-only');
        el.classList.add('electron-show');
    });
    const closeWindow = () => window.close();
    $('#btn-close-edit').addEventListener('click', closeWindow);
    $('#btn-close-prompter').addEventListener('click', closeWindow);
}

// Spinner inputs (number inputs next to sliders)
const fontSizeVal = $('#font-size-val');
const widthVal = $('#width-val');
const lineHeightVal = $('#line-height-val');
const speedVal = $('#speed-val');
const opacityVal = $('#opacity-val');

// New UI elements
const progressFill = $('#progress-fill');
const timerDisplay = $('#timer-display');
const countdownOverlay = $('#countdown-overlay');
const keyboardHints = $('#keyboard-hints');


// ===== EDITOR =====

// Remove empty paragraphs ("extra paragraph marks") between paragraphs
function stripEmptyParagraphs(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.body.querySelectorAll('p, div').forEach(el => {
        if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
    });
    return doc.body.innerHTML || '<p><br></p>';
}

function cleanParagraphsIfEnabled(html) {
    return ctrlCleanParas.checked ? stripEmptyParagraphs(html) : html;
}

ctrlCleanParas.addEventListener('change', () => {
    // Turning the toggle on cleans whatever is already in the editor
    const placeholder = editor.textContent.trim() === 'Paste your script here...';
    if (ctrlCleanParas.checked && editor.textContent.trim() && !placeholder) {
        editor.innerHTML = stripEmptyParagraphs(editor.innerHTML);
        state.editedScript = editor.innerHTML;
    }
    saveSettings();
});

editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');

    if (html) {
        const cleaned = cleanParagraphsIfEnabled(cleanGoogleDocsHtml(html));
        document.execCommand('insertHTML', false, cleaned);
    } else {
        const cleanedText = ctrlCleanParas.checked
            ? text.replace(/\n[ \t]*(\n[ \t]*)+/g, '\n')
            : text;
        document.execCommand('insertText', false, cleanedText);
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
    // Apply background with opacity
    const opacity = parseInt(ctrlOpacity.value) / 100;
    const bgHex = ctrlBgColor.value;
    const r = parseInt(bgHex.slice(1, 3), 16);
    const g = parseInt(bgHex.slice(3, 5), 16);
    const b = parseInt(bgHex.slice(5, 7), 16);
    const bgRgba = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    prompterContainer.style.background = bgRgba;
    prompterView.style.background = opacity < 1 ? 'transparent' : bgHex;
    document.documentElement.style.background = opacity < 1 ? 'transparent' : '';
    document.body.style.background = opacity < 1 ? 'transparent' : '';
    $('#control-bar').style.background = opacity < 1 ? `rgba(17, 17, 17, ${opacity})` : '#111';
    $('#transport-bar').style.background = opacity < 1 ? `rgba(17, 17, 17, ${opacity})` : '#111';
    state.speed = parseInt(ctrlSpeed.value);
    saveSettings();
}

// ===== SETTINGS PERSISTENCE =====

const SETTINGS_KEY = 'teleprompter_settings';

function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        font: ctrlFont.value,
        fontSize: ctrlFontSize.value,
        width: ctrlWidth.value,
        lineHeight: ctrlLineHeight.value,
        textColor: ctrlTextColor.value,
        bgColor: ctrlBgColor.value,
        speed: ctrlSpeed.value,
        opacity: ctrlOpacity.value,
        mirrored: state.mirrored,
        cleanParas: ctrlCleanParas.checked
    }));
}

function loadSettings() {
    let saved;
    try {
        saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    } catch (e) {
        return;
    }
    if (!saved) return;
    if (saved.font) ctrlFont.value = saved.font;
    if (saved.fontSize) { ctrlFontSize.value = saved.fontSize; fontSizeVal.value = saved.fontSize; }
    if (saved.width) { ctrlWidth.value = saved.width; widthVal.value = saved.width; }
    if (saved.lineHeight) { ctrlLineHeight.value = saved.lineHeight; lineHeightVal.value = saved.lineHeight; }
    if (saved.textColor) ctrlTextColor.value = saved.textColor;
    if (saved.bgColor) ctrlBgColor.value = saved.bgColor;
    if (saved.speed) { ctrlSpeed.value = saved.speed; speedVal.value = saved.speed; }
    if (saved.opacity) { ctrlOpacity.value = saved.opacity; opacityVal.value = saved.opacity; }
    if (typeof saved.cleanParas === 'boolean') ctrlCleanParas.checked = saved.cleanParas;
    if (saved.mirrored) toggleMirror();
    applySettings();
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
    saveSettings();
});
speedVal.addEventListener('input', () => {
    ctrlSpeed.value = speedVal.value;
    state.speed = parseInt(speedVal.value);
    saveSettings();
});

// Opacity: slider <-> spinner sync
ctrlOpacity.addEventListener('input', () => {
    opacityVal.value = ctrlOpacity.value;
    applySettings();
});
opacityVal.addEventListener('input', () => {
    ctrlOpacity.value = opacityVal.value;
    applySettings();
});

ctrlTextColor.addEventListener('input', applySettings);
ctrlBgColor.addEventListener('input', applySettings);


// ===== SCROLL MODE =====

function togglePlayPause() {
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
    saveSettings();
}


// ===== FULLSCREEN =====

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        prompterView.requestFullscreen();
    }
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
                const loadedHtml = cleanParagraphsIfEnabled(data.html);
                editor.innerHTML = loadedHtml;
                state.editedScript = loadedHtml;
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


// ===== GOOGLE DOC IMPORT =====

function extractGoogleDocId(url) {
    // Match /document/d/XXXXX or /document/d/XXXXX/
    const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

function cleanGoogleDocHtml(rawHtml) {
    // Parse the HTML and extract the body content
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');
    const body = doc.body;
    if (!body) return '';

    // Remove Google's style tags and metadata
    body.querySelectorAll('style, script, meta, link').forEach(el => el.remove());

    // Convert Google's span-based formatting to semantic HTML
    // Google Docs uses inline styles for bold/italic rather than <b>/<i>/<em>
    body.querySelectorAll('span').forEach(span => {
        const style = span.style;
        const isBold = style.fontWeight === '700' || style.fontWeight === 'bold';
        const isItalic = style.fontStyle === 'italic';

        if (isItalic && isBold) {
            span.outerHTML = `<strong><em>${span.innerHTML}</em></strong>`;
        } else if (isItalic) {
            span.outerHTML = `<em>${span.innerHTML}</em>`;
        } else if (isBold) {
            span.outerHTML = `<strong>${span.innerHTML}</strong>`;
        } else {
            // Unwrap plain spans — keep their text content
            span.outerHTML = span.innerHTML;
        }
    });

    // Collect paragraphs
    const paragraphs = [];
    body.querySelectorAll('p').forEach(p => {
        const text = p.textContent.trim();
        if (text) {
            paragraphs.push(`<p>${p.innerHTML.trim()}</p>`);
        }
    });

    return paragraphs.join('\n');
}

async function fetchGoogleDocHtml(docId) {
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=html`;

    let response;
    try {
        // In Electron, CORS isn't an issue; in browser, Google may block cross-origin
        response = await fetch(exportUrl);
    } catch (e) {
        // Fallback: try via a CORS proxy
        response = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(exportUrl)}`);
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Document not found. Check the URL is correct.');
        } else if (response.status === 401 || response.status === 403) {
            throw new Error('Access denied. Make sure the doc is shared as "Anyone with the link can view".');
        }
        throw new Error(`Failed to fetch document (HTTP ${response.status}).`);
    }

    const rawHtml = await response.text();
    return cleanGoogleDocHtml(rawHtml);
}

// Apply a Google Doc update to the editor and (if active) prompter view
function applyGoogleDocContent(html) {
    // Skip if content hasn't changed
    if (html === state.gdocLastHtml) return false;
    state.gdocLastHtml = html;

    html = cleanParagraphsIfEnabled(html);
    editor.innerHTML = html;
    state.editedScript = html;
    state.originalScript = html;
    adjustEditorBackground();

    // If prompter is currently showing, update it in-place preserving scroll position
    if (!prompterView.classList.contains('hidden')) {
        prompterContent.innerHTML = processContentForDisplay(html);
        state.paragraphs = parseParagraphs();
    }
    return true;
}

function startGdocPolling() {
    stopGdocPolling();
    // Poll every 10 seconds
    state.gdocPollInterval = setInterval(async () => {
        if (!state.googleDocId) return;
        try {
            const html = await fetchGoogleDocHtml(state.googleDocId);
            if (html && applyGoogleDocContent(html)) {
                flashGdocSyncIndicator();
            }
        } catch (e) {
            // Silent fail on background poll — doc may have gone private, network blip, etc.
            console.warn('[Google Doc sync] poll failed:', e.message);
        }
    }, 10000);
}

function stopGdocPolling() {
    if (state.gdocPollInterval) {
        clearInterval(state.gdocPollInterval);
        state.gdocPollInterval = null;
    }
}

function linkGoogleDoc(docId, html) {
    state.googleDocId = docId;
    state.gdocLastHtml = html;
    updateGdocLinkUI();
    startGdocPolling();
}

function unlinkGoogleDoc() {
    stopGdocPolling();
    state.googleDocId = null;
    state.gdocLastHtml = '';
    updateGdocLinkUI();
}

// Show/hide the linked-doc badge next to the Google Doc button
function updateGdocLinkUI() {
    const badge = $('#gdoc-linked-badge');
    if (state.googleDocId) {
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// Brief flash on the badge when an auto-sync updates content
function flashGdocSyncIndicator() {
    const badge = $('#gdoc-linked-badge');
    badge.classList.add('gdoc-synced');
    setTimeout(() => badge.classList.remove('gdoc-synced'), 1500);
}

// Manual refresh
async function refreshGoogleDoc() {
    if (!state.googleDocId) return;
    const badge = $('#gdoc-linked-badge');
    badge.textContent = '⟳ Syncing…';
    try {
        const html = await fetchGoogleDocHtml(state.googleDocId);
        if (html) applyGoogleDocContent(html);
        badge.textContent = '🔗 Linked';
    } catch (err) {
        badge.textContent = '⚠ Sync failed';
        setTimeout(() => { badge.textContent = '🔗 Linked'; }, 3000);
    }
}

// Wire up Google Doc modal
const gdocModal = $('#gdoc-modal');
const gdocUrlInput = $('#input-gdoc-url');
const gdocStatus = $('#gdoc-status');

$('#btn-gdoc').addEventListener('click', () => {
    gdocUrlInput.value = '';
    gdocStatus.textContent = '';
    gdocModal.classList.remove('hidden');
    gdocUrlInput.focus();
});

$('#btn-gdoc-cancel').addEventListener('click', () => {
    gdocModal.classList.add('hidden');
});

gdocModal.addEventListener('click', (e) => {
    if (e.target === gdocModal) gdocModal.classList.add('hidden');
});

$('#btn-gdoc-import').addEventListener('click', async () => {
    const url = gdocUrlInput.value.trim();
    if (!url) {
        gdocStatus.textContent = 'Please paste a Google Doc URL.';
        return;
    }

    const docId = extractGoogleDocId(url);
    if (!docId) {
        gdocStatus.textContent = 'Could not find a Google Doc ID in that URL.';
        return;
    }

    gdocStatus.textContent = 'Importing…';
    $('#btn-gdoc-import').disabled = true;

    try {
        const html = await fetchGoogleDocHtml(docId);
        if (!html) {
            throw new Error('The document appears to be empty.');
        }
        applyGoogleDocContent(html);
        linkGoogleDoc(docId, html);
        gdocModal.classList.add('hidden');
    } catch (err) {
        gdocStatus.textContent = err.message;
    } finally {
        $('#btn-gdoc-import').disabled = false;
    }
});

// Allow Enter key to trigger import
gdocUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        $('#btn-gdoc-import').click();
    }
});

// Linked badge: click to refresh, right-click to unlink
$('#gdoc-linked-badge').addEventListener('click', refreshGoogleDoc);
$('#gdoc-linked-badge').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (confirm('Unlink this Google Doc? (Auto-sync will stop)')) {
        unlinkGoogleDoc();
    }
});


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
        case '.': {
            // Nudge forward one line
            const lineH = parseInt(ctrlFontSize.value) * (parseInt(ctrlLineHeight.value) / 100);
            state.scrollPosition += lineH;
            prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
            break;
        }
        case ',': {
            // Nudge back one line
            const lineH = parseInt(ctrlFontSize.value) * (parseInt(ctrlLineHeight.value) / 100);
            state.scrollPosition = Math.max(0, state.scrollPosition - lineH);
            prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
            break;
        }
        case 'f':
            if (!e.ctrlKey && !e.metaKey) toggleFullscreen();
            break;
        case 'm':
            if (!e.ctrlKey && !e.metaKey) toggleMirror();
            break;
        case 'r':
            if (!e.ctrlKey && !e.metaKey) resetScroll();
            break;
        case '[':
            ctrlOpacity.value = Math.max(10, parseInt(ctrlOpacity.value) - 10);
            opacityVal.value = ctrlOpacity.value;
            applySettings();
            break;
        case ']':
            ctrlOpacity.value = Math.min(100, parseInt(ctrlOpacity.value) + 10);
            opacityVal.value = ctrlOpacity.value;
            applySettings();
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

// Toggle controls visibility
const btnToggleControls = $('#btn-toggle-controls');
const controlBarControls = $('#control-bar-controls');
btnToggleControls.addEventListener('click', () => {
    btnToggleControls.classList.toggle('collapsed');
    controlBarControls.classList.toggle('collapsed');
});
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


// ===== SAVE/LOAD SCRIPT BUTTONS =====
$('#btn-save-script').addEventListener('click', saveScript);
$('#btn-load-script').addEventListener('click', showLoadScripts);
$('#btn-close-scripts').addEventListener('click', () => {
    $('#scripts-modal').classList.add('hidden');
});
$('#scripts-modal').addEventListener('click', (e) => {
    if (e.target === $('#scripts-modal')) $('#scripts-modal').classList.add('hidden');
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

// Restore saved preferences from the previous session
loadSettings();

// Version stamp
const VERSION_TIMESTAMP = '2026-07-24 v6 — manual scroll only';
document.getElementById('version-stamp').textContent = VERSION_TIMESTAMP;
