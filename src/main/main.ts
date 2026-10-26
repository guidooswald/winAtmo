import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { AppStore } from './store';
import { TimeSeriesDatabase } from './database';
import { NetatmoClient } from './netatmoClient';
import { WebAuthManager } from './webAuth';
import {
  initTaskbarIconRenderer,
  resolveTaskbarReading,
  generateTaskbarIcon,
} from './taskbarIcon';
import {
  MeasureQueryRequest,
  MeasureSeries,
  NetatmoScale,
  SyncProgress,
  UserSettings,
  WeatherStation,
} from '../renderer/types';

app.setName('winAtmo');
app.name = 'winAtmo';

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let isWidgetExpanded = false;
let widgetExpandDirection: 'up' | 'down' = 'up';
let widgetTargetSize = { width: 420, height: 48 };
let collapsedBoundsBeforeExpand: {
  x: number;
  y: number;
  width: number;
  height: number;
} | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let refreshTimer: NodeJS.Timeout | null = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

let store: AppStore;
let db: TimeSeriesDatabase;
let client: NetatmoClient;
let webAuth: WebAuthManager;

function getRendererEntryUrl(queryMode?: string): {
  isDev: boolean;
  url: string;
  filePath: string;
} {
  const isDev =
    Boolean(process.env.VITE_DEV_SERVER_URL) ||
    process.env.NODE_ENV === 'development';
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
  const filePath = path.join(__dirname, '../renderer/index.html');
  const suffix = queryMode ? `?mode=${queryMode}` : '';
  return {
    isDev,
    url: `${devUrl}${suffix}`,
    filePath,
  };
}

function showMainWindow(focusModuleId?: string, focusMetric?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  if (focusModuleId && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sensor:focus', {
      moduleId: focusModuleId,
      metric: focusMetric,
    });
  }
}

const LIGHT_THEME_IDS = new Set([
  'fluent-light',
  'compact-light',
  'terminal-light',
  'nord-light',
  'brutal-light',
  'soft-light',
  // Legacy aliases
  'light',
  'catppuccin-latte',
  'solarized-light',
  'rose-pine-dawn',
  'github-light',
]);

const THEME_BG_COLORS: Record<string, string> = {
  'fluent-dark': '#090d16',
  'fluent-light': '#f8fafc',
  'compact-dark': '#0c1017',
  'compact-light': '#f3f4f6',
  'terminal-dark': '#05080c',
  'terminal-light': '#fcfcfc',
  'nord-dark': '#2e3440',
  'nord-light': '#eceff4',
  'brutal-dark': '#0a0a0a',
  'brutal-light': '#fafafa',
  'soft-dark': '#181622',
  'soft-light': '#fffbeb',
  // Legacy aliases
  dark: '#090d16',
  light: '#f8fafc',
  'catppuccin-mocha': '#090d16',
  'catppuccin-latte': '#f8fafc',
  'tokyo-night': '#05080c',
  dracula: '#090d16',
  'oled-black': '#05080c',
  'solarized-light': '#fffbeb',
  'rose-pine-dawn': '#fffbeb',
  'github-light': '#f8fafc',
};

const THEME_TOPBAR_COLORS: Record<
  string,
  { color: string; symbolColor: string }
> = {
  // 1. Modern Fluent
  'fluent-dark': { color: '#0f172a', symbolColor: '#f8fafc' },
  'fluent-light': { color: '#ffffff', symbolColor: '#0f172a' },
  // 2. Compact Density
  'compact-dark': { color: '#0f1621', symbolColor: '#f8fafc' },
  'compact-light': { color: '#ffffff', symbolColor: '#111827' },
  // 3. Cyber Terminal
  'terminal-dark': { color: '#080e15', symbolColor: '#22c55e' },
  'terminal-light': { color: '#ffffff', symbolColor: '#0f172a' },
  // 4. Nordic Minimalist
  'nord-dark': { color: '#2e3440', symbolColor: '#eceff4' },
  'nord-light': { color: '#eceff4', symbolColor: '#2e3440' },
  // 5. Neo-Brutalist
  'brutal-dark': { color: '#121212', symbolColor: '#ffffff' },
  'brutal-light': { color: '#ffffff', symbolColor: '#000000' },
  // 6. Soft Organic
  'soft-dark': { color: '#181622', symbolColor: '#f5d0fe' },
  'soft-light': { color: '#fffbeb', symbolColor: '#78350f' },
  // Legacy Aliases
  dark: { color: '#0f172a', symbolColor: '#f8fafc' },
  light: { color: '#ffffff', symbolColor: '#0f172a' },
  'catppuccin-mocha': { color: '#0f172a', symbolColor: '#f8fafc' },
  'catppuccin-latte': { color: '#ffffff', symbolColor: '#0f172a' },
  'tokyo-night': { color: '#080e15', symbolColor: '#f8fafc' },
  dracula: { color: '#0f172a', symbolColor: '#f8fafc' },
  'oled-black': { color: '#05080c', symbolColor: '#f8fafc' },
  'solarized-light': { color: '#fffbeb', symbolColor: '#78350f' },
  'rose-pine-dawn': { color: '#fffbeb', symbolColor: '#78350f' },
  'github-light': { color: '#ffffff', symbolColor: '#0f172a' },
};

function getTopBarOverlayConfig(themeId?: string): {
  color: string;
  symbolColor: string;
  height: number;
} {
  const id = themeId || 'fluent-dark';
  const isLight = LIGHT_THEME_IDS.has(id);
  const cfg = THEME_TOPBAR_COLORS[id] || {
    color: isLight ? '#ffffff' : '#0f172a',
    symbolColor: isLight ? '#0f172a' : '#f8fafc',
  };
  return {
    color: cfg.color,
    symbolColor: cfg.symbolColor,
    height: 32,
  };
}

function applyNativeWindowTheme(themeId?: string): void {
  const id = themeId || 'fluent-dark';
  const isLight = LIGHT_THEME_IDS.has(id);
  nativeTheme.themeSource = isLight ? 'light' : 'dark';
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bg = THEME_BG_COLORS[id] || (isLight ? '#f8fafc' : '#090d16');
    mainWindow.setBackgroundColor(bg);

    if (
      process.platform === 'win32' &&
      typeof (mainWindow as any).setTitleBarOverlay === 'function'
    ) {
      try {
        const overlay = getTopBarOverlayConfig(id);
        (mainWindow as any).setTitleBarOverlay({
          color: overlay.color,
          symbolColor: overlay.symbolColor,
          height: overlay.height,
        });
      } catch (err) {
        console.warn('[main] Failed to update titleBarOverlay:', err);
      }
    }
  }
}

function createMainWindow(): void {
  const currentTheme = store ? store.getSettings().theme : 'fluent-dark';
  applyNativeWindowTheme(currentTheme);
  const initialBg = THEME_BG_COLORS[currentTheme] || '#090d16';
  const isWindows = process.platform === 'win32';
  const initialTopBar = getTopBarOverlayConfig(currentTheme);

  mainWindow = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    center: true,
    backgroundColor: initialBg,
    darkTheme: !LIGHT_THEME_IDS.has(currentTheme),
    autoHideMenuBar: true,
    title: 'winAtmo — Netatmo Weather & Air Quality Studio',
    icon: createTrayNativeImage(),
    ...(isWindows
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: initialTopBar.color,
            symbolColor: initialTopBar.symbolColor,
            height: initialTopBar.height,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: true,
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Explicitly call show() & focus() after construction to override Win32 STARTUPINFO SW_HIDE when spawned from IDE terminals
  mainWindow.show();
  mainWindow.focus();

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  const entry = getRendererEntryUrl();
  if (entry.isDev) {
    mainWindow.loadURL(entry.url);
  } else {
    mainWindow.loadFile(entry.filePath);
  }

  mainWindow.webContents.on('did-fail-load', () => {
    mainWindow?.loadFile(entry.filePath);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('close', (e) => {
    const settings = store.getSettings();
    if (!isQuitting && settings.minimizeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getDefaultWidgetBounds(expanded = isWidgetExpanded): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const settings = store.getSettings();
  const pinnedCount = Math.max(1, settings.pinnedSensors.length || 3);
  const isCompact = settings.theme?.startsWith('compact');

  // Resolve display: check where the widget currently is, or where its saved position was
  let display: Electron.Display;
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    const [curX, curY] = widgetWindow.getPosition();
    const [curW, curH] = widgetWindow.getContentSize();
    display = screen.getDisplayNearestPoint({
      x: Math.round(curX + curW / 2),
      y: Math.round(curY + curH / 2),
    });
  } else if (settings.widgetPosition) {
    display = screen.getDisplayNearestPoint({
      x: settings.widgetPosition.x,
      y: settings.widgetPosition.y,
    });
  } else {
    display = screen.getPrimaryDisplay();
  }

  const workArea = display.workArea;
  const pillWidth = isCompact ? 130 : 156;
  const extraPad = isCompact ? 72 : 78;

  let width: number;
  let height: number;

  if (expanded) {
    width = Math.min(
      workArea.width - 16,
      Math.max(320, pinnedCount * pillWidth + extraPad)
    );
    height = 215;
  } else {
    width = Math.min(
      workArea.width - 16,
      Math.max(200, pinnedCount * pillWidth + extraPad)
    );
    height = isCompact ? 40 : 48;
  }

  // Position cleanly docked on the resolved display
  const saved =
    settings.widgetPosition &&
    settings.widgetPosition.x >= workArea.x - 50 &&
    settings.widgetPosition.x <= workArea.x + workArea.width &&
    settings.widgetPosition.y >= workArea.y - 50 &&
    settings.widgetPosition.y <= workArea.y + workArea.height
      ? settings.widgetPosition
      : undefined;

  let x = saved ? saved.x : workArea.x + workArea.width - width - 16;
  let y = saved
    ? ExpandedYAdjustment(saved.y, height, workArea)
    : workArea.y + workArea.height - height - 8;

  // Ensure inside visible bounds of this specific screen
  x = Math.max(workArea.x + 4, Math.min(x, workArea.x + workArea.width - width - 4));
  y = Math.max(workArea.y + 4, Math.min(y, workArea.y + workArea.height - height - 4));

  return { x, y, width, height };
}

function getOptimalExpandDirection(win: BrowserWindow): 'up' | 'down' {
  const [curX, curY] = win.getPosition();
  const [curW, curH] = win.getContentSize();
  const centerPoint = {
    x: Math.round(curX + curW / 2),
    y: Math.round(curY + curH / 2),
  };
  const display = screen.getDisplayNearestPoint(centerPoint);
  const workArea = display.workArea;

  const centerY = curY + curH / 2;
  const screenMidY = workArea.y + workArea.height / 2;
  const roomAbove = curY - workArea.y;
  const roomBelow = workArea.y + workArea.height - (curY + curH);
  const neededRoom = 215 - curH;

  if (centerY < screenMidY) {
    return roomBelow >= neededRoom || roomBelow >= roomAbove ? 'down' : 'up';
  } else {
    return roomAbove >= neededRoom || roomAbove >= roomBelow ? 'up' : 'down';
  }
}

function ExpandedYAdjustment(
  savedY: number,
  targetHeight: number,
  workArea: Electron.Rectangle
): number {
  if (savedY + targetHeight > workArea.y + workArea.height - 4) {
    return workArea.y + workArea.height - targetHeight - 8;
  }
  return savedY;
}

function createOrUpdateWidgetWindow(autoSizeForSensors = false): void {
  const settings = store.getSettings();

  if (!settings.widgetEnabled) {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.close();
      widgetWindow = null;
    }
    return;
  }

  const bounds = getDefaultWidgetBounds(isWidgetExpanded);

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setAlwaysOnTop(settings.widgetAlwaysOnTop, 'pop-up-menu');
    widgetWindow.setMovable(!settings.widgetLocked);
    // Keep OS window opacity at 1.0 so Windows DWM does not draw a layered rectangular box;
    // transparency is controlled per-pixel via CSS rgba() in TaskbarWidget.tsx.
    widgetWindow.setOpacity(1.0);
    if (autoSizeForSensors) {
      widgetTargetSize = { width: bounds.width, height: bounds.height };
      const cur = widgetWindow.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: Math.round(cur.x + cur.width / 2),
        y: Math.round(cur.y + cur.height / 2),
      });
      const workArea = display.workArea;
      const nextX = Math.max(
        workArea.x + 4,
        Math.min(cur.x, workArea.x + workArea.width - bounds.width - 4)
      );
      const nextY = Math.max(
        workArea.y + 4,
        Math.min(cur.y, workArea.y + workArea.height - bounds.height - 4)
      );
      widgetWindow.setContentSize(bounds.width, bounds.height);
      widgetWindow.setPosition(nextX, nextY);
    }
    widgetWindow.showInactive();
    return;
  }

  widgetTargetSize = { width: bounds.width, height: bounds.height };

  widgetWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 200,
    minHeight: 44,
    useContentSize: true,
    frame: false,
    transparent: true,
    resizable: true,
    movable: !settings.widgetLocked,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.widgetAlwaysOnTop,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'winAtmo',
    icon: createTrayNativeImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  widgetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  widgetWindow.setAlwaysOnTop(settings.widgetAlwaysOnTop, 'pop-up-menu');
  widgetWindow.setOpacity(1.0);

  const entry = getRendererEntryUrl('widget');
  if (entry.isDev) {
    widgetWindow.loadURL(entry.url);
  } else {
    widgetWindow.loadFile(entry.filePath, { query: { mode: 'widget' } });
  }

  widgetWindow.webContents.on('did-fail-load', () => {
    widgetWindow?.loadFile(entry.filePath, { query: { mode: 'widget' } });
  });

  widgetWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  widgetWindow.once('ready-to-show', () => {
    widgetWindow?.showInactive();
  });

  let moveSaveTimeout: NodeJS.Timeout | null = null;
  widgetWindow.on('moved', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (moveSaveTimeout) clearTimeout(moveSaveTimeout);
    moveSaveTimeout = setTimeout(() => {
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      const [x, y] = widgetWindow.getPosition();
      if (!isWidgetExpanded) {
        store.updateSettings({ widgetPosition: { x, y } });
        const dir = getOptimalExpandDirection(widgetWindow);
        widgetExpandDirection = dir;
        widgetWindow.webContents.send('widget:direction-updated', dir);
      }
    }, 250);
  });

  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

function broadcastToAllWindows(channel: string, payload: any): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(channel, payload);
  }
}

/**
 * Generates a crisp 32x32 RGBA bitmap icon for the Windows System Tray.
 */
function createTrayNativeImage(): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - 15.5;
      const dy = y - 15.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= 14.5) {
        // Rounded badge gradient (sky-blue to teal)
        const t = y / size;
        const r = Math.round(14 * (1 - t) + 16 * t);
        const g = Math.round(165 * (1 - t) + 185 * t);
        const b = Math.round(233 * (1 - t) + 129 * t);
        // Thermometer / wave glyph inside
        const isStem = x >= 14 && x <= 17 && y >= 7 && y <= 20;
        const isBulb = Math.sqrt((x - 15.5) ** 2 + (y - 21.5) ** 2) <= 4.2;

        if (isStem || isBulb) {
          // BGRA format on Windows
          buf[idx] = 255; // B
          buf[idx + 1] = 255; // G
          buf[idx + 2] = 255; // R
          buf[idx + 3] = 255; // A
        } else {
          buf[idx] = b;
          buf[idx + 1] = g;
          buf[idx + 2] = r;
          buf[idx + 3] = dist > 13.5 ? Math.round((14.5 - dist) * 255) : 255;
        }
      } else {
        buf[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTrayTooltipAndMenu(): void {
  if (!tray) return;

  const stations = store.getCachedStations();
  const settings = store.getSettings();
  const defaultIcon = createTrayNativeImage();
  const reading = resolveTaskbarReading(stations, settings);

  // Update System Tray icon and Window Taskbar Overlay
  generateTaskbarIcon(reading, defaultIcon).then((iconImg) => {
    if (tray && !tray.isDestroyed()) {
      tray.setImage(iconImg);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (reading) {
        mainWindow.setOverlayIcon(iconImg, reading.fullLabel);
      } else {
        mainWindow.setOverlayIcon(null, '');
      }
    }
  });

  const lines: string[] = [];
  if (reading) {
    lines.push(`${reading.fullLabel} • winAtmo`);
    lines.push('─────────────────────');
  } else {
    lines.push('winAtmo');
  }

  if (settings.pinnedSensors.length > 0 && stations.length > 0) {
    for (const pin of settings.pinnedSensors) {
      const st = stations.find((s) => s.id === pin.stationId);
      const mod = st?.modules.find((m) => m.id === pin.moduleId);
      if (mod?.dashboard) {
        const valStr = formatPinnedReadingForTray(
          mod.dashboard,
          pin.metric,
          settings
        );
        lines.push(`${mod.moduleName}: ${valStr}`);
      }
    }
  } else if (stations.length > 0) {
    const first = stations[0];
    for (const mod of first.modules.slice(0, 3)) {
      if (mod.dashboard?.Temperature !== undefined) {
        lines.push(`${mod.moduleName}: ${mod.dashboard.Temperature.toFixed(1)}°C`);
      }
    }
  } else {
    lines.push('Not connected — Open to sign in');
  }

  tray.setToolTip(lines.join('\n'));

  const menuItems: Electron.MenuItemConstructorOptions[] = [];

  if (reading) {
    menuItems.push(
      {
        label: `Current: ${reading.fullLabel}`,
        enabled: false,
      },
      { type: 'separator' }
    );
  }

  menuItems.push(
    {
      label: 'Open winAtmo Studio',
      click: () => showMainWindow(),
    },
    {
      label: settings.widgetEnabled
        ? 'Hide Taskbar Widget'
        : 'Show Taskbar Widget',
      click: () => {
        const next = store.updateSettings({
          widgetEnabled: !settings.widgetEnabled,
        });
        createOrUpdateWidgetWindow();
        broadcastToAllWindows('settings:updated', next);
        updateTrayTooltipAndMenu();
      },
    },
    {
      label: 'Reset Taskbar Widget Position',
      click: () => {
        const next = store.updateSettings({ widgetPosition: undefined });
        if (widgetWindow && !widgetWindow.isDestroyed()) {
          const b = getDefaultWidgetBounds(false);
          widgetWindow.setBounds(b);
        }
        broadcastToAllWindows('settings:updated', next);
      },
    },
    { type: 'separator' },
    {
      label: 'Sync Sensors Now',
      click: async () => {
        await client.syncHistoricalData();
        broadcastToAllWindows('stations:updated', store.getCachedStations());
        updateTrayTooltipAndMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit winAtmo',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
}

function formatPinnedReadingForTray(
  d: any,
  metric: string,
  settings: UserSettings
): string {
  switch (metric) {
    case 'temperature': {
      if (d.Temperature === undefined) return '--';
      const v =
        settings.temperatureUnit === 'F'
          ? (d.Temperature * 9) / 5 + 32
          : d.Temperature;
      return `${v.toFixed(1)}°${settings.temperatureUnit}`;
    }
    case 'humidity':
      return d.Humidity !== undefined ? `${d.Humidity}%` : '--';
    case 'co2':
      return d.CO2 !== undefined ? `${d.CO2} ppm` : '--';
    case 'pressure':
      return d.Pressure !== undefined
        ? `${d.Pressure.toFixed(1)} ${settings.pressureUnit}`
        : '--';
    case 'noise':
      return d.Noise !== undefined ? `${d.Noise} dB` : '--';
    case 'rain':
      return d.Rain !== undefined ? `${d.Rain.toFixed(1)} mm` : '--';
    case 'windstrength':
      return d.WindStrength !== undefined ? `${d.WindStrength} km/h` : '--';
    default:
      return '--';
  }
}

function setupRefreshSchedule(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const minutes = Math.max(1, store.getSettings().refreshIntervalMinutes || 5);
  refreshTimer = setInterval(async () => {
    const session = store.getSession();
    if (!session.loggedIn) return;
    try {
      await client.syncHistoricalData();
      broadcastToAllWindows('stations:updated', store.getCachedStations());
      updateTrayTooltipAndMenu();
    } catch (err) {
      console.warn('[Main] Scheduled refresh error:', err);
    }
  }, minutes * 60 * 1000);
}

function registerIpcHandlers(): void {
  ipcMain.on('window:minimize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    win?.minimize();
  });

  ipcMain.on('window:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.on('window:close', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    win?.close();
  });

  ipcMain.handle('window:is-maximized', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? win.isMaximized() : false;
  });

  ipcMain.on(
    'window:open-main',
    (_e, payload?: { focusModuleId?: string; focusMetric?: string }) => {
      showMainWindow(payload?.focusModuleId, payload?.focusMetric);
    }
  );

  // Taskbar Widget IPC
  ipcMain.handle('widget:toggle', (_e, enabled?: boolean) => {
    const current = store.getSettings().widgetEnabled;
    const nextVal = enabled !== undefined ? enabled : !current;
    const updated = store.updateSettings({ widgetEnabled: nextVal });
    createOrUpdateWidgetWindow();
    broadcastToAllWindows('settings:updated', updated);
    updateTrayTooltipAndMenu();
    return updated;
  });

  ipcMain.handle('widget:reset-position', () => {
    const updated = store.updateSettings({ widgetPosition: undefined });
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const b = getDefaultWidgetBounds(isWidgetExpanded);
      widgetTargetSize = { width: b.width, height: b.height };
      widgetWindow.setContentSize(b.width, b.height);
      widgetWindow.setPosition(b.x, b.y);
    }
    broadcastToAllWindows('settings:updated', updated);
    return updated;
  });

  ipcMain.handle('widget:get-expand-direction', (): 'up' | 'down' => {
    if (!widgetWindow || widgetWindow.isDestroyed()) {
      return widgetExpandDirection;
    }
    return getOptimalExpandDirection(widgetWindow);
  });

  ipcMain.handle('widget:set-expanded', (_e, expanded: boolean): 'up' | 'down' => {
    if (!widgetWindow || widgetWindow.isDestroyed()) {
      isWidgetExpanded = expanded;
      return widgetExpandDirection;
    }

    const [curX, curY] = widgetWindow.getPosition();
    const [curW, curH] = widgetWindow.getContentSize();
    const display = screen.getDisplayNearestPoint({
      x: Math.round(curX + curW / 2),
      y: Math.round(curY + curH / 2),
    });
    const workArea = display.workArea;
    const expandedHeight = 215;

    if (expanded) {
      // Save exact collapsed bounds before expanding so we can restore them when closing charts
      if (!isWidgetExpanded) {
        collapsedBoundsBeforeExpand = {
          x: curX,
          y: curY,
          width: curW,
          height: curH,
        };
        widgetExpandDirection = getOptimalExpandDirection(widgetWindow);
      }

      isWidgetExpanded = true;
      // Keep current width (never resize width when expanding)
      widgetTargetSize = { width: curW, height: expandedHeight };

      let newY: number;
      if (widgetExpandDirection === 'down') {
        // Towards top of display: keep top edge fixed and expand downwards
        newY = curY;
        if (newY + expandedHeight > workArea.y + workArea.height - 4) {
          newY = Math.max(workArea.y + 4, workArea.y + workArea.height - expandedHeight - 4);
        }
      } else {
        // Towards bottom of display: keep bottom edge fixed and expand upwards
        const bottomEdge = curY + curH;
        newY = Math.max(workArea.y + 4, bottomEdge - expandedHeight);
      }

      const newX = Math.max(
        workArea.x + 4,
        Math.min(curX, workArea.x + workArea.width - curW - 4)
      );

      widgetWindow.setContentSize(curW, expandedHeight);
      widgetWindow.setPosition(newX, newY);
    } else {
      // Closing charts: restore the initial collapsed position & size before expanding
      const savedCollapsed = collapsedBoundsBeforeExpand;
      const collapsedH = savedCollapsed ? savedCollapsed.height : 48;
      isWidgetExpanded = false;
      widgetTargetSize = { width: curW, height: collapsedH };

      let restoreY: number;
      if (
        savedCollapsed &&
        Math.abs(curX - savedCollapsed.x) <= 12 &&
        (widgetExpandDirection === 'down'
          ? Math.abs(curY - savedCollapsed.y) <= 12
          : Math.abs(curY + curH - (savedCollapsed.y + savedCollapsed.height)) <= 16)
      ) {
        // Widget wasn't dragged elsewhere while expanded -> restore exact initial Y
        restoreY = savedCollapsed.y;
      } else if (widgetExpandDirection === 'down') {
        // Minimize upwards to current top edge
        restoreY = curY;
      } else {
        // Minimize downwards to current bottom edge
        restoreY = curY + curH - collapsedH;
      }

      restoreY = Math.max(
        workArea.y + 4,
        Math.min(restoreY, workArea.y + workArea.height - collapsedH - 4)
      );
      const newX = Math.max(
        workArea.x + 4,
        Math.min(curX, workArea.x + workArea.width - curW - 4)
      );

      collapsedBoundsBeforeExpand = null;
      widgetWindow.setContentSize(curW, collapsedH);
      widgetWindow.setPosition(newX, restoreY);
      store.updateSettings({ widgetPosition: { x: newX, y: restoreY } });
    }

    return widgetExpandDirection;
  });

  ipcMain.on('widget:move-by', (_e, delta: { dx: number; dy: number }) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (store.getSettings().widgetLocked) return;
    const [curX, curY] = widgetWindow.getPosition();
    const nextX = Math.round(curX + delta.dx);
    const nextY = Math.round(curY + delta.dy);
    widgetWindow.setPosition(nextX, nextY);
    widgetWindow.setContentSize(widgetTargetSize.width, widgetTargetSize.height);
  });

  ipcMain.on(
    'widget:resize',
    (_e, size: { width: number; height: number }) => {
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      const [curX, curY] = widgetWindow.getPosition();
      const [curW, curH] = widgetWindow.getContentSize();
      const display = screen.getDisplayNearestPoint({
        x: Math.round(curX + curW / 2),
        y: Math.round(curY + curH / 2),
      });
      const workArea = display.workArea;
      const maxW = Math.max(200, workArea.width - 12);
      const w = Math.min(maxW, Math.max(180, Math.round(size.width)));
      const h = Math.max(36, Math.round(size.height));
      widgetTargetSize = { width: w, height: h };

      widgetWindow.setContentSize(w, h);

      let nextX = curX;
      if (curX + w > workArea.x + workArea.width - 4) {
        nextX = Math.max(workArea.x + 4, workArea.x + workArea.width - w - 8);
      } else if (curX < workArea.x + 4) {
        nextX = workArea.x + 4;
      }

      if (nextX !== curX) {
        widgetWindow.setPosition(nextX, curY);
      }
    }
  );

  // Authentication IPC
  ipcMain.handle('auth:get-account', () => {
    return store.getAccountInfo();
  });

  ipcMain.handle('auth:web-login', async () => {
    const res = await webAuth.startWebLogin(mainWindow || undefined);
    if (res.success) {
      broadcastToAllWindows('stations:updated', store.getCachedStations());
      updateTrayTooltipAndMenu();
      createOrUpdateWidgetWindow();
      // Start initial 14-day (or configured) historical data load in background
      client.syncHistoricalData().then(() => {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
      });
    }
    return res;
  });

  ipcMain.handle(
    'auth:oauth-login',
    async (_e, payload: { clientId: string; clientSecret: string }) => {
      const res = await webAuth.startOAuthLogin(
        payload.clientId,
        payload.clientSecret,
        mainWindow || undefined
      );
      if (res.success) {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
        updateTrayTooltipAndMenu();
        createOrUpdateWidgetWindow();
        client.syncHistoricalData().then(() => {
          broadcastToAllWindows('stations:updated', store.getCachedStations());
        });
      }
      return res;
    }
  );

  ipcMain.handle(
    'auth:token-login',
    async (_e, payload: { accessToken: string; refreshToken?: string }) => {
      const res = await client.verifyAndSaveWebToken(
        payload.accessToken,
        payload.refreshToken,
        [],
        'token'
      );
      if (res.valid) {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
        updateTrayTooltipAndMenu();
        createOrUpdateWidgetWindow();
        client.syncHistoricalData().then(() => {
          broadcastToAllWindows('stations:updated', store.getCachedStations());
        });
        return { success: true, account: res.account };
      }
      return { success: false, error: res.error };
    }
  );

  ipcMain.handle('auth:demo-mode', async () => {
    const res = await client.enableDemoMode();
    broadcastToAllWindows('stations:updated', res.stations);
    broadcastToAllWindows('settings:updated', store.getSettings());
    updateTrayTooltipAndMenu();
    createOrUpdateWidgetWindow();
    return res;
  });

  ipcMain.handle('auth:logout', async () => {
    await webAuth.clearWebSession();
    broadcastToAllWindows('stations:updated', []);
    updateTrayTooltipAndMenu();
  });

  // Stations & History IPC
  ipcMain.handle('stations:get-cached', () => {
    return {
      stations: store.getCachedStations(),
      lastSyncAt: store.getLastSyncAt(),
    };
  });

  ipcMain.handle('stations:refresh', async () => {
    const stations = await client.fetchStations();
    broadcastToAllWindows('stations:updated', stations);
    updateTrayTooltipAndMenu();
    return stations;
  });

  ipcMain.handle(
    'history:sync',
    async (
      _e,
      options?: {
        forceFull?: boolean;
        customDays?: number;
        scale?: NetatmoScale;
      }
    ) => {
      const progress = await client.syncHistoricalData(options);
      broadcastToAllWindows('stations:updated', store.getCachedStations());
      updateTrayTooltipAndMenu();
      return progress;
    }
  );

  ipcMain.handle('history:get-progress', () => {
    return client.getSyncProgress();
  });

  ipcMain.handle('history:query', async (_e, req: MeasureQueryRequest) => {
    return client.queryMeasureSeries(req);
  });

  // Storage & CSV Export IPC
  ipcMain.handle('storage:stats', () => {
    return db.getStorageStats();
  });

  ipcMain.handle('storage:clear', () => {
    return db.clearAllHistory();
  });

  ipcMain.handle('storage:optimize', () => {
    return db.optimizeDatabase();
  });

  ipcMain.handle(
    'storage:export-csv',
    async (
      _e,
      payload: { series: MeasureSeries[]; defaultFileName?: string }
    ) => {
      if (!payload.series || payload.series.length === 0) {
        return { success: false, error: 'No chart series data to export.' };
      }

      const { canceled, filePath } = await dialog.showSaveDialog(
        mainWindow || undefined!,
        {
          title: 'Export Sensor History to CSV',
          defaultPath:
            payload.defaultFileName ||
            `winAtmo-export-${new Date().toISOString().slice(0, 10)}.csv`,
          filters: [{ name: 'CSV File', extensions: ['csv'] }],
        }
      );

      if (canceled || !filePath) {
        return { success: false, error: 'Export cancelled' };
      }

      try {
        // Merge timestamps across all exported series
        const tsSet = new Set<number>();
        const seriesMaps = payload.series.map((s) => {
          const map = new Map<number, number>();
          for (const p of s.points) {
            tsSet.add(p.ts);
            map.set(p.ts, p.value);
          }
          return {
            header: `"${s.stationName} - ${s.moduleName} (${s.metric})"`
              .replace(/\r?\n/g, ' '),
            map,
          };
        });

        const sortedTs = Array.from(tsSet).sort((a, b) => a - b);
        const lines: string[] = [];
        lines.push(
          ['Timestamp_UTC', 'ISO_DateTime', ...seriesMaps.map((s) => s.header)].join(',')
        );

        for (const ts of sortedTs) {
          const iso = new Date(ts * 1000).toISOString();
          const vals = seriesMaps.map((sm) => {
            const v = sm.map.get(ts);
            return v !== undefined ? String(v) : '';
          });
          lines.push([String(ts), iso, ...vals].join(','));
        }

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { success: true, filePath };
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || 'Failed to write CSV file.',
        };
      }
    }
  );

  // Settings IPC
  ipcMain.handle('settings:get', () => {
    const s = store.getSettings();
    applyNativeWindowTheme(s.theme);
    return s;
  });

  ipcMain.handle('settings:update', async (_e, partial: Partial<UserSettings>) => {
    const prev = store.getSettings();
    const updated = store.updateSettings(partial);

    applyNativeWindowTheme(updated.theme);

    if (
      partial.widgetEnabled !== undefined ||
      partial.widgetAlwaysOnTop !== undefined ||
      partial.widgetOpacity !== undefined ||
      partial.widgetLocked !== undefined ||
      partial.pinnedSensors !== undefined
    ) {
      createOrUpdateWidgetWindow(partial.pinnedSensors !== undefined);
    }

    if (partial.refreshIntervalMinutes !== undefined) {
      setupRefreshSchedule();
    }

    broadcastToAllWindows('settings:updated', updated);
    updateTrayTooltipAndMenu();

    // If user increased historyDays or turned on historyMaxMode, trigger background sync automatically!
    const historyExpanded =
      (updated.historyMaxMode && !prev.historyMaxMode) ||
      (!updated.historyMaxMode && updated.historyDays > prev.historyDays) ||
      updated.defaultScale !== prev.defaultScale;

    if (historyExpanded && store.getSession().loggedIn) {
      client.syncHistoricalData().then(() => {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
      });
    }

    return updated;
  });

  ipcMain.handle('shell:open-external', async (_e, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        await shell.openExternal(parsed.toString());
      }
    } catch {}
  });
}

app.whenReady().then(async () => {
  store = new AppStore();
  db = new TimeSeriesDatabase();
  client = new NetatmoClient(store, db);
  webAuth = new WebAuthManager(store, client);

  client.setSilentRefreshHandler(() => webAuth.silentWebRefresh());
  client.setProgressHandler((progress: SyncProgress) => {
    broadcastToAllWindows('sync:progress', progress);
  });

  registerIpcHandlers();
  await initTaskbarIconRenderer();

  // Create System Tray
  tray = new Tray(createTrayNativeImage());
  tray.setTitle('winAtmo');
  tray.setToolTip('winAtmo');
  tray.on('click', () => {
    showMainWindow();
  });
  updateTrayTooltipAndMenu();

  // Launch Main Window & Taskbar Widget
  createMainWindow();
  createOrUpdateWidgetWindow();
  setupRefreshSchedule();

  // If user is already logged in, kick off an initial sync in background
  if (store.getSession().loggedIn) {
    setTimeout(() => {
      client.syncHistoricalData().then(() => {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
        updateTrayTooltipAndMenu();
      });
    }, 800);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
