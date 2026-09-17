// Rasterizes favicon.svg into PNG icons, a multi-resolution Windows .ico, and the 1024px PNG
// electron-builder converts into the macOS .icns.
// Run with the bundled Electron:  node_modules/.bin/electron tools/make-icons.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function run() {
    const win = new BrowserWindow({
        show: false,
        width: 600,
        height: 600,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadFile(path.join(__dirname, 'make-icons.html'));

    ipcMain.on('icons-done', (_e, msg) => {
        console.log('OK: ' + msg);
        app.quit();
    });
    ipcMain.on('icons-error', (_e, msg) => {
        console.error('ICON BUILD FAILED:\n' + msg);
        process.exitCode = 1;
        app.quit();
    });
}

app.whenReady().then(run);
app.on('window-all-closed', () => app.quit());
