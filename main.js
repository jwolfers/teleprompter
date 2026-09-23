const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let win;

const boundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json');

function loadBounds() {
    // screen module is only usable after app ready, so require it here
    const { screen } = require('electron');
    try {
        const saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
        const bounds = saved.bounds || saved;   // older files stored bounds bare
        // Only restore if the window still overlaps a connected display
        const visible = screen.getAllDisplays().some(d =>
            bounds.x < d.bounds.x + d.bounds.width &&
            bounds.x + bounds.width > d.bounds.x &&
            bounds.y < d.bounds.y + d.bounds.height &&
            bounds.y + bounds.height > d.bounds.y
        );
        if (visible) return { bounds, maximized: !!saved.maximized };
    } catch (e) {
        // No saved bounds yet, or file unreadable — use defaults
    }
    return null;
}

function saveBounds() {
    if (!win || win.isDestroyed()) return;
    try {
        // getNormalBounds is the un-maximized size, so restoring from maximized
        // gives back the window you had rather than a full-screen-sized one
        fs.writeFileSync(boundsFile(), JSON.stringify({
            bounds: win.getNormalBounds(),
            maximized: win.isMaximized(),
        }));
    } catch (e) {
        // Non-fatal — window position just won't be remembered
    }
}

// Saving only on close loses the layout whenever the app is force-quit or
// crashes, which is how it usually goes. Save as the window settles instead.
let saveBoundsTimer = null;
function saveBoundsSoon() {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(saveBounds, 400);
}

function createWindow() {
    const saved = loadBounds();
    const bounds = saved ? saved.bounds : null;
    win = new BrowserWindow({
        width: bounds ? bounds.width : 1200,
        height: bounds ? bounds.height : 800,
        x: bounds ? bounds.x : undefined,
        y: bounds ? bounds.y : undefined,
        icon: path.join(__dirname, 'icon.ico'),
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // On macOS a plain always-on-top window drops behind full-screen apps and stays
    // on the Space it was opened in. Float it above everything, on every Space, so it
    // behaves like the Windows build: a see-through overlay over whatever you're recording.
    if (process.platform === 'darwin') {
        win.setAlwaysOnTop(true, 'floating');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    win.loadFile('index.html');

    if (saved && saved.maximized) win.maximize();

    win.on('resize', saveBoundsSoon);
    win.on('move', saveBoundsSoon);
    win.on('maximize', saveBoundsSoon);
    win.on('unmaximize', saveBoundsSoon);
    win.on('close', saveBounds);

    win.on('closed', () => {
        clearTimeout(saveBoundsTimer);
        win = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});
