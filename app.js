// ===== STATE =====
const state = {
    playing: false,
    wpm: 150,               // reading speed in words per minute (the user-facing setting)
    speed: 30,              // scroll speed in pixels per second, derived from wpm
    wordCount: 0,           // words in the current script, for the wpm→px/s conversion
    scrollPosition: 0,
    mirrored: false,
    panelWidth: 232,        // side panel width in px
    animationFrame: null,
    lastTimestamp: null,

    // Current working version of the script (clean HTML, no display markup)
    editedScript: '',

    // Paragraph tracking
    paragraphs: [],

    // Timer
    prompterStartTime: null,
    timerInterval: null,

    // Remote control
    broadcastChannel: null,

    // Google Doc sync
    googleDocId: null,        // Currently linked Google Doc ID
    googleDocTabId: null,     // Which tab of it (null = the doc's default tab)
    gdocTabs: [],             // Tabs found in the linked doc, in document order
    gdocPollInterval: null,   // Auto-refresh interval
    gdocLastPrint: '',        // Fingerprint of the last content, for change detection
};

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const prompterContent = $('#prompter-content');
const prompterContainer = $('#prompter-container');
const sidePanel = $('#side-panel');

// Controls
const ctrlFont = $('#ctrl-font');
const ctrlFontSize = $('#ctrl-font-size');
const ctrlWidth = $('#ctrl-width');
const ctrlLineHeight = $('#ctrl-line-height');
const ctrlTextColor = $('#ctrl-text-color');
const ctrlBgColor = $('#ctrl-bg-color');
const ctrlSpeed = $('#ctrl-speed');
const ctrlOpacity = $('#ctrl-opacity');

// Buttons
const btnPlayPause = $('#btn-play-pause');
const btnReset = $('#btn-reset');
const btnFullscreen = $('#btn-fullscreen');
const btnMirror = $('#btn-mirror');
const btnClear = $('#btn-clear');

// Value labels next to sliders
const fontSizeVal = $('#font-size-val');
const widthVal = $('#width-val');
const lineHeightVal = $('#line-height-val');
const speedVal = $('#speed-val');
const opacityVal = $('#opacity-val');

// Other UI elements
const progressFill = $('#progress-fill');
const timerDisplay = $('#timer-display');
const countdownOverlay = $('#countdown-overlay');
const keyboardHints = $('#keyboard-hints');

// Electron: show drag bar and the close button at the top right of the window
const isElectron = navigator.userAgent.includes('Electron');
if (isElectron) {
    document.body.classList.add('is-electron');
    $('#btn-close-app').addEventListener('click', () => window.close());
}


// ===== SCRIPT CONTENT =====

const PLACEHOLDER = 'Paste your script here...';

function isPlaceholder() {
    return prompterContent.textContent.trim() === PLACEHOLDER;
}

function hasScript() {
    return prompterContent.textContent.trim() !== '' && !isPlaceholder();
}

// Load clean HTML into the prompter (adds riff/stage-direction/paragraph markup)
function setScript(html, { keepScroll = false } = {}) {
    state.editedScript = html;
    prompterContent.innerHTML = processContentForDisplay(html);
    state.paragraphs = parseParagraphs();
    updateWordCount();
    if (keepScroll) {
        positionContent();
    } else {
        resetScroll();
    }
}

// Place the content according to the current scroll position
function positionContent() {
    const startPosition = prompterContainer.offsetHeight * 0.7;
    prompterContent.style.top = (startPosition - state.scrollPosition) + 'px';
}

// Remove empty paragraphs ("extra paragraph marks") between paragraphs
function stripEmptyParagraphs(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.body.querySelectorAll('p, div').forEach(el => {
        if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
    });
    return doc.body.innerHTML || '<p><br></p>';
}

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

    // Let the prompter's own CSS size images (charts paste with fixed pixel dimensions)
    body.querySelectorAll('img').forEach(img => {
        img.removeAttribute('width');
        img.removeAttribute('height');
    });

    return body.innerHTML;
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
        if (!el.getAttribute('class')) el.removeAttribute('class');
    });

    body.querySelectorAll('[data-para-index]').forEach(el => {
        el.removeAttribute('data-para-index');
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


// ===== EDITING (paste and type directly into the prompter) =====

prompterContent.addEventListener('focus', () => {
    if (isPlaceholder()) {
        prompterContent.innerHTML = '<p><br></p>';
    }
});

prompterContent.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');

    if (html) {
        const cleaned = stripEmptyParagraphs(cleanGoogleDocsHtml(html));
        document.execCommand('insertHTML', false, cleaned);
    } else {
        const cleanedText = text.replace(/\n[ \t]*(\n[ \t]*)+/g, '\n');
        document.execCommand('insertText', false, cleanedText);
    }

    // Re-process the whole script so riffs/stage directions get styled
    requestAnimationFrame(() => {
        setScript(reverseProcessContent(prompterContent.innerHTML), { keepScroll: true });
    });
});

// Track typed edits (no rebuild — that would move the cursor)
prompterContent.addEventListener('input', () => {
    state.editedScript = reverseProcessContent(prompterContent.innerHTML);
    updateWordCount();
});


// ===== SPEED (words per minute → pixels per second) =====

function updateWordCount() {
    const text = hasScript() ? prompterContent.textContent.trim() : '';
    state.wordCount = text ? text.split(/\s+/).length : 0;
}

// Convert the wpm setting to a scroll speed, using how densely the current
// script lays out words on screen (so font size, spacing, and width changes
// keep the same reading pace)
function wpmToPxPerSec() {
    const fontSize = parseInt(ctrlFontSize.value);
    const lineHeightPx = fontSize * (parseInt(ctrlLineHeight.value) / 100);
    let pxPerWord;
    if (state.wordCount >= 20) {
        pxPerWord = prompterContent.scrollHeight / state.wordCount;
    } else {
        // No script yet: estimate from font metrics (an average word ≈ 3× font size wide)
        const lineWidth = prompterContent.offsetWidth || 600;
        const wordsPerLine = Math.max(1, lineWidth / (fontSize * 3));
        pxPerWord = lineHeightPx / wordsPerLine;
    }
    return (state.wpm / 60) * pxPerWord;
}


// ===== SETTINGS =====

function applySettings() {
    prompterContent.style.fontFamily = ctrlFont.value;
    prompterContent.style.fontSize = ctrlFontSize.value + 'px';
    prompterContent.style.width = ctrlWidth.value + '%';
    prompterContent.style.lineHeight = (ctrlLineHeight.value / 100).toFixed(1);
    prompterContent.style.color = ctrlTextColor.value;

    // Apply window opacity to all backgrounds
    const opacity = parseInt(ctrlOpacity.value) / 100;
    const bgHex = ctrlBgColor.value;
    const r = parseInt(bgHex.slice(1, 3), 16);
    const g = parseInt(bgHex.slice(3, 5), 16);
    const b = parseInt(bgHex.slice(5, 7), 16);
    prompterContainer.style.background = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    document.documentElement.style.background = opacity < 1 ? 'transparent' : '';
    document.body.style.background = opacity < 1 ? 'transparent' : '';
    const barBg = `rgba(17, 17, 17, ${opacity})`;
    sidePanel.style.background = barBg;
    $('#bottom-bar').style.background = barBg;
    document.documentElement.style.setProperty('--panel-bg', barBg);

    state.wpm = parseInt(ctrlSpeed.value);
    state.speed = wpmToPxPerSec();

    // Update value labels next to the sliders
    fontSizeVal.textContent = ctrlFontSize.value + 'px';
    widthVal.textContent = ctrlWidth.value + '%';
    lineHeightVal.textContent = (ctrlLineHeight.value / 100).toFixed(1) + '×';
    speedVal.textContent = ctrlSpeed.value + ' wpm';
    opacityVal.textContent = ctrlOpacity.value + '%';

    updateDayNightUI();
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
        wpm: ctrlSpeed.value,
        opacity: ctrlOpacity.value,
        mirrored: state.mirrored,
        panelWidth: state.panelWidth,
        panelCollapsed: sidePanel.classList.contains('collapsed')
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
    if (saved.fontSize) ctrlFontSize.value = saved.fontSize;
    if (saved.width) ctrlWidth.value = saved.width;
    if (saved.lineHeight) ctrlLineHeight.value = saved.lineHeight;
    if (saved.textColor) ctrlTextColor.value = saved.textColor;
    if (saved.bgColor) ctrlBgColor.value = saved.bgColor;
    // Note: pre-wpm versions saved `speed` in px/s — not comparable, so ignored
    if (saved.wpm) ctrlSpeed.value = saved.wpm;
    if (saved.opacity) ctrlOpacity.value = saved.opacity;
    if (saved.mirrored) toggleMirror();
    if (saved.panelWidth) {
        state.panelWidth = saved.panelWidth;
        sidePanel.style.width = state.panelWidth + 'px';
    }
    setPanelCollapsed(!!saved.panelCollapsed);
    applySettings();
}

ctrlFont.addEventListener('change', applySettings);
[ctrlFontSize, ctrlWidth, ctrlLineHeight, ctrlSpeed, ctrlOpacity].forEach(ctrl => {
    ctrl.addEventListener('input', applySettings);
});
ctrlTextColor.addEventListener('input', applySettings);
ctrlBgColor.addEventListener('input', applySettings);


// ===== DAY / NIGHT MODE =====

const btnDayNight = $('#btn-daynight');

// Perceived luminance of the current prompter background (0-255)
function bgLuminance() {
    const hex = ctrlBgColor.value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

// The button always offers the mode you'd switch TO
function updateDayNightUI() {
    const day = bgLuminance() > 128;
    document.body.classList.toggle('light-bg', day);
    btnDayNight.textContent = day ? '🌙' : '☀️';
    btnDayNight.title = day ? 'Switch to night mode (light text on dark)' : 'Switch to day mode (dark text on light)';
}

btnDayNight.addEventListener('click', () => {
    if (bgLuminance() > 128) {
        ctrlTextColor.value = '#ffffff';
        ctrlBgColor.value = '#000000';
    } else {
        ctrlTextColor.value = '#000000';
        ctrlBgColor.value = '#ffffff';
    }
    applySettings();
});


// ===== SCROLL MODE =====

function togglePlayPause() {
    if (state.playing) {
        stopScrolling();
    } else {
        startScrolling();
    }
}

function startScrolling() {
    if (!hasScript()) return;
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
    prompterContent.blur();
    window.getSelection().removeAllRanges();
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

    // Re-derive px/s each frame so window resizes keep the same wpm
    state.speed = wpmToPxPerSec();
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
    positionContent();
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
        document.documentElement.requestFullscreen();
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

    // Estimate the finish from the scroll distance left at the current speed
    const containerHeight = prompterContainer.offsetHeight;
    const contentHeight = prompterContent.scrollHeight;
    const maxScroll = (containerHeight * 0.7) + contentHeight;
    const remainingPx = Math.max(0, maxScroll - state.scrollPosition);

    let endsStr = '';
    if (state.speed > 0) {
        const remainingSec = remainingPx / state.speed;
        const finishAt = new Date(Date.now() + remainingSec * 1000);
        const clock = finishAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        endsStr = `${formatTime(Math.round(remainingSec))} left · ends ${clock}`;
    }

    timerDisplay.innerHTML =
        `<span class="timer-elapsed">${elapsedStr}</span>` +
        (endsStr ? `<span class="timer-ends">${endsStr}</span>` : '');
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


// ===== GOOGLE DOC IMPORT =====

function extractGoogleDocId(url) {
    // Match /document/d/XXXXX or /document/u/0/d/XXXXX
    const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// A tab id pinned in the URL, e.g. .../edit?tab=t.abc123
function extractGoogleDocTabId(url) {
    const match = url.match(/[?&#]tab=(t\.[a-z0-9]+)/i);
    return match ? match[1] : null;
}

function gdocExportUrl(docId, tabId) {
    // `tab` is undocumented, but it is how Docs exports one tab of a tabbed doc
    const base = `https://docs.google.com/document/d/${docId}/export?format=html`;
    return tabId ? `${base}&tab=${encodeURIComponent(tabId)}` : base;
}

async function fetchGoogleText(url) {
    let response;
    try {
        // In Electron, CORS isn't an issue; in browser, Google may block cross-origin
        response = await fetch(url);
    } catch (e) {
        // Fallback: try via a CORS proxy
        response = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`);
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Document not found. Check the URL is correct.');
        } else if (response.status === 401 || response.status === 403) {
            throw new Error('Access denied. Make sure the doc is shared as "Anyone with the link can view".');
        }
        throw new Error(`Failed to fetch document (HTTP ${response.status}).`);
    }

    return response.text();
}


// ----- Converting Google's export HTML into clean, structured script HTML -----

// Tags worth keeping: everything that carries structure a reader can see.
const GDOC_KEEP_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'BR',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'IMG',
    'STRONG', 'EM', 'U', 'S', 'SUP', 'SUB', 'A', 'CODE',
]);

const GDOC_KEEP_ATTRS = {
    IMG: ['src', 'alt'],
    A: ['href'],
    OL: ['start', 'type'],
    TD: ['colspan', 'rowspan'],
    TH: ['colspan', 'rowspan'],
};

// Google's export puts nearly all formatting in a <style> block keyed by
// generated class names (.c3{font-weight:700}), so those rules have to be read
// before the markup means anything — bold, italics and indents all live there.
function parseGdocStylesheet(doc) {
    const rules = {};
    doc.querySelectorAll('style').forEach(styleEl => {
        const css = (styleEl.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '');
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let match;
        while ((match = ruleRe.exec(css)) !== null) {
            const decls = {};
            match[2].split(';').forEach(decl => {
                const colon = decl.indexOf(':');
                if (colon > 0) {
                    decls[decl.slice(0, colon).trim().toLowerCase()] = decl.slice(colon + 1).trim();
                }
            });
            match[1].split(',').forEach(sel => {
                const cls = sel.trim().match(/^\.([A-Za-z0-9_-]+)$/);
                if (cls) rules[cls[1]] = Object.assign(rules[cls[1]] || {}, decls);
            });
        }
    });
    return rules;
}

const GDOC_STYLE_PROPS = ['font-weight', 'font-style', 'text-decoration',
    'text-decoration-line', 'margin-left', 'text-align', 'vertical-align'];

// An element's effective style: its class rules, then its own inline style
function gdocEffectiveStyle(el, rules) {
    const style = {};
    (el.getAttribute('class') || '').split(/\s+/).forEach(cls => {
        if (cls && rules[cls]) Object.assign(style, rules[cls]);
    });
    GDOC_STYLE_PROPS.forEach(prop => {
        const val = el.style && el.style.getPropertyValue(prop);
        if (val) style[prop] = val;
    });
    return style;
}

// Only elements that directly hold text get formatting tags, so a bold run
// inside a paragraph doesn't also bold the paragraph around it.
function hasDirectText(el) {
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return true;
    }
    return false;
}

// Carry the doc's indent levels across (Google indents by 36pt / 48px a level)
function markGdocIndent(el, style) {
    const raw = style['margin-left'];
    if (!raw) return;
    const amount = parseFloat(raw);
    if (!amount || amount < 0) return;
    const perLevel = raw.includes('pt') ? 36 : 48;
    const level = Math.min(6, Math.round(amount / perLevel));
    if (level > 0) el.setAttribute('data-indent', String(level));
}

function cleanGoogleDocHtml(rawHtml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');
    const body = doc.body;
    if (!body) return '';

    // Read the stylesheet before dropping it — the class names are the formatting
    const rules = parseGdocStylesheet(doc);
    doc.querySelectorAll('style, script, meta, link, noscript').forEach(el => el.remove());

    // Turn Google's class- and style-driven formatting into semantic tags
    Array.from(body.querySelectorAll('*')).forEach(el => {
        const style = gdocEffectiveStyle(el, rules);
        if (/^(P|H[1-6]|LI|UL|OL|BLOCKQUOTE)$/.test(el.tagName)) markGdocIndent(el, style);
        if (!hasDirectText(el)) return;

        const decoration = style['text-decoration'] || style['text-decoration-line'] || '';
        const weight = parseInt(style['font-weight'], 10);
        const wraps = [];
        if (style['font-weight'] === 'bold' || weight >= 600) wraps.push('strong');
        if (style['font-style'] === 'italic') wraps.push('em');
        if (decoration.includes('underline') && el.tagName !== 'A') wraps.push('u');
        if (decoration.includes('line-through')) wraps.push('s');
        if (style['vertical-align'] === 'super') wraps.push('sup');
        else if (style['vertical-align'] === 'sub') wraps.push('sub');

        wraps.forEach(tag => {
            const wrapper = doc.createElement(tag);
            while (el.firstChild) wrapper.appendChild(el.firstChild);
            el.appendChild(wrapper);
        });
    });

    // Nested bullets: Google indents the list, not the item — move it to the items
    body.querySelectorAll('ul[data-indent], ol[data-indent]').forEach(list => {
        const level = parseInt(list.getAttribute('data-indent'), 10) - 1;
        list.removeAttribute('data-indent');
        if (level <= 0) return;
        Array.from(list.children).forEach(li => {
            if (li.tagName === 'LI' && !li.hasAttribute('data-indent')) {
                li.setAttribute('data-indent', String(level));
            }
        });
    });

    // Links come through Google's redirector — point them at the real target
    body.querySelectorAll('a[href]').forEach(a => {
        const match = a.getAttribute('href').match(/^https?:\/\/www\.google\.com\/url\?q=([^&]+)/);
        if (match) {
            try { a.setAttribute('href', decodeURIComponent(match[1])); } catch (e) { /* leave as-is */ }
        }
    });

    // Unwrap everything else (spans, the doc-content div, …), keeping its text
    Array.from(body.querySelectorAll('*')).reverse().forEach(el => {
        if (!GDOC_KEEP_TAGS.has(el.tagName)) el.replaceWith(...el.childNodes);
    });

    // Drop Google's styling attributes; the prompter does its own
    body.querySelectorAll('*').forEach(el => {
        const keep = GDOC_KEEP_ATTRS[el.tagName] || [];
        Array.from(el.attributes).forEach(attr => {
            if (attr.name !== 'data-indent' && !keep.includes(attr.name)) {
                el.removeAttribute(attr.name);
            }
        });
    });

    // Drop blank blocks, but keep image-only ones (charts have no text)
    body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote').forEach(el => {
        if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
    });
    body.querySelectorAll('ul, ol, table').forEach(el => {
        if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
    });

    return body.innerHTML.trim();
}

// Google mints new class names and re-signs image URLs on every export, so the
// raw HTML always looks different. Compare words and structure instead, or the
// prompter rebuilds itself every poll and the reader sees the script jump.
function gdocFingerprint(html) {
    return html.replace(/<img[^>]*>/gi, '<img>').replace(/\s+/g, ' ').trim();
}


// ----- Tabs -----

// There is no way to list a doc's tabs without OAuth, so pull candidate tab ids
// out of the doc's own pages and confirm each by exporting it: ids that aren't
// real export the default tab, so identical exports collapse back to one entry.
async function discoverGoogleDocTabIds(docId) {
    const pages = [
        `https://docs.google.com/document/d/${docId}/edit`,
        `https://docs.google.com/document/d/${docId}/mobilebasic`,
        `https://docs.google.com/document/d/${docId}/preview`,
    ];

    for (const url of pages) {
        let html;
        try {
            html = await fetchGoogleText(url);
        } catch (e) {
            continue;
        }
        const ids = [];
        const idRe = /["'/](t\.[a-z0-9]{1,24})["'&]/gi;
        let match;
        while ((match = idRe.exec(html)) !== null) {
            if (!ids.includes(match[1])) ids.push(match[1]);
        }
        if (ids.length > 1) return ids;
    }
    return [];
}

// A label for the tab list: the tab's opening line, which for most scripts is
// its heading — falling back to the start of the text if there are no blocks.
function gdocFirstLine(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let text = '';
    for (const el of doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li')) {
        text = el.textContent.trim().replace(/\s+/g, ' ');
        if (text) break;
    }
    if (!text) text = (doc.body.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) return 'Untitled tab';
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

// Returns [{ id, title, html }] for a tabbed doc, or [] when there's only one tab
async function fetchGoogleDocTabs(docId) {
    const ids = await discoverGoogleDocTabIds(docId);
    if (ids.length < 2) return [];

    const fetched = await Promise.all(ids.slice(0, 12).map(async id => {
        try {
            const html = cleanGoogleDocHtml(await fetchGoogleText(gdocExportUrl(docId, id)));
            return html ? { id, html, print: gdocFingerprint(html) } : null;
        } catch (e) {
            return null;
        }
    }));

    const tabs = [];
    const seen = new Set();
    fetched.forEach(tab => {
        if (!tab || seen.has(tab.print)) return;
        seen.add(tab.print);
        tabs.push({ id: tab.id, html: tab.html, title: gdocFirstLine(tab.html) });
    });
    return tabs.length > 1 ? tabs : [];
}

// The script for a doc: one named tab of it, or the doc's default (first) tab
async function fetchGoogleDocHtml(docId, tabId) {
    return cleanGoogleDocHtml(await fetchGoogleText(gdocExportUrl(docId, tabId)));
}

// ===== SENTENCE ANCHORING =====
// When a synced Google Doc update replaces the script mid-read, keep the
// sentence at the reading guide line in place rather than the pixel offset,
// so edits above the eyeline don't shift the text being read.

const EYELINE_FRACTION = 0.3; // matches #prompter-container::after in style.css

function splitSentences(text) {
    return text.split(/(?<=[.!?…])\s+/).filter(s => s.trim());
}

// Identify the sentence (and paragraph) currently at the reading guide line
function captureScrollAnchor() {
    if (state.scrollPosition <= 0) return null; // haven't started reading

    const containerRect = prompterContainer.getBoundingClientRect();
    const contentRect = prompterContent.getBoundingClientRect();
    const x = containerRect.left + containerRect.width / 2;
    const y = containerRect.top + containerRect.height * EYELINE_FRACTION;
    const contentY = y - contentRect.top; // eyeline in content coordinates
    if (contentY < 0) return null; // text hasn't reached the guide line yet

    // Sentence under the eyeline, via the caret position at that point
    let sentence = null;
    const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (caret && caret.startContainer.nodeType === Node.TEXT_NODE &&
        prompterContent.contains(caret.startContainer)) {
        const paraEl = caret.startContainer.parentElement.closest('[data-para-index]');
        if (paraEl) {
            // Character offset of the caret within the paragraph's text
            let charOffset = caret.startOffset;
            const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT);
            while (walker.nextNode() && walker.currentNode !== caret.startContainer) {
                charOffset += walker.currentNode.textContent.length;
            }
            const paraText = paraEl.textContent;
            let pos = 0;
            for (const s of splitSentences(paraText)) {
                pos = paraText.indexOf(s, pos);
                if (charOffset < pos + s.length) { sentence = s.trim(); break; }
                pos += s.length;
            }
        }
    }

    // Paragraph spanning the eyeline (fuzzy-match fallback if the sentence was edited)
    let para = null;
    for (const p of state.paragraphs) {
        const top = p.element.offsetTop;
        if (contentY >= top && contentY < top + p.element.offsetHeight) { para = p; break; }
        if (top > contentY) { para = p; break; } // eyeline is in the gap above this paragraph
    }

    return {
        sentence,
        contentY,
        paraText: para ? para.text : null,
        paraFraction: para
            ? (contentY - para.element.offsetTop) / Math.max(1, para.element.offsetHeight)
            : 0,
    };
}

// Find the anchored sentence in the new content; returns its y offset in
// content coordinates, or null. Prefers the occurrence nearest the old position.
function findSentenceY(sentence, oldY) {
    const nodes = [];
    let fullText = '';
    const walker = document.createTreeWalker(prompterContent, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        nodes.push({ node: walker.currentNode, start: fullText.length });
        fullText += walker.currentNode.textContent;
    }
    if (!fullText) return null;

    // Whitespace-tolerant match on the sentence's words
    const words = sentence.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(words.join('\\s+'), 'g');
    const contentTop = prompterContent.getBoundingClientRect().top;
    const nodeAt = (offset) => {
        let entry = nodes[0];
        for (const n of nodes) { if (n.start <= offset) entry = n; else break; }
        return entry;
    };

    let best = null;
    let m;
    while ((m = re.exec(fullText)) !== null) {
        // Map the match's character range back to text nodes and measure it
        const startEntry = nodeAt(m.index);
        const endOffset = m.index + m[0].length;
        const endEntry = nodeAt(endOffset - 1);
        const range = document.createRange();
        range.setStart(startEntry.node, m.index - startEntry.start);
        range.setEnd(endEntry.node,
            Math.min(endEntry.node.textContent.length, endOffset - endEntry.start));
        const rect = range.getBoundingClientRect();
        if (!rect.height) continue;
        const yPos = rect.top - contentTop;
        if (best === null || Math.abs(yPos - oldY) < Math.abs(best - oldY)) best = yPos;
    }
    return best;
}

// Fallback: best word-overlap paragraph match, at the same relative depth
function findParagraphY(paraText, fraction) {
    const targetWords = new Set(paraText.toLowerCase().split(/\s+/));
    let best = null;
    let bestScore = 0.5; // require a majority overlap to accept
    for (const p of state.paragraphs) {
        const pWords = p.text.toLowerCase().split(/\s+/);
        if (!pWords.length) continue;
        let hits = 0;
        for (const w of pWords) if (targetWords.has(w)) hits++;
        const score = hits / Math.max(pWords.length, targetWords.size);
        if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return null;
    return best.element.offsetTop + fraction * best.element.offsetHeight;
}

// Re-align the scroll so the anchored sentence sits back on the guide line
function restoreScrollAnchor(anchor) {
    if (!anchor) return; // keep the pixel position setScript already applied

    let newY = anchor.sentence ? findSentenceY(anchor.sentence, anchor.contentY) : null;
    if (newY === null && anchor.paraText) {
        newY = findParagraphY(anchor.paraText, anchor.paraFraction);
    }
    if (newY === null) return; // anchor text was edited away — keep pixel position

    const containerHeight = prompterContainer.offsetHeight;
    const startPosition = containerHeight * 0.7;
    const eyeline = containerHeight * EYELINE_FRACTION;
    const maxScroll = startPosition + prompterContent.scrollHeight;
    state.scrollPosition = Math.min(maxScroll,
        Math.max(0, startPosition - eyeline + newY));
    positionContent();
    updateProgress(state.scrollPosition, maxScroll);
}

// Apply a Google Doc update to the prompter, preserving the reading position.
// `force` is for the times the user asked for it (an import, a manual refresh),
// where the script should land even if the doc is byte-for-byte what we last saw.
function applyGoogleDocContent(html, { force = false } = {}) {
    // Skip if the words and structure haven't changed — see gdocFingerprint
    const print = gdocFingerprint(html);
    if (print === state.gdocLastPrint && !force) return false;
    state.gdocLastPrint = print;

    const anchor = captureScrollAnchor();
    setScript(stripEmptyParagraphs(html), { keepScroll: true });
    restoreScrollAnchor(anchor);
    return true;
}

function startGdocPolling() {
    stopGdocPolling();
    // Poll every 10 seconds
    state.gdocPollInterval = setInterval(async () => {
        if (!state.googleDocId) return;
        // Don't overwrite the script out from under someone typing in it
        if (document.activeElement === prompterContent) return;
        try {
            const html = await fetchGoogleDocHtml(state.googleDocId, state.googleDocTabId);
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

function linkGoogleDoc(docId, tabId, html, tabs) {
    state.googleDocId = docId;
    state.googleDocTabId = tabId || null;
    state.gdocTabs = tabs || [];
    state.gdocLastPrint = gdocFingerprint(html);
    updateGdocLinkUI();
    startGdocPolling();
}

function unlinkGoogleDoc() {
    stopGdocPolling();
    state.googleDocId = null;
    state.googleDocTabId = null;
    state.gdocTabs = [];
    state.gdocLastPrint = '';
    updateGdocLinkUI();
}

// Show/hide the linked-doc badge
function updateGdocLinkUI() {
    const badge = $('#gdoc-linked-badge');
    if (state.googleDocId) {
        badge.classList.remove('hidden');
        const tab = state.gdocTabs.find(t => t.id === state.googleDocTabId);
        badge.title = (tab ? `Reading tab “${tab.title}”. ` : '') +
            'Click to refresh · Right-click to unlink';
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
        const html = await fetchGoogleDocHtml(state.googleDocId, state.googleDocTabId);
        if (html) applyGoogleDocContent(html, { force: true });
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
const gdocTabList = $('#gdoc-tabs');
const gdocImportBtn = $('#btn-gdoc-import');

function hideGdocTabList() {
    gdocTabList.innerHTML = '';
    gdocTabList.classList.add('hidden');
    gdocImportBtn.classList.remove('hidden');
}

// Load one tab of a linked doc into the prompter
function useGdocTab(docId, tabs, tab) {
    applyGoogleDocContent(tab.html, { force: true });
    linkGoogleDoc(docId, tab.id, tab.html, tabs);
    showGdocTabList(docId, tabs);
}

// The doc's other tabs, offered after the first one has already been imported.
// Nothing to dismiss and nothing to choose — this is just how you switch.
function showGdocTabList(docId, tabs) {
    gdocTabList.innerHTML = '';
    gdocImportBtn.classList.add('hidden');
    const showing = tabs.findIndex(t => t.id === state.googleDocTabId) + 1;
    gdocStatus.textContent =
        `Showing tab ${showing || 1} of ${tabs.length}. Pick another to switch.`;

    tabs.forEach((tab, i) => {
        const btn = document.createElement('button');
        btn.className = 'gdoc-tab-choice';
        if (tab.id === state.googleDocTabId) btn.classList.add('current');
        btn.innerHTML = `<span class="gdoc-tab-num">${i + 1}</span>`;
        btn.appendChild(document.createTextNode(tab.title));
        btn.addEventListener('click', () => useGdocTab(docId, tabs, tab));
        gdocTabList.appendChild(btn);
    });

    gdocTabList.classList.remove('hidden');
}

$('#btn-gdoc').addEventListener('click', () => {
    gdocStatus.textContent = '';
    hideGdocTabList();
    // Re-opening a linked multi-tab doc goes straight back to its tab list
    if (state.googleDocId && state.gdocTabs.length > 1) {
        gdocUrlInput.value = `https://docs.google.com/document/d/${state.googleDocId}/edit`;
        showGdocTabList(state.googleDocId, state.gdocTabs);
    } else {
        gdocUrlInput.value = '';
    }
    gdocModal.classList.remove('hidden');
    gdocUrlInput.focus();
});

$('#btn-gdoc-cancel').addEventListener('click', () => {
    gdocModal.classList.add('hidden');
});

gdocModal.addEventListener('click', (e) => {
    if (e.target === gdocModal) gdocModal.classList.add('hidden');
});

gdocImportBtn.addEventListener('click', async () => {
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
    gdocImportBtn.disabled = true;

    try {
        // A URL that names a tab means the choice is already made
        const pinnedTab = extractGoogleDocTabId(url);

        // Look for tabs while the doc itself downloads — most docs have one tab,
        // and this way looking costs no extra wait
        const [content, tabSearch] = await Promise.allSettled([
            fetchGoogleDocHtml(docId, pinnedTab),
            pinnedTab ? Promise.resolve([]) : fetchGoogleDocTabs(docId),
        ]);

        // A tabbed doc reads its first tab; the rest are one click away
        const tabs = tabSearch.status === 'fulfilled' ? tabSearch.value : [];
        if (tabs.length > 1) {
            useGdocTab(docId, tabs, tabs[0]);
            return;
        }

        if (content.status === 'rejected') throw content.reason;
        const html = content.value;
        if (!html) {
            throw new Error('The document appears to be empty.');
        }
        applyGoogleDocContent(html, { force: true });
        linkGoogleDoc(docId, pinnedTab, html, []);
        gdocModal.classList.add('hidden');
    } catch (err) {
        gdocStatus.textContent = err.message;
    } finally {
        gdocImportBtn.disabled = false;
    }
});

// Typing a different URL puts the Import button back in place of the tab list
gdocUrlInput.addEventListener('input', () => {
    if (!gdocTabList.classList.contains('hidden')) {
        hideGdocTabList();
        gdocStatus.textContent = '';
    }
});

// Allow Enter key to trigger import
gdocUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        gdocImportBtn.click();
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


// ===== MOUSE & TOUCH CONTROLS =====

// Mouse wheel scrubs through the script
prompterContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY * 0.5;
    state.scrollPosition = Math.max(0, state.scrollPosition + delta);
    positionContent();
}, { passive: false });

// Touch drag scrubs through the script
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
    positionContent();
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
                applySettings();
                break;
            case 'scroll':
                if (value === 'up') {
                    state.scrollPosition = Math.max(0, state.scrollPosition - 100);
                } else {
                    state.scrollPosition += 100;
                }
                positionContent();
                break;
        }
    };
}

initRemoteControl();


// ===== KEYBOARD SHORTCUTS =====

document.addEventListener('keydown', (e) => {
    // While typing in the script (paused, caret in text): only Esc, which
    // leaves editing so the shortcuts work again
    if (document.activeElement === prompterContent &&
        prompterContent.getAttribute('contenteditable') === 'true' &&
        !state.playing) {
        if (e.key === 'Escape') prompterContent.blur();
        return;
    }

    // Ignore shortcuts while typing in panel inputs or the modal
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    switch (e.key) {
        case ' ':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'ArrowUp':
            e.preventDefault();
            ctrlSpeed.value = Math.min(parseInt(ctrlSpeed.max), parseInt(ctrlSpeed.value) + 10);
            applySettings();
            break;
        case 'ArrowDown':
            e.preventDefault();
            ctrlSpeed.value = Math.max(parseInt(ctrlSpeed.min), parseInt(ctrlSpeed.value) - 10);
            applySettings();
            break;
        case 'ArrowLeft':
            e.preventDefault();
            state.scrollPosition = Math.max(0, state.scrollPosition - 100);
            positionContent();
            break;
        case 'ArrowRight':
            e.preventDefault();
            state.scrollPosition += 100;
            positionContent();
            break;
        case '.': {
            // Nudge forward one line
            const lineH = parseInt(ctrlFontSize.value) * (parseInt(ctrlLineHeight.value) / 100);
            state.scrollPosition += lineH;
            positionContent();
            break;
        }
        case ',': {
            // Nudge back one line
            const lineH = parseInt(ctrlFontSize.value) * (parseInt(ctrlLineHeight.value) / 100);
            state.scrollPosition = Math.max(0, state.scrollPosition - lineH);
            positionContent();
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
            applySettings();
            break;
        case ']':
            ctrlOpacity.value = Math.min(100, parseInt(ctrlOpacity.value) + 10);
            applySettings();
            break;
        case '?':
            keyboardHints.classList.toggle('hidden');
            break;
        case 'Escape':
            keyboardHints.classList.add('hidden');
            helpModal.classList.add('hidden');
            if (!welcomeModal.classList.contains('hidden')) dismissWelcome();
            break;
    }
});


// ===== PANEL & BUTTONS =====

btnPlayPause.addEventListener('click', togglePlayPause);
btnReset.addEventListener('click', resetScroll);
btnFullscreen.addEventListener('click', toggleFullscreen);
btnMirror.addEventListener('click', toggleMirror);

btnClear.addEventListener('click', () => {
    prompterContent.innerHTML = '<p><br></p>';
    state.editedScript = '';
    updateWordCount();
    resetScroll();
    prompterContent.focus();
});

// Chevron button shows/hides the right panel
const btnToggleSettings = $('#btn-toggle-settings');

function setPanelCollapsed(collapsed) {
    sidePanel.classList.toggle('collapsed', collapsed);
    $('#panel-resizer').classList.toggle('collapsed', collapsed);
    btnToggleSettings.innerHTML = collapsed ? '&laquo;' : '&raquo;';
    btnToggleSettings.title = collapsed ? 'Show panel' : 'Hide panel';
}

btnToggleSettings.addEventListener('click', () => {
    setPanelCollapsed(!sidePanel.classList.contains('collapsed'));
    saveSettings();
});

// Drag the panel's left edge to resize it
$('#panel-resizer').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidePanel.offsetWidth;
    const onMove = (ev) => {
        state.panelWidth = Math.min(500, Math.max(170, startWidth + (startX - ev.clientX)));
        sidePanel.style.width = state.panelWidth + 'px';
    };
    const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.classList.remove('resizing-panel');
        saveSettings();
    };
    document.body.classList.add('resizing-panel');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
});


// ===== DEMO SCRIPT =====

function loadDemoScript() {
    setScript(`
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
<p>[Q&amp;A — aim for 15 minutes]</p>
`.trim());
}

$('#btn-demo').addEventListener('click', loadDemoScript);


// ===== FIRST-RUN WELCOME =====
// Quick lesson shown once, the first time the app is opened

const WELCOME_KEY = 'teleprompter_welcome_seen';
const welcomeModal = $('#welcome-modal');

function dismissWelcome() {
    welcomeModal.classList.add('hidden');
    localStorage.setItem(WELCOME_KEY, '1');
}

$('#btn-welcome-close').addEventListener('click', dismissWelcome);

$('#btn-welcome-demo').addEventListener('click', () => {
    dismissWelcome();
    loadDemoScript();
});

welcomeModal.addEventListener('click', (e) => {
    if (e.target === welcomeModal) dismissWelcome();
});

function maybeShowWelcome() {
    if (!localStorage.getItem(WELCOME_KEY)) {
        welcomeModal.classList.remove('hidden');
    }
}


// ===== HELP MODAL =====

const helpModal = $('#help-modal');

$('#btn-help').addEventListener('click', () => {
    helpModal.classList.remove('hidden');
});

$('#btn-help-close').addEventListener('click', () => {
    helpModal.classList.add('hidden');
});

helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) helpModal.classList.add('hidden');
});


// ===== INIT =====

// Restore saved preferences from the previous session, then apply them
// (loadSettings skips applySettings when nothing is saved yet)
loadSettings();
applySettings();

// Show the quick lesson on the very first open
maybeShowWelcome();

// Put the (placeholder) content in its starting position
requestAnimationFrame(positionContent);

// Version stamp
const VERSION_TIMESTAMP = '2026-09-09 v11 — Google Doc tabs, formatting, steadier sync';
document.getElementById('version-stamp').textContent = VERSION_TIMESTAMP;
