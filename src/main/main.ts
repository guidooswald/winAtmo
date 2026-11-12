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
import { execFile } from 'child_process';
import { AppStore } from './store';
import { TimeSeriesDatabase } from './database';
import { NetatmoClient } from './netatmoClient';
import { WebAuthManager } from './webAuth';
import { debugLogger } from './debugLogger';
import { securityMediaProxy } from './securityMediaProxy';
import {
  initTaskbarIconRenderer,
  resolveTaskbarReading,
  generateTaskbarIcon,
} from './taskbarIcon';
import {
  AccountInfo,
  MeasureQueryRequest,
  MeasureQueryStatus,
  MeasureSeries,
  NetatmoScale,
  SyncProgress,
  UserSettings,
  WeatherStation,
} from '../renderer/types';

app.setName('winAtmo');
app.name = 'winAtmo';
app.setAppUserModelId('guidooswald.winAtmo');

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let debugWindow: BrowserWindow | null = null;
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

/**
 * Configures the application to launch at Windows user login.
 * Supports both standalone/unpackaged Win32 execution (registry Run key)
 * and packaged Windows Store (MSIX / Centennial windows.startupTask).
 */
function applyStartupRegistration(enabled: boolean): void {
  // 1. Unpackaged / standard Win32 environment (Electron loginItemSettings)
  try {
    const isBundledApp =
      fs.existsSync(path.join(process.resourcesPath, 'app.asar')) ||
      fs.existsSync(path.join(process.resourcesPath, 'app'));

    const startupArgs = isBundledApp
      ? ['--autostart']
      : [path.resolve(app.getAppPath()), '--autostart'];

    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: startupArgs,
    });
  } catch (err) {
    console.warn('[Startup] Failed to set electron login item settings:', err);
  }

  // 2. Windows Store / MSIX packaged environment (Desktop Bridge windows.startupTask)
  // When running inside an MSIX container, process.windowsStore is true.
  if (process.windowsStore) {
    try {
      const psScript = `
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $type = [System.Type]::GetType('Windows.ApplicationModel.StartupTask, Windows.ApplicationModel, ContentType=WindowsRuntime')
        if ($type -ne $null) {
          $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
          if ($asTaskGeneric -ne $null) {
            $asTask = $asTaskGeneric.MakeGenericMethod($type)
            $op = $type.GetMethod('GetAsync', [Type[]]@([string])).Invoke($null, @('winAtmoStartup'))
            $task = $asTask.Invoke($null, @($op))
            $st = $task.Result
            if ($st -ne $null) {
              if ('${enabled ? 'true' : 'false'}' -eq 'true') {
                $st.RequestEnableAsync() | Out-Null
              } else {
                $st.Disable()
              }
            }
          }
        }
      `;
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { windowsHide: true },
        (err) => {
          if (err) {
            console.warn('[Startup] MSIX StartupTask helper note:', err.message);
          }
        }
      );
    } catch (msixErr) {
      console.warn('[Startup] MSIX StartupTask execution error:', msixErr);
    }
  }
}

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
    createMainWindow(true);
  } else {
    const wasVisible = mainWindow.isVisible();
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!wasVisible && store?.getSettings().mainWindowBounds?.isMaximized) {
      mainWindow.maximize();
    }
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

function applyNativeWindowTheme(themeId?: string): void {
  const id = themeId || 'fluent-dark';
  const isLight = LIGHT_THEME_IDS.has(id);
  nativeTheme.themeSource = isLight ? 'light' : 'dark';
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bg = THEME_BG_COLORS[id] || (isLight ? '#f8fafc' : '#090d16');
    mainWindow.setBackgroundColor(bg);
  }
}

let mainBoundsSaveTimeout: NodeJS.Timeout | null = null;
function saveMainWindowBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  const currentSettings = store.getSettings();
  if (mainWindow.isMaximized()) {
    const curBounds = currentSettings.mainWindowBounds;
    store.updateSettings({
      mainWindowBounds: {
        width: curBounds?.width || 1340,
        height: curBounds?.height || 860,
        x: curBounds?.x,
        y: curBounds?.y,
        isMaximized: true,
      },
    });
  } else {
    const bounds = mainWindow.getBounds();
    store.updateSettings({
      mainWindowBounds: {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: false,
      },
    });
  }
}

function debouncedSaveMainBounds(): void {
  if (mainBoundsSaveTimeout) clearTimeout(mainBoundsSaveTimeout);
  mainBoundsSaveTimeout = setTimeout(() => {
    saveMainWindowBounds();
  }, 250);
}

let widgetSizeSaveTimeout: NodeJS.Timeout | null = null;
function saveWidgetSize(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  const b = widgetWindow.getBounds();
  const settings = store.getSettings();
  const isCompact = settings.theme?.startsWith('compact');
  const defaultCollapsedHeight = isCompact ? 34 : 42;

  if (!isWidgetExpanded) {
    store.updateSettings({
      widgetExpanded: false,
      widgetSize: { width: b.width, height: b.height },
      widgetPosition: { x: b.x, y: b.y },
    });
  } else {
    const cur = settings.widgetSize;
    const collapsedH =
      collapsedBoundsBeforeExpand?.height || cur?.height || defaultCollapsedHeight;
    const colY = widgetExpandDirection === 'down' ? b.y : b.y + b.height - collapsedH;
    store.updateSettings({
      widgetExpanded: true,
      widgetExpandedSize: { width: b.width, height: b.height },
      widgetSize: { width: b.width, height: collapsedH },
      widgetPosition: { x: b.x, y: colY },
    });
  }
}

function debouncedSaveWidgetSize(): void {
  if (widgetSizeSaveTimeout) clearTimeout(widgetSizeSaveTimeout);
  widgetSizeSaveTimeout = setTimeout(() => {
    saveWidgetSize();
  }, 250);
}

function createMainWindow(shouldShow = true): void {
  const settings = store ? store.getSettings() : null;
  const currentTheme = settings ? settings.theme : 'fluent-dark';
  applyNativeWindowTheme(currentTheme);
  const initialBg = THEME_BG_COLORS[currentTheme] || '#090d16';

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  // 30% larger default startup window (1340 x 860 -> 1742 x 1118), safely clamped to display workArea
  const defaultWidth = Math.min(1742, Math.max(1020, workArea.width - 24));
  const defaultHeight = Math.min(1118, Math.max(680, workArea.height - 24));

  const savedBounds = settings?.mainWindowBounds;
  let targetWidth = defaultWidth;
  let targetHeight = defaultHeight;
  let targetX: number | undefined;
  let targetY: number | undefined;

  if (
    savedBounds &&
    typeof savedBounds.width === 'number' &&
    typeof savedBounds.height === 'number'
  ) {
    let targetDisplay = primaryDisplay;
    if (
      typeof savedBounds.x === 'number' &&
      typeof savedBounds.y === 'number'
    ) {
      const displayCandidate = screen.getDisplayNearestPoint({
        x: Math.round(savedBounds.x + savedBounds.width / 2),
        y: Math.round(savedBounds.y + savedBounds.height / 2),
      });
      if (displayCandidate) {
        targetDisplay = displayCandidate;
      }
    }

    const targetWorkArea = targetDisplay.workArea;
    targetWidth = Math.min(
      targetWorkArea.width,
      Math.max(1020, Math.round(savedBounds.width))
    );
    targetHeight = Math.min(
      targetWorkArea.height,
      Math.max(680, Math.round(savedBounds.height))
    );

    if (
      typeof savedBounds.x === 'number' &&
      typeof savedBounds.y === 'number'
    ) {
      const posX = Math.round(savedBounds.x);
      const posY = Math.round(savedBounds.y);
      if (
        posX + 100 > targetWorkArea.x &&
        posX < targetWorkArea.x + targetWorkArea.width - 100 &&
        posY >= targetWorkArea.y &&
        posY < targetWorkArea.y + targetWorkArea.height - 100
      ) {
        targetX = Math.max(
          targetWorkArea.x,
          Math.min(posX, targetWorkArea.x + targetWorkArea.width - targetWidth)
        );
        targetY = Math.max(
          targetWorkArea.y,
          Math.min(posY, targetWorkArea.y + targetWorkArea.height - targetHeight)
        );
      }
    }
  }

  mainWindow = new BrowserWindow({
    width: targetWidth,
    height: targetHeight,
    x: targetX,
    y: targetY,
    minWidth: 1020,
    minHeight: 680,
    center: targetX === undefined || targetY === undefined,
    backgroundColor: initialBg,
    darkTheme: !LIGHT_THEME_IDS.has(currentTheme),
    autoHideMenuBar: true,
    frame: false, // Completely remove OS title bar; use custom theme-matched top bar
    title: 'winAtmo',
    icon: createTrayNativeImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: shouldShow,
  });

  if (savedBounds?.isMaximized && shouldShow) {
    mainWindow.maximize();
  }

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  mainWindow.on('resize', debouncedSaveMainBounds);
  mainWindow.on('moved', debouncedSaveMainBounds);

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-change', true);
    debouncedSaveMainBounds();
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-change', false);
    debouncedSaveMainBounds();
  });

  if (shouldShow) {
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
  }

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
    if (mainBoundsSaveTimeout) clearTimeout(mainBoundsSaveTimeout);
    saveMainWindowBounds();
    const curSettings = store.getSettings();
    if (!isQuitting && curSettings.minimizeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!store?.getSettings()?.minimizeToTray && isQuitting) {
      if (debugWindow && !debugWindow.isDestroyed()) debugWindow.close();
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close();
    }
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
  const pillWidth = isCompact ? 80 : 95;
  const extraPad = isCompact ? 40 : 48;

  const minSensorsWidth = Math.max(120, pinnedCount * pillWidth + extraPad);
  const defaultCollapsedHeight = isCompact ? 34 : 42;

  const savedW = settings.widgetSize?.width;
  const savedH = settings.widgetSize?.height;
  const collapsedH = savedH ? Math.max(30, Math.round(savedH)) : defaultCollapsedHeight;

  let width: number;
  let height: number;

  if (expanded) {
    const savedExpH = settings.widgetExpandedSize?.height;
    width = Math.min(
      workArea.width,
      savedW
        ? Math.max(120, Math.round(savedW))
        : settings.widgetExpandedSize?.width
          ? Math.max(120, Math.round(settings.widgetExpandedSize.width))
          : minSensorsWidth
    );
    height = Math.min(
      workArea.height - 8,
      savedExpH ? Math.max(140, Math.round(savedExpH)) : 215
    );
  } else {
    width = Math.min(
      workArea.width,
      savedW ? Math.max(120, Math.round(savedW)) : minSensorsWidth
    );
    height = Math.min(workArea.height - 8, collapsedH);
  }

  // Exact saved position if available
  const saved =
    settings.widgetPosition &&
    settings.widgetPosition.x >= workArea.x - 200 &&
    settings.widgetPosition.x <= workArea.x + workArea.width + 100 &&
    settings.widgetPosition.y >= workArea.y - 200 &&
    settings.widgetPosition.y <= workArea.y + workArea.height + 100
      ? settings.widgetPosition
      : undefined;

  let x = saved ? saved.x : workArea.x + workArea.width - width - 16;
  let y = saved
    ? expanded
      ? ExpandedYAdjustment(saved.y, collapsedH, height, workArea)
      : saved.y
    : workArea.y + workArea.height - height - 8;

  // Ensure inside visible bounds of this specific screen without artificial offsets
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));

  return { x, y, width, height };
}

function getOptimalExpandDirection(
  win: BrowserWindow,
  expandedHeight = store?.getSettings()?.widgetExpandedSize?.height || 215
): 'up' | 'down' {
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
  const neededRoom = Math.max(140, expandedHeight) - curH;

  if (centerY < screenMidY) {
    return roomBelow >= neededRoom || roomBelow >= roomAbove ? 'down' : 'up';
  } else {
    return roomAbove >= neededRoom || roomAbove >= roomBelow ? 'up' : 'down';
  }
}

function ExpandedYAdjustment(
  savedY: number,
  collapsedHeight: number,
  targetHeight: number,
  workArea: Electron.Rectangle
): number {
  if (savedY + targetHeight > workArea.y + workArea.height - 4) {
    // Expand upwards keeping the bottom edge aligned with the collapsed bar
    const bottomEdge = savedY + collapsedHeight;
    return Math.max(workArea.y + 4, bottomEdge - targetHeight);
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

  // Restore saved expanded state when creating window cleanly
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    isWidgetExpanded = Boolean(settings.widgetExpanded);
  }

  const bounds = getDefaultWidgetBounds(isWidgetExpanded);

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setAlwaysOnTop(settings.widgetAlwaysOnTop, 'pop-up-menu');
    widgetWindow.setMovable(!settings.widgetLocked);
    // Keep OS window opacity at 1.0 so Windows DWM does not draw a layered rectangular box;
    // transparency is controlled per-pixel via CSS rgba() in TaskbarWidget.tsx.
    widgetWindow.setOpacity(1.0);
    if (autoSizeForSensors && !isWidgetExpanded) {
      widgetTargetSize = { width: bounds.width, height: bounds.height };
      const cur = widgetWindow.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: Math.round(cur.x + cur.width / 2),
        y: Math.round(cur.y + cur.height / 2),
      });
      const workArea = display.workArea;
      const nextX = Math.max(
        workArea.x,
        Math.min(cur.x, workArea.x + workArea.width - bounds.width)
      );
      const nextY = Math.max(
        workArea.y,
        Math.min(cur.y, workArea.y + workArea.height - bounds.height)
      );
      widgetWindow.setBounds({
        x: nextX,
        y: nextY,
        width: bounds.width,
        height: bounds.height,
      });
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
    minWidth: 120,
    minHeight: 30,
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

  if (isWidgetExpanded) {
    const isCompact = settings.theme?.startsWith('compact');
    const defaultCollapsedH = isCompact ? 34 : 42;
    const colW = settings.widgetSize?.width || bounds.width;
    const colH = settings.widgetSize?.height || defaultCollapsedH;
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    });
    const workArea = display.workArea;
    widgetExpandDirection = getOptimalExpandDirection(widgetWindow, bounds.height);
    const colY =
      widgetExpandDirection === 'down'
        ? bounds.y
        : Math.max(workArea.y, bounds.y + bounds.height - colH);
    collapsedBoundsBeforeExpand = {
      x: bounds.x,
      y: colY,
      width: colW,
      height: colH,
    };
  } else {
    collapsedBoundsBeforeExpand = null;
  }

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
    widgetWindow?.on('resize', debouncedSaveWidgetSize);
  });

  let moveSaveTimeout: NodeJS.Timeout | null = null;
  widgetWindow.on('moved', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (moveSaveTimeout) clearTimeout(moveSaveTimeout);
    moveSaveTimeout = setTimeout(() => {
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      const [x, y] = widgetWindow.getPosition();
      const [curW, curH] = widgetWindow.getContentSize();
      if (!isWidgetExpanded) {
        store.updateSettings({ widgetPosition: { x, y } });
        const dir = getOptimalExpandDirection(widgetWindow);
        widgetExpandDirection = dir;
        widgetWindow.webContents.send('widget:direction-updated', dir);
      } else {
        const curSettings = store.getSettings();
        const isCompact = curSettings.theme?.startsWith('compact');
        const colH =
          collapsedBoundsBeforeExpand?.height ||
          curSettings.widgetSize?.height ||
          (isCompact ? 34 : 42);
        const colY = widgetExpandDirection === 'down' ? y : y + curH - colH;
        store.updateSettings({ widgetPosition: { x, y: colY } });
      }
    }, 250);
  });

  widgetWindow.on('close', () => {
    if (widgetSizeSaveTimeout) clearTimeout(widgetSizeSaveTimeout);
    saveWidgetSize();
  });

  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });
}

function createOrShowDebugWindow(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    if (debugWindow.isMinimized()) debugWindow.restore();
    debugWindow.show();
    debugWindow.focus();
    return;
  }

  const settings = store ? store.getSettings() : null;
  const currentTheme = settings ? settings.theme : 'fluent-dark';
  const initialBg = THEME_BG_COLORS[currentTheme] || '#090d16';

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const width = Math.min(1240, Math.max(820, workArea.width - 80));
  const height = Math.min(820, Math.max(560, workArea.height - 80));

  debugWindow = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 520,
    center: true,
    backgroundColor: initialBg,
    darkTheme: !LIGHT_THEME_IDS.has(currentTheme),
    autoHideMenuBar: true,
    frame: false,
    title: 'winAtmo • API & Sync Debug Console',
    icon: createTrayNativeImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: true,
  });

  debugWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  debugWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  debugWindow.on('maximize', () => {
    debugWindow?.webContents.send('window:maximized-change', true);
  });

  debugWindow.on('unmaximize', () => {
    debugWindow?.webContents.send('window:maximized-change', false);
  });

  debugWindow.on('closed', () => {
    debugWindow = null;
  });

  debugWindow.once('ready-to-show', () => {
    if (!debugWindow || debugWindow.isDestroyed()) return;
    if (debugWindow.isMinimized()) debugWindow.restore();
    debugWindow.show();
    debugWindow.focus();
  });

  const entry = getRendererEntryUrl('debug');
  if (entry.isDev) {
    debugWindow.loadURL(entry.url);
  } else {
    debugWindow.loadFile(entry.filePath, { query: { mode: 'debug' } });
  }

  debugWindow.webContents.on('did-fail-load', () => {
    debugWindow?.loadFile(entry.filePath, { query: { mode: 'debug' } });
  });

  debugWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      debugWindow?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

function broadcastToAllWindows(channel: string, payload: any): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send(channel, payload);
  }
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send(channel, payload);
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
        isWidgetExpanded = false;
        collapsedBoundsBeforeExpand = null;
        const next = store.updateSettings({
          widgetPosition: undefined,
          widgetSize: undefined,
          widgetExpanded: false,
          widgetExpandedSize: undefined,
        });
        if (widgetWindow && !widgetWindow.isDestroyed()) {
          const b = getDefaultWidgetBounds(false);
          widgetTargetSize = { width: b.width, height: b.height };
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
      label: 'Start with Windows',
      type: 'checkbox',
      checked: Boolean(settings.launchOnStartup),
      click: () => {
        const nextVal = !settings.launchOnStartup;
        const next = store.updateSettings({
          launchOnStartup: nextVal,
        });
        applyStartupRegistration(nextVal);
        broadcastToAllWindows('settings:updated', next);
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

let tokenAutoUpdateTimer: NodeJS.Timeout | null = null;

function setupTokenAutoUpdate(): void {
  if (tokenAutoUpdateTimer) {
    clearInterval(tokenAutoUpdateTimer);
    tokenAutoUpdateTimer = null;
  }
  // Check token every 3 minutes
  tokenAutoUpdateTimer = setInterval(async () => {
    const session = store.getSession();
    if (!session.loggedIn || session.authMethod === 'demo') return;
    if (store.getSettings().autoUpdateTokens !== false) {
      try {
        const res = await client.autoRefreshToken();
        if (res.refreshed) {
          console.log('[winAtmo] Background token auto-updated successfully.');
          broadcastToAllWindows('account:updated', store.getAccountInfo());
          updateTrayTooltipAndMenu();
        }
      } catch (err) {
        console.warn(
          '[winAtmo] Background token auto-update check failed:',
          err
        );
      }
    }
  }, 3 * 60 * 1000);
}

function setupRefreshSchedule(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const minutes = Math.max(1, store.getSettings().refreshIntervalMinutes || 10);
  refreshTimer = setInterval(async () => {
    const session = store.getSession();
    if (!session.loggedIn) return;

    if (store.getSettings().autoUpdateTokens !== false) {
      try {
        await client.autoRefreshToken();
      } catch {}
    }

    try {
      await client.syncHistoricalData();
      broadcastToAllWindows('stations:updated', store.getCachedStations());
      updateTrayTooltipAndMenu();
    } catch (err) {
      console.warn('[Main] Scheduled refresh error:', err);
    }

    try {
      const securityPayload = await client.fetchSecurityData({ size: 40 });
      broadcastToAllWindows('security:updated', securityPayload);
    } catch (secErr) {
      console.warn('[Main] Scheduled security refresh error:', secErr);
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
    isWidgetExpanded = false;
    collapsedBoundsBeforeExpand = null;
    const updated = store.updateSettings({
      widgetPosition: undefined,
      widgetSize: undefined,
      widgetExpanded: false,
      widgetExpandedSize: undefined,
    });
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const b = getDefaultWidgetBounds(false);
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
      store.updateSettings({ widgetExpanded: expanded });
      return widgetExpandDirection;
    }

    const curBounds = widgetWindow.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: Math.round(curBounds.x + curBounds.width / 2),
      y: Math.round(curBounds.y + curBounds.height / 2),
    });
    const workArea = display.workArea;
    const curSettings = store.getSettings();

    if (expanded) {
      // Save exact collapsed bounds before expanding so we can restore them when closing charts
      if (!isWidgetExpanded) {
        collapsedBoundsBeforeExpand = {
          x: curBounds.x,
          y: curBounds.y,
          width: curBounds.width,
          height: curBounds.height,
        };
      }

      const savedExp = curSettings.widgetExpandedSize;
      const expandedHeight = savedExp?.height
        ? Math.min(workArea.height - 8, Math.max(140, Math.round(savedExp.height)))
        : 215;
      // Keep X width strictly unchanged when clicking expand
      const targetWidth = curBounds.width;

      if (!isWidgetExpanded) {
        widgetExpandDirection = getOptimalExpandDirection(widgetWindow, expandedHeight);
      }

      isWidgetExpanded = true;
      widgetTargetSize = { width: targetWidth, height: expandedHeight };

      let newY: number;
      if (widgetExpandDirection === 'down') {
        // Towards top of display: keep top edge fixed and expand downwards
        newY = curBounds.y;
        if (newY + expandedHeight > workArea.y + workArea.height) {
          newY = Math.max(workArea.y, workArea.y + workArea.height - expandedHeight);
        }
      } else {
        // Towards bottom of display: keep bottom edge fixed and expand upwards
        const bottomEdge = curBounds.y + curBounds.height;
        newY = Math.max(workArea.y, bottomEdge - expandedHeight);
      }

      const newX = Math.max(
        workArea.x,
        Math.min(curBounds.x, workArea.x + workArea.width - targetWidth)
      );

      // Atomically set position and bounds keeping width strictly unchanged
      widgetWindow.setBounds({
        x: newX,
        y: newY,
        width: targetWidth,
        height: expandedHeight,
      });

      const updated = store.updateSettings({
        widgetExpanded: true,
        widgetSize: collapsedBoundsBeforeExpand
          ? {
              width: collapsedBoundsBeforeExpand.width,
              height: collapsedBoundsBeforeExpand.height,
            }
          : curSettings.widgetSize,
        widgetExpandedSize: { width: targetWidth, height: expandedHeight },
      });
      broadcastToAllWindows('settings:updated', updated);
    } else {
      // Closing charts: persist current expanded height while keeping X width unchanged
      const prevExpandedSize = isWidgetExpanded
        ? { width: curBounds.width, height: curBounds.height }
        : curSettings.widgetExpandedSize;

      const savedCollapsed = collapsedBoundsBeforeExpand;
      const isCompact = curSettings.theme?.startsWith('compact');
      const defaultH = isCompact ? 34 : 42;
      const collapsedH =
        savedCollapsed?.height || curSettings.widgetSize?.height || defaultH;
      const targetWidth = curBounds.width;

      isWidgetExpanded = false;
      widgetTargetSize = { width: targetWidth, height: collapsedH };

      let restoreY: number;
      if (
        savedCollapsed &&
        Math.abs(curBounds.x - savedCollapsed.x) <= 12 &&
        (widgetExpandDirection === 'down'
          ? Math.abs(curBounds.y - savedCollapsed.y) <= 12
          : Math.abs(
              curBounds.y + curBounds.height - (savedCollapsed.y + savedCollapsed.height)
            ) <= 16)
      ) {
        // Widget wasn't dragged elsewhere while expanded -> restore exact initial Y
        restoreY = savedCollapsed.y;
      } else if (widgetExpandDirection === 'down') {
        // Minimize upwards to current top edge
        restoreY = curBounds.y;
      } else {
        // Minimize downwards to current bottom edge
        restoreY = curBounds.y + curBounds.height - collapsedH;
      }

      restoreY = Math.max(
        workArea.y,
        Math.min(restoreY, workArea.y + workArea.height - collapsedH)
      );
      const newX = Math.max(
        workArea.x,
        Math.min(curBounds.x, workArea.x + workArea.width - targetWidth)
      );

      collapsedBoundsBeforeExpand = null;
      widgetWindow.setBounds({
        x: newX,
        y: restoreY,
        width: targetWidth,
        height: collapsedH,
      });
      const updated = store.updateSettings({
        widgetExpanded: false,
        widgetExpandedSize: prevExpandedSize,
        widgetPosition: { x: newX, y: restoreY },
        widgetSize: { width: targetWidth, height: collapsedH },
      });
      broadcastToAllWindows('settings:updated', updated);
    }

    return widgetExpandDirection;
  });

  ipcMain.on('widget:move-by', (_e, delta: { dx: number; dy: number }) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (store.getSettings().widgetLocked) return;
    const [curX, curY] = widgetWindow.getPosition();
    const nextX = Math.round(curX + delta.dx);
    const nextY = Math.round(curY + delta.dy);
    widgetWindow.setBounds({
      x: nextX,
      y: nextY,
      width: widgetTargetSize.width,
      height: widgetTargetSize.height,
    });
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
      const maxW = Math.max(120, workArea.width);
      const minH = isWidgetExpanded ? 140 : 30;
      const w = Math.min(maxW, Math.max(120, Math.round(size.width)));
      const h = Math.min(
        Math.max(minH, workArea.height - 8),
        Math.max(minH, Math.round(size.height))
      );
      widgetTargetSize = { width: w, height: h };

      let nextX = curX;
      if (curX + w > workArea.x + workArea.width) {
        nextX = Math.max(workArea.x, workArea.x + workArea.width - w);
      } else if (curX < workArea.x) {
        nextX = workArea.x;
      }

      let nextY = curY;
      if (nextY + h > workArea.y + workArea.height) {
        nextY = Math.max(workArea.y, workArea.y + workArea.height - h);
      } else if (nextY < workArea.y) {
        nextY = workArea.y;
      }

      widgetWindow.setBounds({
        x: nextX,
        y: nextY,
        width: w,
        height: h,
      });

      debouncedSaveWidgetSize();
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
    async (
      _e,
      payload: {
        clientId: string;
        clientSecret: string;
        storeLocally?: boolean;
      }
    ) => {
      const res = await webAuth.startOAuthLogin(
        payload.clientId,
        payload.clientSecret,
        mainWindow || undefined,
        payload.storeLocally !== false
      );
      if (res.success) {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
        broadcastToAllWindows('account:updated', store.getAccountInfo());
        broadcastToAllWindows('settings:updated', store.getSettings());
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
    async (
      _e,
      payload: {
        accessToken: string;
        refreshToken?: string;
        clientId?: string;
        clientSecret?: string;
        storeLocally?: boolean;
      }
    ) => {
      const res = await client.verifyAndSaveWebToken(
        payload.accessToken,
        payload.refreshToken,
        [],
        'token',
        payload.clientId,
        payload.clientSecret,
        payload.storeLocally
      );
      if (res.valid) {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
        broadcastToAllWindows('account:updated', store.getAccountInfo());
        broadcastToAllWindows('settings:updated', store.getSettings());
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

  ipcMain.handle(
    'auth:save-api-keys',
    async (
      _e,
      payload: {
        clientId: string;
        clientSecret: string;
        accessToken?: string;
        refreshToken?: string;
        autoUpdate?: boolean;
      }
    ) => {
      const res = await store.saveApiKeys(payload);
      if (res.success) {
        broadcastToAllWindows('settings:updated', store.getSettings());
        broadcastToAllWindows('account:updated', store.getAccountInfo());
      }
      return res;
    }
  );

  ipcMain.handle('auth:get-stored-keys-info', () => {
    return store.getStoredApiKeysInfo();
  });

  ipcMain.handle('auth:clear-stored-keys', async () => {
    await store.clearStoredApiKeys(true);
    broadcastToAllWindows('settings:updated', store.getSettings());
    broadcastToAllWindows('account:updated', store.getAccountInfo());
    return { success: true };
  });

  ipcMain.handle('auth:refresh-token-now', async () => {
    const res = await client.autoRefreshToken(true);
    if (res.refreshed) {
      broadcastToAllWindows('account:updated', store.getAccountInfo());
      updateTrayTooltipAndMenu();
    }
    return res;
  });

  ipcMain.handle('auth:demo-mode', async () => {
    const res = await client.enableDemoMode();
    broadcastToAllWindows('stations:updated', res.stations);
    broadcastToAllWindows('settings:updated', store.getSettings());
    updateTrayTooltipAndMenu();
    createOrUpdateWidgetWindow();
    return res;
  });

  ipcMain.handle(
    'auth:logout',
    async (
      _e,
      payload?: { eraseDatabase?: boolean; clearStoredKeys?: boolean }
    ) => {
      const wasDemo = store.getSession().authMethod === 'demo';
      await webAuth.clearWebSession();
      store.clearSession(
        Boolean(payload?.eraseDatabase || payload?.clearStoredKeys)
      );
      if (payload?.eraseDatabase) {
        db.clearAllHistory();
        db.clearSecurityData();
      } else if (wasDemo) {
        db.clearDemoHistory();
      }
      broadcastToAllWindows('stations:updated', []);
      broadcastToAllWindows('account:updated', store.getAccountInfo());
      updateTrayTooltipAndMenu();
      createOrUpdateWidgetWindow();
      return { success: true };
    }
  );

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
  ipcMain.handle('storage:stats', async () => {
    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          resolve(db.getStorageStats());
        } catch {
          resolve({
            dbPath: '',
            fileSizeBytes: 0,
            totalPoints: 0,
            moduleCount: 0,
            oldestTimestamp: null,
            newestTimestamp: null,
            securityEventsCount: 0,
            securityCamerasCount: 0,
            securityPersonsCount: 0,
            byScale: [],
          });
        }
      });
    });
  });

  ipcMain.handle('storage:clear', () => {
    return db.clearAllHistory();
  });

  ipcMain.handle('storage:clear-security', () => {
    const stats = db.clearSecurityData();
    broadcastToAllWindows('security:cleared', true);
    return stats;
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
    const isThemeChange = Boolean(partial.theme && partial.theme !== prev.theme);

    if (isThemeChange) {
      // Reset stored widgetSize so the new theme automatically recalculates minimal fit for sensors
      delete partial.widgetSize;
      store.updateSettings({ widgetSize: undefined });
    }

    const updated = store.updateSettings(partial);

    applyNativeWindowTheme(updated.theme);

    if (
      isThemeChange ||
      partial.widgetEnabled !== undefined ||
      partial.widgetAlwaysOnTop !== undefined ||
      partial.widgetOpacity !== undefined ||
      partial.widgetLocked !== undefined ||
      partial.pinnedSensors !== undefined
    ) {
      createOrUpdateWidgetWindow(partial.pinnedSensors !== undefined || isThemeChange);
    }

    if (partial.refreshIntervalMinutes !== undefined) {
      setupRefreshSchedule();
    }

    if (
      partial.launchOnStartup !== undefined &&
      partial.launchOnStartup !== prev.launchOnStartup
    ) {
      applyStartupRegistration(Boolean(partial.launchOnStartup));
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

  // Netatmo Security (Cameras & Event List) IPC
  ipcMain.handle(
    'security:get-cached',
    (_e, homeId?: string) => {
      return client.getCachedSecurityData(homeId);
    }
  );

  ipcMain.handle(
    'security:get-data',
    async (
      _e,
      options?: { homeId?: string; size?: number; offsetEventId?: string }
    ) => {
      return client.fetchSecurityData(options);
    }
  );

  ipcMain.handle(
    'security:refresh-event-image',
    async (
      _e,
      options: {
        homeId: string;
        eventId: string;
        cameraId?: string;
        videoId?: string;
        candidateUrls?: string[];
      }
    ) => {
      return client.refreshSecurityEventImage(options);
    }
  );

  ipcMain.handle(
    'security:get-event-video',
    async (
      _e,
      options: {
        homeId: string;
        cameraId?: string;
        eventId?: string;
        videoId?: string;
      }
    ) => {
      return client.getSecurityEventVideo(options);
    }
  );

  ipcMain.handle(
    'security:get-live-stream',
    async (
      _e,
      options: {
        homeId: string;
        cameraId: string;
      }
    ) => {
      return client.getCameraLiveStream(options);
    }
  );

  ipcMain.handle(
    'security:fetch-media',
    async (
      _e,
      req: {
        url: string;
        responseType?: 'text' | 'arraybuffer';
        headers?: Record<string, string>;
        rangeStart?: number;
        rangeEnd?: number;
      }
    ) => {
      return client.fetchSecurityMedia(req);
    }
  );

  ipcMain.handle(
    'security:set-home-empty',
    async (_e, options: { homeIds: string[] }) => {
      return client.setHomeEmpty(options);
    }
  );

  ipcMain.handle(
    'security:download-snapshot',
    async (
      _e,
      options: {
        homeId: string;
        eventId: string;
        cameraId?: string;
        videoId?: string;
        imageUrl?: string;
        candidateUrls?: string[];
        defaultFileName?: string;
      }
    ) => {
      const resolved = await client.resolveEventSnapshotBuffer(options);
      if (!resolved.ok || !resolved.buffer) {
        return {
          success: false,
          error: resolved.error || 'Snapshot could not be downloaded.',
        };
      }

      const ext = resolved.ext || 'jpg';
      const safeBase = (options.defaultFileName || `netatmo-snapshot-${options.eventId}`)
        .replace(/[<>:"/\\|?*]+/g, '-')
        .replace(/\.[a-z0-9]+$/i, '');

      const { canceled, filePath } = await dialog.showSaveDialog(
        mainWindow || undefined!,
        {
          title: 'Save Camera Snapshot',
          defaultPath: `${safeBase}.${ext}`,
          filters: [
            {
              name: 'Image Files',
              extensions: ext === 'jpg' ? ['jpg', 'jpeg', 'png'] : [ext, 'jpg', 'png'],
            },
          ],
        }
      );

      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }

      try {
        await fs.promises.writeFile(filePath, resolved.buffer);
        return {
          success: true,
          filePath,
          bytesWritten: resolved.buffer.byteLength,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err?.message || 'Failed to save snapshot file.',
        };
      }
    }
  );

  ipcMain.handle(
    'security:download-video',
    async (
      _e,
      options: {
        homeId: string;
        cameraId?: string;
        eventId?: string;
        videoId?: string;
        defaultFileName?: string;
      }
    ) => {
      return client.downloadSecurityEventVideo(
        options,
        async (suggestedExt) => {
          const safeBase = (
            options.defaultFileName ||
            `netatmo-video-${options.eventId || options.videoId || 'clip'}`
          )
            .replace(/[<>:"/\\|?*]+/g, '-')
            .replace(/\.[a-z0-9]+$/i, '');

          const { canceled, filePath } = await dialog.showSaveDialog(
            mainWindow || undefined!,
            {
              title: 'Save Camera Video Clip',
              defaultPath: `${safeBase}.${suggestedExt}`,
              filters: [
                {
                  name: 'Video Files',
                  extensions: suggestedExt === 'mp4' ? ['mp4', 'ts'] : ['ts', 'mp4'],
                },
              ],
            }
          );
          if (canceled || !filePath) return null;
          return filePath;
        },
        async (filePath, data) => {
          await fs.promises.writeFile(filePath, data);
        },
        (progress) => {
          broadcastToAllWindows('security:video-download-progress', progress);
        }
      );
    }
  );

  // Debug Console Window & Telemetry IPC
  ipcMain.on('debug:open-window', () => {
    createOrShowDebugWindow();
  });

  ipcMain.handle('debug:get-snapshot', () => {
    return debugLogger.getSnapshot();
  });

  ipcMain.handle('debug:clear', () => {
    debugLogger.clear();
    return debugLogger.getSnapshot();
  });
}

app.whenReady().then(async () => {
  debugLogger.attachConsoleCapture();
  debugLogger.subscribe((event) => {
    broadcastToAllWindows('debug:stream', event);
  });

  store = new AppStore();
  await store.init();
  db = new TimeSeriesDatabase();
  client = new NetatmoClient(store, db);
  webAuth = new WebAuthManager(store, client);

  client.setSilentRefreshHandler(() => webAuth.silentWebRefresh());
  client.setAccountUpdatedHandler((account: AccountInfo) => {
    broadcastToAllWindows('account:updated', account);
    updateTrayTooltipAndMenu();
  });
  client.setProgressHandler((progress: SyncProgress) => {
    broadcastToAllWindows('sync:progress', progress);
  });
  client.setQueryStatusHandler((status: MeasureQueryStatus) => {
    broadcastToAllWindows('measure:query-status', status);
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

  const isAutostart = process.argv.includes('--autostart');

  // Launch Main Window & Taskbar Widget (if autostarted by Windows, start hidden in tray/widget)
  createMainWindow(!isAutostart);
  createOrUpdateWidgetWindow();
  setupRefreshSchedule();
  setupTokenAutoUpdate();

  if (process.env.WINATMO_CAPTURE_STORE_SCREENSHOTS === '1') {
    setTimeout(async () => {
      try {
        console.log('[Store Screenshots] Enabling demo mode for screenshots...');
        await client.enableDemoMode();
        if (mainWindow) {
          mainWindow.setContentSize(1920, 1080);
          mainWindow.center();
          mainWindow.show();
        }
        const outDir = path.join(process.cwd(), 'dist/store-assets/screenshots');
        fs.mkdirSync(outDir, { recursive: true });

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await sleep(3000);

        // 1. Dashboard
        console.log('[Store Screenshots] Capturing 01-dashboard.png (1920x1080)...');
        let rawImage = await mainWindow!.webContents.capturePage();
        let exactImage = rawImage.resize({ width: 1920, height: 1080, quality: 'best' });
        fs.writeFileSync(path.join(outDir, '01-dashboard.png'), exactImage.toPNG());

        // 2. Diagnostics
        console.log('[Store Screenshots] Switching to Diagnostics and capturing 02-diagnostics.png...');
        await mainWindow!.webContents.executeJavaScript(`
          const pills = document.querySelectorAll('.pill-btn');
          if (pills && pills[3]) pills[3].click();
        `);
        await sleep(1500);
        rawImage = await mainWindow!.webContents.capturePage();
        exactImage = rawImage.resize({ width: 1920, height: 1080, quality: 'best' });
        fs.writeFileSync(path.join(outDir, '02-diagnostics.png'), exactImage.toPNG());

        // 3. Charts
        console.log('[Store Screenshots] Switching to Charts and capturing 03-charts.png...');
        await mainWindow!.webContents.executeJavaScript(`
          const tabs = document.querySelectorAll('.nav-tab-btn');
          if (tabs && tabs[1]) tabs[1].click();
        `);
        await sleep(3000);
        rawImage = await mainWindow!.webContents.capturePage();
        exactImage = rawImage.resize({ width: 1920, height: 1080, quality: 'best' });
        fs.writeFileSync(path.join(outDir, '03-charts.png'), exactImage.toPNG());

        // 4. Settings
        console.log('[Store Screenshots] Switching to Settings and capturing 04-settings.png...');
        await mainWindow!.webContents.executeJavaScript(`
          (() => {
            const tabs = document.querySelectorAll('.nav-tab-btn');
            if (tabs && tabs[2]) {
              tabs[2].click();
              return true;
            }
            return false;
          })()
        `);
        await sleep(2000);
        rawImage = await mainWindow!.webContents.capturePage();
        exactImage = rawImage.resize({ width: 1920, height: 1080, quality: 'best' });
        fs.writeFileSync(path.join(outDir, '04-settings.png'), exactImage.toPNG());

        console.log('[Store Screenshots] All 1920x1080 store screenshots captured successfully!');
        isQuitting = true;
        app.quit();
      } catch (err) {
        console.error('[Store Screenshots] Error capturing screenshots:', err);
        isQuitting = true;
        app.quit();
      }
    }, 1500);
    return;
  }

  // Ensure OS startup registration reflects current user setting
  if (store.getSettings().launchOnStartup) {
    applyStartupRegistration(true);
  }

  // If user is already logged in, check token expiry and kick off an initial sync in background
  if (store.getSession().loggedIn) {
    if (store.getSettings().autoUpdateTokens !== false) {
      client.autoRefreshToken().catch(() => {});
    }
    setTimeout(() => {
      client.syncHistoricalData().then(() => {
        broadcastToAllWindows('stations:updated', store.getCachedStations());
        updateTrayTooltipAndMenu();
      });
      client
        .fetchSecurityData({ size: 40 })
        .then((securityPayload) => {
          broadcastToAllWindows('security:updated', securityPayload);
        })
        .catch(() => {});
    }, 800);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  securityMediaProxy.stop();
  saveMainWindowBounds();
  saveWidgetSize();
  store?.flushSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
