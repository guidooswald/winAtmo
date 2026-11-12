import { contextBridge, ipcRenderer } from 'electron';
import {
  AccountInfo,
  DebugStreamEvent,
  DebugTelemetrySnapshot,
  MeasureQueryRequest,
  MeasureQueryStatus,
  MeasureSeries,
  NetatmoScale,
  SecurityDataPayload,
  SecurityEventImageRefreshResult,
  SecurityEventVideoResult,
  SecurityMediaFetchResult,
  StorageStats,
  StoredApiKeysInfo,
  SyncProgress,
  UserSettings,
  WeatherStation,
} from '../renderer/types';

export interface WinAtmoAPI {
  // Window controls
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (cb: (isMaximized: boolean) => void) => () => void;
  openMainWindow: (focusModuleId?: string, focusMetric?: string) => void;
  platform: string;

  // Widget controls
  toggleWidget: (enabled?: boolean) => Promise<UserSettings>;
  resetWidgetPosition: () => Promise<UserSettings>;
  setWidgetExpanded: (expanded: boolean) => Promise<'up' | 'down'>;
  getWidgetExpandDirection: () => Promise<'up' | 'down'>;
  moveWidgetBy: (dx: number, dy: number) => void;
  resizeWidget: (width: number, height: number) => void;

  // Auth & API Keys
  getAccountInfo: () => Promise<AccountInfo>;
  startWebLogin: () => Promise<{
    success: boolean;
    account?: AccountInfo;
    error?: string;
  }>;
  startOAuthLogin: (
    clientId: string,
    clientSecret: string,
    storeLocally?: boolean
  ) => Promise<{
    success: boolean;
    account?: AccountInfo;
    error?: string;
  }>;
  loginWithToken: (
    accessToken: string,
    refreshToken?: string,
    clientId?: string,
    clientSecret?: string,
    storeLocally?: boolean
  ) => Promise<{
    success: boolean;
    account?: AccountInfo;
    error?: string;
  }>;
  saveApiKeys: (payload: {
    clientId: string;
    clientSecret: string;
    accessToken?: string;
    refreshToken?: string;
    autoUpdate?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  getStoredApiKeysInfo: () => Promise<StoredApiKeysInfo>;
  clearStoredApiKeys: () => Promise<{ success: boolean }>;
  refreshTokenNow: () => Promise<{
    refreshed: boolean;
    expiresAt?: number;
    error?: string;
  }>;
  enableDemoMode: () => Promise<{
    account: AccountInfo;
    stations: WeatherStation[];
  }>;
  logout: (options?: {
    eraseDatabase?: boolean;
    clearStoredKeys?: boolean;
  }) => Promise<{ success: boolean }>;

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
  clearSecurityData: () => Promise<StorageStats>;
  optimizeStorage: () => Promise<StorageStats>;
  exportCsv: (
    series: MeasureSeries[],
    defaultFileName?: string
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>;

  // Settings & External Links
  getSettings: () => Promise<UserSettings>;
  updateSettings: (partial: Partial<UserSettings>) => Promise<UserSettings>;
  openExternal: (url: string) => Promise<void>;

  // Netatmo Security (Cameras & Events)
  getCachedSecurityData: (homeId?: string) => Promise<SecurityDataPayload>;
  getSecurityData: (options?: {
    homeId?: string;
    size?: number;
    offsetEventId?: string;
  }) => Promise<SecurityDataPayload>;
  refreshSecurityEventImage: (options: {
    homeId: string;
    eventId: string;
    cameraId?: string;
    videoId?: string;
    candidateUrls?: string[];
  }) => Promise<SecurityEventImageRefreshResult>;
  getSecurityEventVideo: (options: {
    homeId: string;
    cameraId?: string;
    eventId?: string;
    videoId?: string;
  }) => Promise<SecurityEventVideoResult>;
  fetchSecurityMedia: (req: {
    url: string;
    responseType?: 'text' | 'arraybuffer';
    headers?: Record<string, string>;
    rangeStart?: number;
    rangeEnd?: number;
  }) => Promise<SecurityMediaFetchResult>;

  // Debug Console & Telemetry
  openDebugWindow: () => void;
  getDebugSnapshot: () => Promise<DebugTelemetrySnapshot>;
  clearDebugLogs: () => Promise<DebugTelemetrySnapshot>;

  // Event Subscriptions
  onAccountUpdated: (cb: (account: AccountInfo) => void) => () => void;
  onStationsUpdated: (cb: (stations: WeatherStation[]) => void) => () => void;
  onSyncProgress: (cb: (progress: SyncProgress) => void) => () => void;
  onSettingsUpdated: (cb: (settings: UserSettings) => void) => () => void;
  onWidgetDirectionUpdated: (cb: (dir: 'up' | 'down') => void) => () => void;
  onMeasureQueryStatus: (cb: (status: MeasureQueryStatus) => void) => () => void;
  onFocusSensor: (
    cb: (payload: { moduleId: string; metric?: string }) => void
  ) => () => void;
  onDebugStream: (cb: (event: DebugStreamEvent) => void) => () => void;
  onSecurityCleared: (cb: () => void) => () => void;
}

const api: WinAtmoAPI = {
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (cb: (isMaximized: boolean) => void) => {
    const listener = (_e: any, val: boolean) => cb(val);
    ipcRenderer.on('window:maximized-change', listener);
    return () => ipcRenderer.removeListener('window:maximized-change', listener);
  },
  openMainWindow: (focusModuleId?: string, focusMetric?: string) =>
    ipcRenderer.send('window:open-main', { focusModuleId, focusMetric }),
  platform: process.platform,

  toggleWidget: (enabled?: boolean) =>
    ipcRenderer.invoke('widget:toggle', enabled),
  resetWidgetPosition: () => ipcRenderer.invoke('widget:reset-position'),
  setWidgetExpanded: (expanded: boolean) =>
    ipcRenderer.invoke('widget:set-expanded', expanded),
  getWidgetExpandDirection: () =>
    ipcRenderer.invoke('widget:get-expand-direction'),
  moveWidgetBy: (dx: number, dy: number) =>
    ipcRenderer.send('widget:move-by', { dx, dy }),
  resizeWidget: (width: number, height: number) =>
    ipcRenderer.send('widget:resize', { width, height }),

  getAccountInfo: () => ipcRenderer.invoke('auth:get-account'),
  startWebLogin: () => ipcRenderer.invoke('auth:web-login'),
  startOAuthLogin: (
    clientId: string,
    clientSecret: string,
    storeLocally?: boolean
  ) =>
    ipcRenderer.invoke('auth:oauth-login', {
      clientId,
      clientSecret,
      storeLocally,
    }),
  loginWithToken: (
    accessToken: string,
    refreshToken?: string,
    clientId?: string,
    clientSecret?: string,
    storeLocally?: boolean
  ) =>
    ipcRenderer.invoke('auth:token-login', {
      accessToken,
      refreshToken,
      clientId,
      clientSecret,
      storeLocally,
    }),
  saveApiKeys: (payload) => ipcRenderer.invoke('auth:save-api-keys', payload),
  getStoredApiKeysInfo: () => ipcRenderer.invoke('auth:get-stored-keys-info'),
  clearStoredApiKeys: () => ipcRenderer.invoke('auth:clear-stored-keys'),
  refreshTokenNow: () => ipcRenderer.invoke('auth:refresh-token-now'),
  enableDemoMode: () => ipcRenderer.invoke('auth:demo-mode'),
  logout: (options?: { eraseDatabase?: boolean; clearStoredKeys?: boolean }) =>
    ipcRenderer.invoke('auth:logout', options),

  getCachedStations: () => ipcRenderer.invoke('stations:get-cached'),
  refreshStations: () => ipcRenderer.invoke('stations:refresh'),
  syncHistory: (options) => ipcRenderer.invoke('history:sync', options),
  getSyncProgress: () => ipcRenderer.invoke('history:get-progress'),
  queryMeasureSeries: (req: MeasureQueryRequest) =>
    ipcRenderer.invoke('history:query', req),

  getStorageStats: () => ipcRenderer.invoke('storage:stats'),
  clearHistory: () => ipcRenderer.invoke('storage:clear'),
  clearSecurityData: () => ipcRenderer.invoke('storage:clear-security'),
  optimizeStorage: () => ipcRenderer.invoke('storage:optimize'),
  exportCsv: (series: MeasureSeries[], defaultFileName?: string) =>
    ipcRenderer.invoke('storage:export-csv', { series, defaultFileName }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial: Partial<UserSettings>) =>
    ipcRenderer.invoke('settings:update', partial),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  getCachedSecurityData: (homeId?: string) =>
    ipcRenderer.invoke('security:get-cached', homeId),
  getSecurityData: (options) => ipcRenderer.invoke('security:get-data', options),
  refreshSecurityEventImage: (options) =>
    ipcRenderer.invoke('security:refresh-event-image', options),
  getSecurityEventVideo: (options) =>
    ipcRenderer.invoke('security:get-event-video', options),
  fetchSecurityMedia: (req) => ipcRenderer.invoke('security:fetch-media', req),

  openDebugWindow: () => ipcRenderer.send('debug:open-window'),
  getDebugSnapshot: () => ipcRenderer.invoke('debug:get-snapshot'),
  clearDebugLogs: () => ipcRenderer.invoke('debug:clear'),

  onAccountUpdated: (cb) => {
    const handler = (_e: any, account: AccountInfo) => cb(account);
    ipcRenderer.on('account:updated', handler);
    return () => ipcRenderer.removeListener('account:updated', handler);
  },

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
  onWidgetDirectionUpdated: (cb) => {
    const handler = (_e: any, dir: 'up' | 'down') => cb(dir);
    ipcRenderer.on('widget:direction-updated', handler);
    return () => ipcRenderer.removeListener('widget:direction-updated', handler);
  },
  onMeasureQueryStatus: (cb) => {
    const handler = (_e: any, status: MeasureQueryStatus) => cb(status);
    ipcRenderer.on('measure:query-status', handler);
    return () => ipcRenderer.removeListener('measure:query-status', handler);
  },
  onFocusSensor: (cb) => {
    const handler = (
      _e: any,
      payload: { moduleId: string; metric?: string }
    ) => cb(payload);
    ipcRenderer.on('sensor:focus', handler);
    return () => ipcRenderer.removeListener('sensor:focus', handler);
  },
  onDebugStream: (cb) => {
    const handler = (_e: any, event: DebugStreamEvent) => cb(event);
    ipcRenderer.on('debug:stream', handler);
    return () => ipcRenderer.removeListener('debug:stream', handler);
  },
  onSecurityCleared: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('security:cleared', handler);
    return () => ipcRenderer.removeListener('security:cleared', handler);
  },
};

contextBridge.exposeInMainWorld('winatmo', api);
