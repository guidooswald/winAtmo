/**
 * @module renderer/types
 * Shared TypeScript domain contracts used across the Electron main process, preload bridge, and React UI.
 */

/** Supported Netatmo weather telemetry metric identifiers. */
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

/** Time-aggregation bucket granularities supported by Netatmo `getmeasure` queries. */
export type NetatmoScale =
  | 'max'
  | '30min'
  | '1hour'
  | '3hours'
  | '1day'
  | '1week'
  | '1month';

/** Netatmo Weather Station and Healthy Home Coach hardware module type codes. */
export type ModuleType =
  | 'NAMain'
  | 'NAModule1'
  | 'NAModule2'
  | 'NAModule3'
  | 'NAModule4'
  | 'NHC';

/** Live sensor readings snapshot reported on a station module's dashboard. */
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

/** Normalized weather station base unit or wireless add-on module descriptor. */
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

/** Geographic metadata and coordinates associated with a weather station. */
export interface PlaceInfo {
  timezone: string;
  country?: string;
  city?: string;
  altitude?: number;
  location?: [number, number]; // [lon, lat]
}

/** Weather station home grouping containing the base unit and all attached modules. */
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

/** Sensor metric item pinned to the taskbar widget or chart workspace. */
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

/** Single timestamped time-series sample in Unix seconds. */
export interface MeasurePoint {
  ts: number; // Unix timestamp in seconds
  value: number;
}

/** Precomputed summary statistics for a queried sensor time series. */
export interface SeriesStats {
  min: number;
  max: number;
  avg: number;
  latest: number;
  first: number;
  delta: number;
  count: number;
}

/** Historical measurement time series and statistics for a single module metric. */
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
  source?: 'local_database' | 'netatmo_api';
}

/** Source indicator emitted when serving a measurement query from SQLite or Netatmo API. */
export interface MeasureQueryStatus {
  source: 'local_database' | 'netatmo_api';
  scale: NetatmoScale;
}

/** Request parameters for fetching historical sensor series across one or more modules. */
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

/** SQLite database file size and per-scale record counts. */
export interface StorageStats {
  dbPath: string;
  fileSizeBytes: number;
  totalPoints: number;
  moduleCount: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  securityEventsCount: number;
  securityCamerasCount: number;
  securityPersonsCount: number;
  byScale: Array<{
    scale: string;
    count: number;
    oldest: number;
    newest: number;
  }>;
}

/** Live background synchronization progress state broadcast to the UI overlay. */
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

/** Authenticated Netatmo account metadata exposed to the renderer process. */
export interface AccountInfo {
  loggedIn: boolean;
  email?: string;
  userId?: string;
  authMethod?: 'web' | 'oauth' | 'token' | 'demo';
  country?: string;
  locale?: string;
  tokenExpiresAt?: number;
  hasStoredKeys?: boolean;
  autoUpdateEnabled?: boolean;
}

/** Non-secret summary of locally stored OAuth client credentials and refresh flags. */
export interface StoredApiKeysInfo {
  hasStoredKeys: boolean;
  storeApiKeysLocally: boolean;
  autoUpdateTokens: boolean;
  clientId?: string;
  hasClientSecret: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  tokenExpiresAt?: number;
  filePath?: string;
  updatedAt?: number;
}

/** Visual design family grouping built-in and custom UI themes. */
export type ThemeFamily =
  | 'fluent'
  | 'compact'
  | 'terminal'
  | 'nord'
  | 'brutal'
  | 'soft'
  | 'custom';

/** Persisted user-created or imported theme definition stored in SQLite. */
export interface CustomThemeRecord {
  id: string;
  name: string;
  family: ThemeFamily;
  familyTitle: string;
  styleLabel: string;
  subtitle: string;
  mode: 'dark' | 'light';
  swatches: [string, string, string, string];
  widgetBgRgb: string;
  vars: Record<string, string>;
  isCustom: true;
  createdAt?: number;
  updatedAt?: number;
}

/** Identifier of a built-in preset theme or dynamic custom theme ID. */
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
  // Custom user-defined themes stored in SQLite
  | `custom-${string}`
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

/** Saved main window geometry and maximization state. */
export interface MainWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

/** Supported UI display language codes. */
export type LanguageId =
  | 'en'
  | 'de'
  | 'fr'
  | 'es'
  | 'pt'
  | 'it'
  | 'pl'
  | 'cs'
  | 'el';

/** Persisted user preferences for units, sync intervals, widget placement, layout, and theming. */
export interface UserSettings {
  language: LanguageId; // Default 'en', supports de, fr, es, pt, it, pl, cs, el
  historyDays: number; // Default 14 days, up to 3650+ or max
  historyMaxMode: boolean; // When true, loads from station's date_setup (max Netatmo allows)
  defaultScale: NetatmoScale; // Default '30min'
  refreshIntervalMinutes: number; // Default 10
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
  widgetExpanded?: boolean;
  widgetExpandedSize?: { width: number; height: number };
  mainWindowBounds?: MainWindowBounds;
  pinnedSensors: PinnedSensorItem[];
  taskbarDisplayMode: 'sensor' | 'icon'; // Default 'sensor' (show sensor reading instead of icon in taskbar)
  taskbarSensorTarget: string; // Default 'outdoor_temp' (outside temperature)
  taskbarTextColor?: string; // 'auto' (semantic color) or hex color (e.g. '#ffffff')
  oauthClientId?: string;
  oauthClientSecret?: string;
  storeApiKeysLocally: boolean; // When true, stores API keys locally in an encrypted file
  autoUpdateTokens: boolean; // When true, automatically refreshes OAuth and personal tokens before expiry
  storeSecurityData: boolean; // When true (default), stores cameras, persons, and events in SQLite
  minimizeToTray: boolean;
  launchOnStartup: boolean;
}

/** Serialized session cookie captured during Netatmo web login. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
}

/** Encrypted authentication state persisted by `AppStore`. */
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

/** Severity level for debug console log entries. */
export type DebugLogLevel = 'info' | 'warn' | 'error' | 'debug';
/** Functional domain tag assigned to debug logs and API request traces. */
export type DebugSourceDomain = 'weather' | 'security' | 'auth';

/** Structured application diagnostic log entry. */
export interface DebugLogEntry {
  id: string;
  timestamp: number;
  level: DebugLogLevel;
  category: string;
  source?: DebugSourceDomain;
  message: string;
  details?: string;
}

/** Captured HTTP API call trace including redacted headers, latency, and response body preview. */
export interface ApiRequestLogEntry {
  id: string;
  timestamp: number;
  method: string;
  endpoint: string;
  baseHost: string;
  url: string;
  source?: DebugSourceDomain;
  status: number | null;
  ok: boolean;
  durationMs: number;
  bytesReceived: number;
  transferRateBytesPerSec: number;
  error?: string;
  rawBodyPreview?: string;
  rawBodyTruncated?: boolean;
  note?: string;
}

/** Aggregate request counts, transfer totals, and buffer sizes for the Debug Console. */
export interface DebugTelemetryStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalBytesReceived: number;
  totalDurationMs: number;
  averageLatencyMs: number;
  averageTransferRateBps: number;
  lastTransferRateBps: number;
  rateLimitHits: number;
  lastRateLimitAt?: number;
  lastRateLimitEndpoint?: string;
  lastRateLimitMessage?: string;
  startedAt: number;
}

/** Combined logs, API trace entries, and counters returned to the Debug Console on load. */
export interface DebugTelemetrySnapshot {
  logs: DebugLogEntry[];
  apiRequests: ApiRequestLogEntry[];
  stats: DebugTelemetryStats;
}

/** Incremental real-time event pushed from the main process to open Debug Console windows. */
export interface DebugStreamEvent {
  type: 'log' | 'api' | 'clear';
  logEntry?: DebugLogEntry;
  apiEntry?: ApiRequestLogEntry;
  stats: DebugTelemetryStats;
}

/** Netatmo Security camera or doorbell hardware model identifier. */
export type SecurityCameraType = 'NACamera' | 'NOC' | 'NDB' | string;

/** Normalized Netatmo Security camera status, VPN stream endpoints, and floodlight state. */
export interface SecurityCamera {
  id: string;
  homeId: string;
  homeName: string;
  name: string;
  type: SecurityCameraType;
  roomName?: string;
  monitoring?: string; // 'on' | 'off'
  status?: string; // 'on' | 'off'
  sdStatus?: string | number;
  alimStatus?: string | number;
  wifiStrength?: number;
  wifiState?: string;
  firmwareRevision?: number | string;
  isLocal?: boolean;
  floodlight?: SecurityFloodlightMode | string; // 'on' | 'off' | 'auto'
  sirenStatus?: string;
  lastSetup?: number;
  vpnUrl?: string;
  localUrl?: string;
}

/** Registered household member tracked by Netatmo Welcome face recognition. */
export interface SecurityPerson {
  id: string;
  homeId: string;
  pseudo?: string;
  outOfSight?: boolean;
  lastSeen?: number;
  faceUrl?: string;
}

/** Detailed sub-event belonging to a composite Netatmo camera timeline event. */
export interface SecuritySubEvent {
  id?: string;
  type: string;
  time: number;
  offset?: number;
  message?: string;
  snapshotUrl?: string;
  snapshotExpiresAt?: number;
  vignetteUrl?: string;
  personId?: string;
}

/** Normalized security camera or person timeline event with snapshot and video links. */
export interface SecurityEvent {
  id: string;
  homeId: string;
  homeName: string;
  cameraId?: string;
  cameraName?: string;
  type: string;
  subType?: number;
  time: number;
  category?: string;
  message: string;
  personId?: string;
  personName?: string;
  snapshotUrl?: string;
  snapshotExpiresAt?: number;
  vignetteUrl?: string;
  videoId?: string;
  videoStatus?: string;
  subEvents?: SecuritySubEvent[];
}

/** Netatmo Security home container grouping cameras and recognized persons. */
export interface SecurityHome {
  id: string;
  name: string;
  timezone?: string;
  cameras: SecurityCamera[];
  persons: SecurityPerson[];
}

/** Full normalized security snapshot combining homes and recent timeline events. */
export interface SecurityDataPayload {
  homes: SecurityHome[];
  events: SecurityEvent[];
  fetchedAt: number;
  scopeError?: string;
}

/** Fresh snapshot/vignette URLs returned when refreshing an expired event image. */
export interface SecurityEventImageRefreshResult {
  ok: boolean;
  imageUrl?: string;
  vignetteUrl?: string;
  snapshotExpiresAt?: number;
  event?: SecurityEvent;
  error?: string;
}

/** Resolved HLS playback URL and fallback candidates for a live camera or recorded event clip. */
export interface SecurityEventVideoResult {
  ok: boolean;
  hlsUrl?: string;
  localHlsUrl?: string;
  fallbackHlsUrls?: string[];
  vpnUrl?: string;
  localUrl?: string;
  isLocalStream?: boolean;
  isDemo?: boolean;
  needsAccessScope?: boolean;
  error?: string;
}

/** Result of an authenticated main-process fetch for camera snapshots, playlists, or segments. */
export interface SecurityMediaFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  finalUrl: string;
  contentType?: string;
  dataText?: string;
  dataBuffer?: Uint8Array;
  error?: string;
}

/** Operating mode for Netatmo Presence outdoor camera floodlights. */
export type SecurityFloodlightMode = 'auto' | 'on' | 'off';

/** Response returned after updating a camera floodlight mode. */
export interface SetCameraFloodlightResult {
  ok: boolean;
  mode?: SecurityFloodlightMode;
  via?: 'setstate' | 'local' | 'vpn' | 'demo';
  error?: string;
  needsWriteScope?: boolean;
}

/** Response returned after marking household persons as away from home. */
export interface SetPersonsAwayResult {
  ok: boolean;
  error?: string;
  needsWriteScope?: boolean;
}

/** Outcome and output file metrics of saving an HLS camera clip or live recording. */
export interface SecurityDownloadResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  bytesWritten?: number;
  segmentCount?: number;
  error?: string;
}

/** Incremental progress payload emitted while downloading an HLS camera video. */
export interface SecurityVideoDownloadProgress {
  eventId?: string;
  videoId?: string;
  cameraId?: string;
  phase: 'resolving' | 'downloading' | 'writing' | 'done' | 'error' | 'canceled';
  completedSegments: number;
  totalSegments: number;
  bytesDownloaded: number;
  percent: number;
  message?: string;
}

/** Supported precipitation radar upstream source identifier. */
export type RadarProvider = 'dwd' | 'rainviewer';

/** Single past, current, or nowcast radar frame descriptor. */
export interface RadarFrame {
  timestampSec: number;
  isoTime: string;
  kind: 'past' | 'now' | 'forecast';
  tilePath?: string;
  wmsLayer?: string;
}

/** Radar timeline metadata, proxy coordinates, and layer attribution for the map view. */
export interface RadarMetadataPayload {
  provider: RadarProvider;
  fetchedAt: number;
  cacheProxyUrl?: string;
  cacheProxyToken?: string;
  host?: string;
  wmsUrl?: string;
  wmsLayer?: string;
  maxNativeZoom: number;
  frames: RadarFrame[];
  defaultFrameIndex: number;
  attribution: string;
  coverageNote: string;
  fallbackUsed?: boolean;
  error?: string;
}
