import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  screen,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { AppStore } from './store';
import { TimeSeriesDatabase } from './database';
import { NetatmoClient } from './netatmoClient';
import { WebAuthManager } from './webAuth';
import {
  MeasureQueryRequest,
  MeasureSeries,
  NetatmoScale,
  SyncProgress,
  UserSettings,
  WeatherStation,
} from '../renderer/types';

app.name = 'winAtmo';

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let refreshTimer: NodeJS.Timeout | null = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
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
  const isDev = process.env.NODE_ENV === 'development';
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5190';
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

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    title: 'winAtmo — Netatmo Weather & Air Quality Studio',
    icon: createTrayNativeImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    show: true,
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

function getDefaultWidgetBounds(expanded = false): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const primary = screen.getPrimaryDisplay();
  const workArea = primary.workArea;
  const settings = store.getSettings();
  const pinnedCount = Math.max(1, settings.pinnedSensors.length || 3);

  const width = expanded
    ? Math.min(540, Math.max(360, pinnedCount * 135))
    : Math.min(520, Math.max(310, pinnedCount * 118 + 64));
  const height = expanded ? 210 : 48;

  // Position cleanly docked at bottom-right just above the Windows Taskbar
  const saved = settings.widgetPosition;
  let x = saved ? saved.x : workArea.x + workArea.width - width - 16;
  let y = saved
    ? ExpandedYAdjustment(saved.y, height, workArea)
    : workArea.y + workArea.height - height - 8;

  // Ensure inside visible bounds
  x = Math.max(workArea.x + 4, Math.min(x, workArea.x + workArea.width - width - 4));
  y = Math.max(workArea.y + 4, Math.min(y, workArea.y + workArea.height - height - 4));

  return { x, y, width, height };
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

function createOrUpdateWidgetWindow(): void {
  const settings = store.getSettings();

  if (!settings.widgetEnabled) {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      widgetWindow.close();
      widgetWindow = null;
    }
    return;
  }

  const bounds = getDefaultWidgetBounds(false);

  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setAlwaysOnTop(settings.widgetAlwaysOnTop, 'pop-up-menu');
    widgetWindow.setOpacity(Math.max(0.4, Math.min(1, settings.widgetOpacity || 0.94)));
    widgetWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: widgetWindow.getBounds().height,
    });
    widgetWindow.showInactive();
    return;
  }

  widgetWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: !settings.widgetLocked,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.widgetAlwaysOnTop,
    hasShadow: true,
    backgroundColor: '#00000000',
    title: 'winAtmo Taskbar Widget',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    show: false,
  });

  widgetWindow.setAlwaysOnTop(settings.widgetAlwaysOnTop, 'pop-up-menu');
  widgetWindow.setOpacity(Math.max(0.4, Math.min(1, settings.widgetOpacity || 0.94)));

  const entry = getRendererEntryUrl('widget');
  if (entry.isDev) {
    widgetWindow.loadURL(entry.url);
  } else {
    widgetWindow.loadFile(entry.filePath, { query: { mode: 'widget' } });
  }

  widgetWindow.webContents.on('did-fail-load', () => {
    widgetWindow?.loadFile(entry.filePath, { query: { mode: 'widget' } });
  });

  widgetWindow.once('ready-to-show', () => {
    widgetWindow?.showInactive();
  });

  widgetWindow.on('moved', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const b = widgetWindow.getBounds();
    if (b.height <= 60) {
      store.updateSettings({ widgetPosition: { x: b.x, y: b.y } });
    }
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
  const lines: string[] = ['winAtmo — Netatmo Weather Monitor'];

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

  const contextMenu = Menu.buildFromTemplate([
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
    },
  ]);

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
      const b = getDefaultWidgetBounds(false);
      widgetWindow.setBounds(b);
    }
    broadcastToAllWindows('settings:updated', updated);
    return updated;
  });

  ipcMain.handle('widget:set-expanded', (_e, expanded: boolean) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const currentBounds = widgetWindow.getBounds();
    const target = getDefaultWidgetBounds(expanded);
    const primary = screen.getPrimaryDisplay().workArea;

    // Keep bottom edge anchored near current bottom edge
    const bottomEdge = currentBounds.y + currentBounds.height;
    const newY = Math.max(
      primary.y + 8,
      Math.min(bottomEdge - target.height, primary.y + primary.height - target.height - 4)
    );

    widgetWindow.setBounds({
      x: currentBounds.x,
      y: newY,
      width: target.width,
      height: target.height,
    });
  });

  ipcMain.on('widget:move-by', (_e, delta: { dx: number; dy: number }) => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    if (store.getSettings().widgetLocked) return;
    const b = widgetWindow.getBounds();
    const nextX = Math.round(b.x + delta.dx);
    const nextY = Math.round(b.y + delta.dy);
    widgetWindow.setPosition(nextX, nextY);
    store.updateSettings({ widgetPosition: { x: nextX, y: nextY } });
  });

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
    return store.getSettings();
  });

  ipcMain.handle('settings:update', async (_e, partial: Partial<UserSettings>) => {
    const prev = store.getSettings();
    const updated = store.updateSettings(partial);

    if (
      partial.widgetEnabled !== undefined ||
      partial.widgetAlwaysOnTop !== undefined ||
      partial.widgetOpacity !== undefined ||
      partial.widgetLocked !== undefined ||
      partial.pinnedSensors !== undefined
    ) {
      createOrUpdateWidgetWindow();
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
    if (url.startsWith('https://') || url.startsWith('http://')) {
      await shell.openExternal(url);
    }
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

  // Create System Tray
  tray = new Tray(createTrayNativeImage());
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
