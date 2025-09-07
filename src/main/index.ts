// @ts-nocheck

import {
    app,
    shell,
    session,
    clipboard,
    nativeImage,
    desktopCapturer,
    BrowserWindow,
    globalShortcut,
    Notification,
    Menu,
    ipcMain,
    Tray,
} from "electron";
import path, { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import {
    openSnippingTool,
    waitForNewClipboardImage,
    getClipboardImageHash,
    saveImage,
    handleHotkey,
    registerMainWindowGetter,
} from './printscreen'

import {
    getLogFilePath,
    checkUrlAndOpen,
    getConfig,
    getServerLog,
    installPackage,
    installPython,
    isPackageInstalled,
    isPythonInstalled,
    isUvInstalled,
    openUrl,
    resetApp,
    setConfig,
    startServer,
    stopAllServers,
    uninstallPython,
} from "./utils";

import log from "electron-log";
log.transports.file.resolvePathFn = () => getLogFilePath("main");

import icon from "../../resources/icon.png?asset";
import trayIconImage from "../../resources/assets/tray.png?asset";

console.log('[boot] main starting')
const HOTKEY_CANDIDATES = [
    'Shift+Super+E',   // Management Wunsch
    'Alt+F10',         // F-Taste, aber häufig frei
];

let ACTIVE_HOTKEY: string | null = null

function mapToServer(urlStr: string, serverUrl: string | null): string | null {
    if (!serverUrl) return null;
    try {
        const base = new URL(serverUrl);
        const target = new URL(urlStr, serverUrl);

        const isLegacy =
            (target.hostname === 'localhost' || target.hostname === '127.0.0.1') &&
            target.port === '8080';

        // Nur mappen, wenn Legacy und nicht schon auf base.host
        if (!isLegacy || target.host === base.host) return null;

        target.hostname = base.hostname;
        target.port = base.port;
        return target.toString();
    } catch {
        return null;
    }
}
function registerHotkeysRobust() {
    // Vorher alles wegräumen
    globalShortcut.unregisterAll();

    const okList: string[] = [];

    // Erst: Kandidaten registrieren, die alle auf handleHotkey zeigen
    for (const accel of HOTKEY_CANDIDATES) {
        const ok = globalShortcut.register(accel, handleHotkey);
        console.log(`🎹 Register ${accel}:`, ok);
        if (ok) okList.push(accel);
    }

    // Separater Test-Hotkey, zeigt nur eine Notification (zum Verifizieren)
    const testOk = globalShortcut.register('F10', () => {
        new Notification({ title: 'Hotkey-Test', body: 'F10 erkannt' }).show();
        console.log('✅ F10-Test ausgelöst');
    });
    console.log('🧪 F10-Test registriert =', testOk);

    // Merke „aktive“ (wir nehmen die erste erfolgreiche als PRIMARY)
    ACTIVE_HOTKEY = okList[0] ?? null;
    console.log('🔧 Aktiv registriert:', okList.join(', ') || '(keiner)');

    return okList;
}




// Main application logic
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuiting = false; // Flag to track if the app is quitting

let CONFIG: object | null = null;
let SERVER_URL: string | null = null;
let SERVER_STATUS: string | null = null;
let SERVER_REACHABLE = false;
let SERVER_PID: number | null = null;
let FIRST_RUN = false;
function createWindow(show = true): void {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 700,
        height: 500,
        minWidth: 400,
        minHeight: 400,
        icon: path.join(__dirname, "assets/icon.png"),
        show: false,
        titleBarStyle: process.platform === "win32" ? "default" : "hidden",
        trafficLightPosition: { x: 16, y: 16 },
        autoHideMenuBar: true,
        ...(process.platform === "win32"
            ? {
                  frame: true,
              }
            : {}),
        ...(process.platform === "linux" ? { icon } : {}),
        ...(process.platform !== "darwin" ? { titleBarOverlay: true } : {}),
        webPreferences: {
            preload: join(__dirname, "../preload/index.js"),
            sandbox: false,
            contextIsolation: false
        },
    });

    registerMainWindowGetter(() => mainWindow)

    
    mainWindow.webContents.on("dom-ready", () => {
        mainWindow!.webContents.executeJavaScript(`
    (function () {
      // nur installieren, wenn noch kein echter Store vorhanden ist
      const needsShim =
        !window.appData ||
        typeof window.appData.subscribe !== 'function' ||
        typeof window.appData.set !== 'function';

      if (!needsShim) return;

      console.warn('[shim] installing appData Svelte-like store');

      let _value = {};
      const _subs = new Set();

      window.appData = {
        // Svelte-Store API
        subscribe(fn) {
          _subs.add(fn);
          try { fn(_value); } catch {}
          return () => _subs.delete(fn);
        },
        set(v) {
          _value = v;
          _subs.forEach(fn => { try { fn(_value); } catch {} });
        },
        update(fn) {
          try { _value = fn(_value); } catch {}
          _subs.forEach(fn => { try { fn(_value); } catch {} });
        },
        // optional: bequemes Auslesen
        get() { return _value; }
      };

      // Optional: initial mit Backend-Daten befüllen
      fetch('/api/app/config')
        .then(r => r.ok ? r.json() : null)
        .then(cfg => { if (cfg) window.appData.set(cfg); })
        .catch(() => {});
    })();
  `).catch(() => { });
    });

      
    mainWindow.setIcon(icon);
    // Debug-Logs für Navigation
    mainWindow.webContents.on('did-start-loading', () => {
        console.log('[web] did-start-loading ->', mainWindow!.webContents.getURL());
    });
    mainWindow.webContents.on('did-navigate', (_e, url) => {
        console.log('[web] did-navigate ->', url);
    });
    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[web] did-finish-load ->', mainWindow!.webContents.getURL());
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
        console.log('[web] did-fail-load', code, desc, 'url=', url);
    });

    mainWindow.webContents.on('will-redirect', (_e, url) => {
            console.log('[web] will-redirect ->', url);
    });
    mainWindow.webContents.on('did-redirect-navigation', (_e, url) => {
            console.log('[web] did-redirect-navigation ->', url);
    });
  
    // Enables navigator.mediaDevices.getUserMedia API. See https://www.electronjs.org/docs/latest/api/desktop-capturer
    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            desktopCapturer
                .getSources({ types: ["screen"] })
                .then((sources) => {
                    // Grant access to the first screen found.
                    callback({ video: sources[0], audio: "loopback" });
                });
        },
        { useSystemPicker: true }
    );

    if (!app.isPackaged) {
        //mainWindow.webContents.openDevTools();
    }

    mainWindow.on('ready-to-show', () => {
           if (show) mainWindow!.show();
    });


    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        // 8080 -> aktive SERVER_URL mappen (z. B. 8084)
        const mapped = mapToServer(url, SERVER_URL);
        if (mapped) {
            console.log('[web] window.open legacy -> mapped to', mapped);
            mainWindow!.loadURL(mapped);
            return { action: 'deny' };
        }

        try {
            const base = new URL(SERVER_URL ?? '');
            const target = new URL(url, SERVER_URL ?? undefined);

            // Gleiche Origin -> im selben Fenster navigieren
            if (target.origin === base.origin) {
                console.log('[web] window.open same-origin ->', target.href);
                mainWindow!.loadURL(target.href);
                return { action: 'deny' };
            }
        } catch { }

        // Andere Origins -> extern
        console.log('[web] external open ->', url);
        shell.openExternal(url);
        return { action: 'deny' };
    });



    mainWindow.webContents.on('will-navigate', (e, url) => {
        const mapped = mapToServer(url, SERVER_URL);
        if (mapped) {
            console.log('[web] will-navigate legacy ->', url, '→', mapped);
            e.preventDefault();
            mainWindow!.loadURL(mapped);
            return;
        }

        try {
            const base = new URL(SERVER_URL ?? '');
            const target = new URL(url);
            if (target.origin === base.origin) {
                console.log('[web] will-navigate same-origin ->', url);
                return; // erlauben
            }
        } catch { }

        console.log('[web] will-navigate external ->', url, ' (openExternal & preventDefault)');
        e.preventDefault();
        shell.openExternal(url);
    });

;


    const defaultMenu = Menu.getApplicationMenu();
    let menuTemplate = defaultMenu ? defaultMenu.items.map((item) => item) : [];
    menuTemplate.push({
        label: "Action",
        submenu: [
            {
                label: "Uninstall",
                click: () => {
                    uninstallHandler();
                },
            },

            {
                label: "Reset",
                click: async () => {
                    await resetAppHandler();
                },
            },
        ],
    });
    const updatedMenu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(updatedMenu);

    // Create a system tray icon
    const image = nativeImage.createFromPath(trayIconImage);
    tray = new Tray(image.resize({ width: 16, height: 16 }));
    const trayMenu = Menu.buildFromTemplate([
        {
            label: "Show Controls",

            click: () => {
                mainWindow?.show();
            },
        },
        {
            type: "separator",
        },
        {
            label: "Quit Open WebUI",
            accelerator: "CommandOrControl+Q",
            click: async () => {
                await stopServerHandler(); // Stop the server before quitting
                isQuiting = true; // Mark as quitting
                app.quit(); // Quit the application
            },
        },
    ]);

    tray.setToolTip("Open WebUI");
    tray.setContextMenu(trayMenu);



    // Handle the close event
    mainWindow.on("close", (event) => {
        if (!(isQuiting ?? false)) {
            event.preventDefault(); // Prevent the default close behavior
            mainWindow?.hide(); // Hide the window instead of closing it
        }
    });
}

const updateTrayMenu = (status: string, url: string | null) => {
    const trayMenuTemplate = [
        {
            label: "Show Controls",
            click: () => {
                mainWindow?.show();
            },
        },
        {
            type: "separator",
        },
        {
            label: status, // Dynamic status message
            enabled: !!url,
            click: () => {
                if (url) {
                    openUrl(url); // Open the URL in the default browser
                }
            },
        },

        ...(SERVER_STATUS === "started"
            ? [
                  {
                      label: "Copy Server URL",
                      enabled: !!url, // Enable if URL exists
                      click: () => {
                          if (url) {
                              clipboard.writeText(url); // Copy the URL to clipboard
                          }
                      },
                  },
              ]
            : []),

        {
            type: "separator",
        },
        {
            label: "Quit Open WebUI",
            accelerator: "CommandOrControl+Q",
            click: () => {
                isQuiting = true; // Mark as quitting
                app.quit(); // Quit the application
            },
        },
    ];

    const trayMenu = Menu.buildFromTemplate(trayMenuTemplate);
    tray?.setContextMenu(trayMenu);
};

const uninstallHandler = async () => {
    try {
        await uninstallPython();

        // reload the main window to reflect the changes
        if (mainWindow) {
            mainWindow.webContents.send("main:data", {
                type: "reload",
            });
        }
        // Show success notification
        const notification = new Notification({
            title: "Open WebUI",
            body: "Uninstallation successful.",
        });
        notification.show();
    } catch (error) {
        log.error("Uninstallation failed:", error);
        // Show error notification
        const notification = new Notification({
            title: "Open WebUI",
            body: `Uninstallation failed: ${error.message}`,
        });
        notification.show();
    }
};

const startServerHandler = async () => {
    await stopServerHandler();
    SERVER_STATUS = "starting";
    mainWindow?.webContents.send("main:data", { type: "status:server", data: SERVER_STATUS });

    try {
        CONFIG = await getConfig();


        ({ url: SERVER_URL, pid: SERVER_PID } = await startServer(
            CONFIG?.serveOnLocalNetwork ?? false,
            CONFIG?.port ?? null
        ));

        
        if (SERVER_URL?.includes('127.0.0.1')) {
            SERVER_URL = SERVER_URL.replace('127.0.0.1', 'localhost');
        }


        updateTrayMenu("Open WebUI: Starting...", null);
        log.info("Server started successfully:", SERVER_URL, SERVER_PID);
        SERVER_STATUS = "started";
        mainWindow?.webContents.send("main:data", { type: "status:server", data: SERVER_STATUS });

        // --- Server erreichbar? (Warten, dann Electron-Fenster laden) ---
        async function waitForServer(url: string, attempts = 1800, intervalMs = 100) {
            if (url.startsWith("http://0.0.0.0")) {
                url = url.replace("http://0.0.0.0", "http://localhost");
                SERVER_URL = url;
            }
            for (let i = 0; i < attempts; i++) {
                try {
                    const res = await fetch(url, { method: "GET", cache: "no-store" });
                    if (res.ok) return;
                } catch { }
                await new Promise(r => setTimeout(r, intervalMs));
            }
            throw new Error("Server wurde nicht erreichbar (Timeout).");
        }

        await waitForServer(SERVER_URL!);
        SERVER_REACHABLE = true;

        // 💡 Nur Status im Tray, kein Browser-Click
        updateTrayMenu(`Open WebUI: ${SERVER_URL}`, null);

        if (!mainWindow) createWindow(false);

        // ✅ Chat-Seite in Electron laden
        // (falls die Chatroute z.B. "/" ist, einfach SERVER_URL nehmen;
        // falls deine Chat-Route anders ist, z.B. "/chat", dann `${SERVER_URL}/chat`)
        await mainWindow!.loadURL(SERVER_URL!);

        if (mainWindow!.isMinimized()) mainWindow!.restore();
        mainWindow!.maximize();
        mainWindow!.show();
        mainWindow!.focus();

        new Notification({ title: "Open WebUI", body: "Open WebUI ist bereit." }).show();
        mainWindow?.webContents.send("main:data", { type: "server" });
        return true;
    } catch (error) {
        log.error("Failed to start server:", error);
        SERVER_STATUS = "failed";
        mainWindow?.webContents.send("main:data", { type: "status:server", data: SERVER_STATUS });
        mainWindow?.webContents.send("main:log", `Failed to start server: ${error}`);
        updateTrayMenu("Open WebUI: Failed to Start", null);
        return false;
    }
};


const stopServerHandler = async () => {
    try {
        await stopAllServers();

        if (SERVER_STATUS) {
            // Only when the server was started
            SERVER_STATUS = "stopped";
            updateTrayMenu("Open WebUI: Stopped", null); // Update tray menu with stopped status
        }
        SERVER_REACHABLE = false;
        SERVER_URL = null; // Clear the server URL

        mainWindow?.webContents.send("main:data", {
            type: "status:server",
            data: SERVER_STATUS,
        });

        return true; // Indicate success
    } catch (error) {
        log.error("Failed to stop server:", error);
        return false; // Indicate failure
    }
};

const resetAppHandler = async () => {
    try {
        await stopServerHandler(); // Stop the server if running
        SERVER_STATUS = null;

        // wait a moment to ensure all processes are stopped
        await new Promise((resolve) => setTimeout(resolve, 1000));

        await resetApp(); // Reset the application state

        // Show success notification
        const notification = new Notification({
            title: "Open WebUI",
            body: "Application has been reset successfully.",
        });
        notification.show();
    } catch (error) {
        log.error("Failed to reset application:", error);
        // Show error notification
        const notification = new Notification({
            title: "Open WebUI",
            body: `Failed to reset application: ${error.message}`,
        });
        notification.show();
    }
};

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit(); // Quit if another instance is already running
} else {
    // Handle second-instance logic
    app.on("second-instance", (event, argv, workingDirectory) => {
        // This event happens if a second instance is launched
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore(); // Restore if minimized
            mainWindow.show(); // Show existing window
            mainWindow.focus(); // Focus the existing window
        }
    });

    app.setAboutPanelOptions({
        applicationName: "Open WebUI",
        iconPath: icon,
        applicationVersion: app.getVersion(),
        version: app.getVersion(),
        website: "https://openwebui.com",
        copyright: `© ${new Date().getFullYear()} Open WebUI (Timothy Jaeryang Baek)`,
    });

    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.
    app.whenReady().then(async () => {
       /* setTimeout(() => {
            console.log('⏱️ Debug-Timeout → handleHotkey() wird aufgerufen…');
            handleHotkey();
        }, 5000); */
        console.log('[boot] app.whenReady entered')
        CONFIG = await getConfig(); // Load initial config
        FIRST_RUN = CONFIG?.firstRun !== false;           
        await setConfig({ ...CONFIG, firstRun: false }); 

        log.info("Initial Config:", CONFIG);

     session.defaultSession.webRequest.onBeforeRequest(
           { urls: ['*://*/*'] }, // breit fassen, wir filtern selbst
           (details, callback) => {
                try {
                    if (!SERVER_URL) return callback({});

                    const base = new URL(SERVER_URL); // z.B. http://localhost:8081
                    const req = new URL(details.url);

                    // Nur Legacy-Ziel (8080) anfassen
                    const isLegacy =
                        (req.hostname === 'localhost' || req.hostname === '127.0.0.1') &&
                        req.port === '8080';

                    if (!isLegacy) return callback({});

                    // Schon auf dem gewünschten Host/Port? -> NICHT redirecten (Loop-Schutz)
                    if (req.host === base.host) return callback({});

                    // Host + Port gezielt umbiegen, Pfad/Query/Hash bleiben erhalten
                    req.hostname = base.hostname;
                    req.port = base.port;

                    const redirectURL = req.toString();
                    console.log('[webreq] map', details.url, '→', redirectURL, '| base=', base.href);
                    return callback({ redirectURL });
                } catch (err) {
                    console.warn('[webreq] error', err);
                    return callback({});
                }
            }
        );
        
        
       
        // Set app user model id for windows
        electronApp.setAppUserModelId("com.openwebui.desktop");

        // Default open or close DevTools by F12 in development
        // and ignore CommandOrControl + R in production.
        app.on("browser-window-created", (_, window) => {
            optimizer.watchWindowShortcuts(window);
        });

        // IPC test
        ipcMain.on("ping", () => log.info("pong"));

        ipcMain.handle("get:version", async () => {
            return app.getVersion();
        });

        ipcMain.handle("install:python", async (event) => {
            log.info("Installing package...");
            try {
                const res = await installPython();
                if (res) {
                    mainWindow?.webContents.send("main:data", {
                        type: "status:python",
                        data: true,
                    });

                    return true;
                }

                return false;
            } catch (error) {
                mainWindow?.webContents.send("main:data", {
                    type: "status:python",
                    data: false,
                });

                mainWindow?.webContents.send("main:data", {
                    type: "notification",
                    data: {
                        type: "error",
                        message: error?.message ?? "Something went wrong :/",
                    },
                });

                return false;
            }
        });

        ipcMain.handle("install:package", async (event) => {
            log.info("Installing package...");
            try {
                const res = await installPackage("open-webui");
                if (res) {
                    mainWindow?.webContents.send("main:data", {
                        type: "status:package",
                        data: true,
                    });
                }
            } catch (error) {
                mainWindow?.webContents.send("main:data", {
                    type: "status:package",
                    data: false,
                });
            }
        });

        ipcMain.handle("status:python", async (event) => {
            return (await isPythonInstalled()) && (await isUvInstalled());
        });

        ipcMain.handle("status:package", async (event) => {
            const packageStatus = await isPackageInstalled("open-webui");

            log.info("Package Status:", packageStatus);
            return packageStatus;
        });

        ipcMain.handle("server:start", async (event) => {
            return await startServerHandler();
        });

        ipcMain.handle("server:stop", async (event) => {
            return await stopServerHandler();
        });

        ipcMain.handle("server:restart", async (event) => {
            return await startServerHandler();
        });

        ipcMain.handle("server:logs", async (event) => {
            return SERVER_PID ? await getServerLog(SERVER_PID) : [];
        });

        ipcMain.handle("server:info", async (event) => {
            return {
                url: SERVER_URL,
                status: SERVER_STATUS,
                pid: SERVER_PID,
                reachable: SERVER_REACHABLE,
            };
        });

        ipcMain.handle("status:server", async (event) => {
            return SERVER_STATUS;
        });

        ipcMain.handle("app:info", async (event) => {
            return {
                version: app.getVersion(),
                platform: process.platform,
                arch: process.arch,
            };
        });

        ipcMain.handle("app:reset", async (event) => {
            return await resetAppHandler();
        });

        ipcMain.handle("get:config", async (event) => {
            return await getConfig();
        });

        ipcMain.handle("set:config", async (event, config) => {
            return await setConfig(config);
        });

        ipcMain.handle("open:browser", async (event, { url }) => {
            if (!url) {
                throw new Error("No URL provided to open in browser.");
            }
            log.info("Opening URL in browser:", url);
            if (url.startsWith("http://0.0.0.0")) {
                url = url.replace("http://0.0.0.0", "http://localhost");
            }

            await openUrl(url);
        });

        ipcMain.handle("notification", async (event, { title, body }) => {
            log.info("Received notification:", title, body);
            const notification = new Notification({
                title: title,
                body: body,
            });
            notification.show();
        });

        
        // --- Hotkey-IPC mit Fallback, falls .handle nicht verfügbar ist ---
        const hasHandle = typeof (ipcMain as any).handle === 'function'

        if (hasHandle) {
            ipcMain.handle('hotkey:get', async () => {
                return ACTIVE_HOTKEY
            })

            ipcMain.handle('hotkey:set', async (_evt, accelerator: string) => {
                if (ACTIVE_HOTKEY && globalShortcut.isRegistered(ACTIVE_HOTKEY)) {
                    globalShortcut.unregister(ACTIVE_HOTKEY)
                }
                const ok = globalShortcut.register(accelerator, handleHotkey)
                if (!ok) throw new Error(`Hotkey "${accelerator}" ist belegt oder ungültig`)
                ACTIVE_HOTKEY = accelerator

                const cur = await getConfig()
                await setConfig({ ...cur, hotkey: accelerator })
                console.log(`🔁 Hotkey gewechselt auf: ${accelerator}`)
                return accelerator
            })
        } else {
            // Fallback ohne .handle/.invoke → klassisches Reply-Muster
            ipcMain.on('hotkey:get', (event) => {
                event.reply('hotkey:get:reply', ACTIVE_HOTKEY)
            })

            ipcMain.on('hotkey:set', async (event, accelerator: string) => {
                try {
                    if (ACTIVE_HOTKEY && globalShortcut.isRegistered(ACTIVE_HOTKEY)) {
                        globalShortcut.unregister(ACTIVE_HOTKEY)
                    }
                    const ok = globalShortcut.register(accelerator, handleHotkey)
                    if (!ok) throw new Error(`Hotkey "${accelerator}" ist belegt oder ungültig`)
                    ACTIVE_HOTKEY = accelerator

                    const cur = await getConfig()
                    await setConfig({ ...cur, hotkey: accelerator })
                    console.log(`🔁 Hotkey gewechselt auf: ${accelerator}`)

                    event.reply('hotkey:set:reply', { ok: true, value: accelerator })
                } catch (e: any) {
                    event.reply('hotkey:set:reply', { ok: false, error: e?.message || 'error' })
                }
            })
        }

        ipcMain.handle("renderer:data", async (_event, payload) => {
            log.info("[ipc] renderer:data", payload);
            return { ok: true }; // no-op Antwort
        });

        (async () => {
            if (isPackageInstalled("open-webui")) {
                if (CONFIG?.autoUpdate ?? true) {
                    try {
                        log.info("Checking for updates...");
                        updateTrayMenu("Open WebUI: Checking for updates...", null);
                        await installPackage("open-webui");
                    } catch (error) {
                        log.error("Failed to update package:", error);
                    }
                }

                // ❌ Entfernen:
                // createWindow(false);

                // ✅ Nur das:
                await startServerHandler();
            } else {
                createWindow();
            }
        })();



        app.on("activate", function () {
            // On macOS it's common to re-create a window in the app when the
            // dock icon is clicked and there are no other windows open.
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });

        // Hotkey aus Config laden oder Fallback
        const activeList = registerHotkeysRobust();
        console.log('🔑 Primärer Hotkey:', ACTIVE_HOTKEY);
        app.on('will-quit', () => globalShortcut.unregisterAll());

    });

    // Quit when all windows are closed, except on macOS. There, it's common
    // for applications and their menu bar to stay active until the user quits
    // explicitly with Cmd + Q.
    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
            app.quit();
        }
    });

    app.on("before-quit", async () => {
        isQuiting = true; // Mark as quitting
        await stopServerHandler(); // Stop the server before quitting
        globalShortcut.unregisterAll(); // Unregister all shortcuts
        mainWindow = null; // Clear the main window reference
        tray?.destroy(); // Destroy the tray icon
        tray = null; // Clear the tray reference
    });
}


