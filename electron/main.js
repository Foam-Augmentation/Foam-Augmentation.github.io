// Desktop app entry point (Electron main process).
//
// It shows the same page as the web build (dist/index.html) and adds one thing the browser cannot
// do: run PrusaSlicer. The page asks for that through the bridge in preload.js; this process
// checks the request, writes the parts and settings to a temporary folder, runs PrusaSlicer's
// command line on them and hands the G-code back.
//
// PrusaSlicer is run as a separate program and is not part of this app. Its path, and an optional
// PrusaSlicer profile to slice with, are chosen from the Slicer menu and kept in the app's
// settings file.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** How long PrusaSlicer may run before it is stopped (ms). */
const SLICE_TIMEOUT_MS = 5 * 60 * 1000;
/** The most output (bytes) kept from PrusaSlicer's console, for error messages. */
const MAX_CONSOLE_OUTPUT = 16 * 1024 * 1024;
/** The largest STL (bytes) the page may send for one part. */
const MAX_STL_BYTES = 512 * 1024 * 1024;
/** The most parts one request may contain. */
const MAX_PARTS = 256;

const PAGE = path.join(__dirname, '..', 'dist', 'index.html');

// --- settings ---------------------------------------------------------------------------------

function settingsFile() {
    return path.join(app.getPath('userData'), 'slicer-settings.json');
}

function readSettings() {
    try {
        return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch {
        return {};
    }
}

function writeSettings(settings) {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** Where PrusaSlicer is usually installed. The console build is preferred on Windows: it prints errors. */
function defaultPrusaSlicerPaths() {
    const candidates = [];
    if (process.env.PRUSA_SLICER_PATH) {
        candidates.push(process.env.PRUSA_SLICER_PATH);
    }
    if (process.platform === 'win32') {
        for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
            candidates.push(path.join(root, 'Prusa3D', 'PrusaSlicer', 'prusa-slicer-console.exe'));
            candidates.push(path.join(root, 'PrusaSlicer', 'prusa-slicer-console.exe'));
        }
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer');
        candidates.push(path.join(os.homedir(), 'Applications', 'PrusaSlicer.app', 'Contents', 'MacOS', 'PrusaSlicer'));
    } else {
        for (const dir of (process.env.PATH || '').split(path.delimiter)) {
            candidates.push(path.join(dir, 'prusa-slicer'));
        }
        candidates.push('/usr/bin/prusa-slicer', '/usr/local/bin/prusa-slicer');
    }
    return candidates;
}

/** The PrusaSlicer executable to run: the one the user chose, or the first one installed in a usual place. */
function findPrusaSlicer() {
    const chosen = readSettings().prusaSlicerPath;
    if (chosen && isFile(chosen)) {
        return chosen;
    }
    return defaultPrusaSlicerPaths().find(isFile);
}

function getStatus() {
    const executable = findPrusaSlicer();
    const profile = readSettings().profilePath;
    return {
        available: Boolean(executable),
        path: executable,
        profile: profile && isFile(profile) ? profile : undefined,
    };
}

// --- slicing ----------------------------------------------------------------------------------

/** Checks a request from the page. The page is our own, but it is still the less trusted side. */
function validateRequest(request) {
    if (!request || typeof request !== 'object') {
        throw new Error('The slicing request is empty.');
    }
    const { parts, ini } = request;
    if (typeof ini !== 'string' || ini.length > 1024 * 1024) {
        throw new Error('The slicing request has no valid settings.');
    }
    for (const line of ini.split('\n')) {
        if (line !== '' && !/^[a-z0-9_]+ = [^\r\n]*$/.test(line)) {
            throw new Error(`The slicing request has a settings line that is not "key = value": ${line.slice(0, 80)}`);
        }
    }
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
        throw new Error('The slicing request has no parts.');
    }
    for (const part of parts) {
        if (!(part && part.stl instanceof Uint8Array) || part.stl.byteLength < 84 || part.stl.byteLength > MAX_STL_BYTES) {
            throw new Error('A part in the slicing request is not a valid STL file.');
        }
    }
}

function runPrusaSlicer(executable, args) {
    return new Promise((resolve, reject) => {
        execFile(executable, args, { timeout: SLICE_TIMEOUT_MS, maxBuffer: MAX_CONSOLE_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                const output = `${stderr}\n${stdout}`.trim().split(/\r?\n/).slice(-15).join('\n');
                const why = error.killed ? 'it took too long and was stopped' : `it exited with code ${error.code}`;
                reject(new Error(`PrusaSlicer could not slice the parts: ${why}.${output ? '\n' + output : ''}`));
            } else {
                resolve();
            }
        });
    });
}

async function slice(request) {
    validateRequest(request);
    const executable = findPrusaSlicer();
    if (!executable) {
        throw new Error('PrusaSlicer was not found. Choose it under Slicer → Locate PrusaSlicer….');
    }
    const { profile } = getStatus();

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'foam-prusa-'));
    try {
        const iniPath = path.join(folder, 'settings.ini');
        fs.writeFileSync(iniPath, request.ini);
        const stlPaths = request.parts.map((part, i) => {
            const file = path.join(folder, `part-${i}.stl`);
            fs.writeFileSync(file, part.stl);
            return file;
        });
        const output = path.join(folder, 'out.gcode');

        const args = [
            '--export-gcode',
            // Slice every part as one plate, where they are: no centring or arranging.
            '--merge',
            '--dont-arrange',
            // The user's profile first, so our settings win wherever both set something.
            ...(profile ? ['--load', profile] : []),
            '--load', iniPath,
            '--output', output,
            ...stlPaths,
        ];
        await runPrusaSlicer(executable, args);
        return { gcode: fs.readFileSync(output, 'utf8') };
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
}

// --- window and menu --------------------------------------------------------------------------

async function chooseFile(window, title, filters, key) {
    const result = await dialog.showOpenDialog(window, { title, properties: ['openFile'], filters });
    if (result.canceled || !result.filePaths.length) {
        return;
    }
    writeSettings({ ...readSettings(), [key]: result.filePaths[0] });
}

function buildMenu(window) {
    const status = getStatus();
    const slicerMenu = {
        label: 'Slicer',
        submenu: [
            { label: status.path ? `PrusaSlicer: ${status.path}` : 'PrusaSlicer: not found', enabled: false },
            { label: `Profile: ${status.profile ?? 'PrusaSlicer defaults'}`, enabled: false },
            { type: 'separator' },
            {
                label: 'Locate PrusaSlicer…',
                click: async () => {
                    const filters = process.platform === 'win32'
                        ? [{ name: 'PrusaSlicer', extensions: ['exe'] }]
                        : [{ name: 'All files', extensions: ['*'] }];
                    await chooseFile(window, 'Choose the PrusaSlicer program (prusa-slicer-console.exe on Windows)', filters, 'prusaSlicerPath');
                    buildMenu(window);
                },
            },
            {
                label: 'Choose PrusaSlicer Profile…',
                click: async () => {
                    await chooseFile(window, 'Choose a PrusaSlicer config (.ini) to slice with', [{ name: 'PrusaSlicer config', extensions: ['ini'] }], 'profilePath');
                    buildMenu(window);
                },
            },
            {
                label: 'Use PrusaSlicer Defaults',
                enabled: Boolean(status.profile),
                click: () => {
                    const { profilePath, ...rest } = readSettings();
                    writeSettings(rest);
                    buildMenu(window);
                },
            },
        ],
    };
    const template = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        slicerMenu,
        { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
    const window = new BrowserWindow({
        width: 1440,
        height: 900,
        backgroundColor: '#1b1d22',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });

    // The app is one local page. Links to anything else open in the user's browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('file:')) {
            event.preventDefault();
            if (/^https?:/.test(url)) {
                shell.openExternal(url);
            }
        }
    });

    buildMenu(window);
    window.loadFile(PAGE);
}

ipcMain.handle('prusa:status', () => getStatus());
ipcMain.handle('prusa:slice', (_event, request) => slice(request));

app.whenReady().then(() => {
    if (!isFile(PAGE)) {
        dialog.showErrorBox('Page not built', 'dist/index.html is missing. Run "npm run build" first.');
        app.quit();
        return;
    }
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
