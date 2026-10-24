import { contextBridge, ipcRenderer } from 'electron';
import {
  AccountInfo,
  MeasureQueryRequest,
  MeasureSeries,
  NetatmoScale,
  StorageStats,
  SyncProgress,
  UserSettings,
  WeatherStation,
} from '../renderer/types';

export interface WinAtmoAPI {
  // Window controls
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  openMainWindow: (focusModuleId?: string, focusMetric?: string) => void;

  // Widget controls
  toggleWidget: (enabled?: boolean) => Promise<UserSettings>;
  resetWidgetPosition: () => Promise<UserSettings>;
  setWidgetExpanded: (expanded: boolean) => Promise<'up' | 'down'>;
  moveWidgetBy: (dx: number, dy: number) => void;
  resizeWidget: (width: number, height: number) => void;

  // Auth
  getAccountInfo: () => Promise<AccountInfo>;
  startWebLogin: () => Promise<{
    success: boolean;
    account?: AccountInfo;
    error?: string;
  }>;
  startOAuthLogin: (
    clientId: string,
    clientSecret: string
  ) => Promise<{
    success: boolean;
    account?: AccountInfo;
    error?: string;
  }>;
  loginWithToken: (
    accessToken: string,
    refreshToken?: string
  ) => Promise<{
    success: boolean;
    account?: AccountInfo;
    error?: string;
  }>;
  enableDemoMode: () => Promise<{
    account: AccountInfo;
    stations: WeatherStation[];
  }>;
  logout: () => Promise<void>;

  // Stations & Historical Sync
  getCachedStations: () => Promise<{
    stations: WeatherStation[];
    lastSyncAt?: number;
  }>;
  refreshStations: () => Promise<WeatherStation[]>;
  syncHistory: (options?: {
    forceFull?: boolean;
    customDays?: number;
    scale?: NetatmoScale;
  }) => Promise<SyncProgress>;
  getSyncProgress: () => Promise<SyncProgress>;
  queryMeasureSeries: (req: MeasureQueryRequest) => Promise<MeasureSeries[]>;

  // Storage & Export
  getStorageStats: () => Promise<StorageStats>;
  clearHistory: () => Promise<StorageStats>;
  optimizeStorage: () => Promise<StorageStats>;
  exportCsv: (
    series: MeasureSeries[],
    defaultFileName?: string
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>;

  // Settings & External Links
  getSettings: () => Promise<UserSettings>;
  updateSettings: (partial: Partial<UserSettings>) => Promise<UserSettings>;
  openExternal: (url: string) => Promise<void>;

  // Event Subscriptions
  onStationsUpdated: (cb: (stations: WeatherStation[]) => void) => () => void;
  onSyncProgress: (cb: (progress: SyncProgress) => void) => () => void;
  onSettingsUpdated: (cb: (settings: UserSettings) => void) => () => void;
  onFocusSensor: (
    cb: (payload: { moduleId: string; metric?: string }) => void
  ) => () => void;
}

const api: WinAtmoAPI = {
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  openMainWindow: (focusModuleId?: string, focusMetric?: string) =>
    ipcRenderer.send('window:open-main', { focusModuleId, focusMetric }),

  toggleWidget: (enabled?: boolean) =>
    ipcRenderer.invoke('widget:toggle', enabled),
  resetWidgetPosition: () => ipcRenderer.invoke('widget:reset-position'),
  setWidgetExpanded: (expanded: boolean) =>
    ipcRenderer.invoke('widget:set-expanded', expanded),
  moveWidgetBy: (dx: number, dy: number) =>
    ipcRenderer.send('widget:move-by', { dx, dy }),
  resizeWidget: (width: number, height: number) =>
    ipcRenderer.send('widget:resize', { width, height }),

  getAccountInfo: () => ipcRenderer.invoke('auth:get-account'),
  startWebLogin: () => ipcRenderer.invoke('auth:web-login'),
  startOAuthLogin: (clientId: string, clientSecret: string) =>
    ipcRenderer.invoke('auth:oauth-login', { clientId, clientSecret }),
  loginWithToken: (accessToken: string, refreshToken?: string) =>
    ipcRenderer.invoke('auth:token-login', { accessToken, refreshToken }),
  enableDemoMode: () => ipcRenderer.invoke('auth:demo-mode'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  getCachedStations: () => ipcRenderer.invoke('stations:get-cached'),
  refreshStations: () => ipcRenderer.invoke('stations:refresh'),
  syncHistory: (options) => ipcRenderer.invoke('history:sync', options),
  getSyncProgress: () => ipcRenderer.invoke('history:get-progress'),
  queryMeasureSeries: (req: MeasureQueryRequest) =>
    ipcRenderer.invoke('history:query', req),

  getStorageStats: () => ipcRenderer.invoke('storage:stats'),
  clearHistory: () => ipcRenderer.invoke('storage:clear'),
  optimizeStorage: () => ipcRenderer.invoke('storage:optimize'),
  exportCsv: (series: MeasureSeries[], defaultFileName?: string) =>
    ipcRenderer.invoke('storage:export-csv', { series, defaultFileName }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial: Partial<UserSettings>) =>
    ipcRenderer.invoke('settings:update', partial),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  onStationsUpdated: (cb) => {
    const handler = (_e: any, stations: WeatherStation[]) => cb(stations);
    ipcRenderer.on('stations:updated', handler);
    return () => ipcRenderer.removeListener('stations:updated', handler);
  },
  onSyncProgress: (cb) => {
    const handler = (_e: any, progress: SyncProgress) => cb(progress);
    ipcRenderer.on('sync:progress', handler);
    return () => ipcRenderer.removeListener('sync:progress', handler);
  },
  onSettingsUpdated: (cb) => {
    const handler = (_e: any, settings: UserSettings) => cb(settings);
    ipcRenderer.on('settings:updated', handler);
    return () => ipcRenderer.removeListener('settings:updated', handler);
  },
  onFocusSensor: (cb) => {
    const handler = (
      _e: any,
      payload: { moduleId: string; metric?: string }
    ) => cb(payload);
    ipcRenderer.on('sensor:focus', handler);
    return () => ipcRenderer.removeListener('sensor:focus', handler);
  },
};

contextBridge.exposeInMainWorld('winatmo', api);
