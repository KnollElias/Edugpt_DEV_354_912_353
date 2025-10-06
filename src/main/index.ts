// @ts-nocheck
import { app, BrowserWindow, shell, session, Menu, Tray, nativeImage, globalShortcut, Notification } from 'electron'
import * as path from 'node:path'

const REMOTE_WEBUI_URL = 'https://api.menon-learning.ch'
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let ACTIVE_HOTKEY: string | null = null

const HOTKEY_CANDIDATES = process.platform === 'darwin'
  ? ['Shift+Command+E', 'F10']
  : ['Shift+Super+E', 'Alt+F10']

function handleHotkey() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  new Notification({ title: 'Open WebUI', body: 'Hotkey erkannt' }).show()
}

function registerHotkeys() {
  globalShortcut.unregisterAll()
  for (const accel of HOTKEY_CANDIDATES) {
    if (globalShortcut.register(accel, handleHotkey)) {
      ACTIVE_HOTKEY = accel
      break
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  mainWindow.loadURL(REMOTE_WEBUI_URL)
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const base = new URL(REMOTE_WEBUI_URL)
      const target = new URL(url, REMOTE_WEBUI_URL)
      if (target.origin === base.origin) { mainWindow!.loadURL(target.href); return { action: 'deny' } }
    } catch {}
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createWindow()

  const image = nativeImage.createFromPath(path.join(process.resourcesPath, 'assets', 'tray.png'))
  tray = new Tray(image)
  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)

  registerHotkeys()

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    try {
      const base = new URL(REMOTE_WEBUI_URL)
      const u = new URL(details.url)
      const legacy = (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.port === '8080'
      if (!legacy) return cb({})
      u.hostname = base.hostname
      u.port = base.port
      u.protocol = base.protocol
      cb({ redirectURL: u.toString() })
    } catch { cb({}) }
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
