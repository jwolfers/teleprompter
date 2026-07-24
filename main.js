const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

let win;

const boundsFile = () => path.join(app.getPath('userData'), 'window-bounds.json');

function loadBounds() {
    // screen module is only usable after app ready, so require it here
    const { screen } = require('electron');
    try {
        const bounds = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
        // Only restore if the window still overlaps a connected display
        const visible = screen.getAllDisplays().some(d =>
            bounds.x < d.bounds.x + d.bounds.width &&
            bounds.x + bounds.width > d.bounds.x &&
            bounds.y < d.bounds.y + d.bounds.height &&
            bounds.y + bounds.height > d.bounds.y
        );
        if (visible) return bounds;
    } catch (e) {
        // No saved bounds yet, or file unreadable — use defaults
    }
    return null;
}

function saveBounds() {
    if (!win) return;
    try {
        fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
    } catch (e) {
        // Non-fatal — window position just won't be remembered
    }
}

function createWindow() {
    const bounds = loadBounds();
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

    win.loadFile('index.html');

    win.on('close', saveBounds);

    win.on('closed', () => {
        win = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});
