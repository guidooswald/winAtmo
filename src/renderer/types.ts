export type MetricType =
  | 'temperature'
  | 'humidity'
  | 'co2'
  | 'pressure'
  | 'noise'
  | 'rain'
  | 'sum_rain'
  | 'windstrength'
  | 'windangle'
  | 'guststrength'
  | 'gustangle';

export type NetatmoScale =
  | 'max'
  | '30min'
  | '1hour'
  | '3hours'
  | '1day'
  | '1week'
  | '1month';

export type ModuleType =
  | 'NAMain'
  | 'NAModule1'
  | 'NAModule2'
  | 'NAModule3'
  | 'NAModule4'
  | 'NHC';

export interface DashboardReadings {
  time_utc: number;
  Temperature?: number;
  Humidity?: number;
  CO2?: number;
  Noise?: number;
  Pressure?: number;
  AbsolutePressure?: number;
  min_temp?: number;
  max_temp?: number;
  date_min_temp?: number;
  date_max_temp?: number;
  temp_trend?: 'up' | 'down' | 'stable';
  pressure_trend?: 'up' | 'down' | 'stable';
  Rain?: number;
  sum_rain_1?: number;
  sum_rain_24?: number;
  WindStrength?: number;
  WindAngle?: number;
  GustStrength?: number;
  GustAngle?: number;
  max_wind_str?: number;
  max_wind_angle?: number;
  date_max_wind_str?: number;
  health_idx?: number;
}

export interface StationModule {
  id: string; // MAC address
  stationId: string; // Parent station MAC address
  stationName: string;
  homeName: string;
  moduleName: string;
  type: ModuleType;
  dataTypes: string[]; // e.g. ['Temperature', 'Humidity', 'CO2']
  availableMetrics: MetricType[];
  reachable: boolean;
  dashboard?: DashboardReadings;
  firmware?: number;
  wifiStatus?: number; // NAMain / NHC: <=56 good, <=71 average, >71 bad
  rfStatus?: number; // NAModule*: <=60 full, <=70 high, <=80 medium, >80 low
  batteryPercent?: number;
  batteryVp?: number; // mV raw battery voltage
  batteryState?: 'full' | 'high' | 'medium' | 'low' | 'very_low';
  lastSeen?: number;
  lastSetup?: number;
  dateSetup?: number;
  co2Calibrating?: boolean;
  readOnly?: boolean;
}

export interface PlaceInfo {
  timezone: string;
  country?: string;
  city?: string;
  altitude?: number;
  location?: [number, number]; // [lon, lat]
}

export interface WeatherStation {
  id: string; // Station MAC address
  stationName: string;
  homeId?: string;
  homeName: string;
  type: ModuleType;
  dateSetup: number;
  lastStatusStore: number;
  reachable: boolean;
  readOnly: boolean;
  isFavorite?: boolean;
  place?: PlaceInfo;
  modules: StationModule[]; // Includes the main indoor station module first, followed by attached modules
}

export interface PinnedSensorItem {
  id: string; // `${stationId}::${moduleId}::${metric}`
  stationId: string;
  moduleId: string;
  moduleName: string;
  stationName: string;
  metric: MetricType;
  customLabel?: string;
  color?: string;
}

export interface MeasurePoint {
  ts: number; // Unix timestamp in seconds
  value: number;
}

export interface SeriesStats {
  min: number;
  max: number;
  avg: number;
  latest: number;
  first: number;
  delta: number;
  count: number;
}

export interface MeasureSeries {
  seriesKey: string; // `${moduleId}::${metric}`
  stationId: string;
  moduleId: string;
  moduleName: string;
  stationName: string;
  metric: MetricType;
  scale: NetatmoScale;
  points: MeasurePoint[];
  stats: SeriesStats;
}

export interface MeasureQueryRequest {
  items: Array<{
    stationId: string;
    moduleId: string;
    moduleName: string;
    stationName: string;
    metric: MetricType;
  }>;
  scale: NetatmoScale;
  dateBegin: number; // Unix seconds
  dateEnd: number; // Unix seconds
  forceRemoteFetch?: boolean;
}

export interface StorageStats {
  dbPath: string;
  fileSizeBytes: number;
  totalPoints: number;
  moduleCount: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  byScale: Array<{
    scale: string;
    count: number;
    oldest: number;
    newest: number;
  }>;
}

export interface SyncProgress {
  active: boolean;
  phase: 'idle' | 'stations' | 'history' | 'done' | 'error';
  message: string;
  completedModules: number;
  totalModules: number;
  pointsStored: number;
  lastSyncAt?: number;
  error?: string;
}

export interface AccountInfo {
  loggedIn: boolean;
  email?: string;
  userId?: string;
  authMethod?: 'web' | 'oauth' | 'token' | 'demo';
  country?: string;
  locale?: string;
  tokenExpiresAt?: number;
}

export type ThemeId =
  // 1. Modern Fluent (14px Smooth Rounded • Segoe UI)
  | 'fluent-dark'
  | 'fluent-light'
  // 2. Compact Density (Small 11px Font • 6px Gaps • 4px Radius)
  | 'compact-dark'
  | 'compact-light'
  // 3. Cyber Terminal (0px Squared • Cascadia Monospace)
  | 'terminal-dark'
  | 'terminal-light'
  // 4. Nordic Minimalist (10px Balanced • System Sans)
  | 'nord-dark'
  | 'nord-light'
  // 5. Neo-Brutalist (2px Hard Edge • 2px Thick Borders)
  | 'brutal-dark'
  | 'brutal-light'
  // 6. Soft Organic (20px Soft Pill • Quicksand / Rounded)
  | 'soft-dark'
  | 'soft-light'
  // Legacy aliases for backward compatibility:
  | 'dark'
  | 'light'
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'tokyo-night'
  | 'dracula'
  | 'nord-dark'
  | 'oled-black'
  | 'solarized-light'
  | 'rose-pine-dawn'
  | 'github-light';

export interface MainWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export interface UserSettings {
  historyDays: number; // Default 14 days, up to 3650+ or max
  historyMaxMode: boolean; // When true, loads from station's date_setup (max Netatmo allows)
  defaultScale: NetatmoScale; // Default '30min'
  refreshIntervalMinutes: number; // Default 5
  temperatureUnit: 'C' | 'F';
  pressureUnit: 'mbar' | 'hPa' | 'inHg' | 'mmHg';
  windUnit: 'kph' | 'ms' | 'mph' | 'kn';
  rainUnit: 'mm' | 'in';
  theme: ThemeId;
  widgetEnabled: boolean;
  widgetAlwaysOnTop: boolean;
  widgetLocked: boolean;
  widgetOpacity: number;
  widgetCompact: boolean;
  widgetPosition?: { x: number; y: number };
  widgetSize?: { width: number; height: number };
  mainWindowBounds?: MainWindowBounds;
  pinnedSensors: PinnedSensorItem[];
  taskbarDisplayMode: 'sensor' | 'icon'; // Default 'sensor' (show sensor reading instead of icon in taskbar)
  taskbarSensorTarget: string; // Default 'outdoor_temp' (outside temperature)
  oauthClientId?: string;
  oauthClientSecret?: string;
  minimizeToTray: boolean;
  launchOnStartup: boolean;
}

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface SessionData {
  loggedIn: boolean;
  authMethod: 'web' | 'oauth' | 'token' | 'demo';
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  userId?: string;
  country?: string;
  locale?: string;
  cookies: StoredCookie[];
  apiBase?: 'app.netatmo.net' | 'api.netatmo.com';
}
