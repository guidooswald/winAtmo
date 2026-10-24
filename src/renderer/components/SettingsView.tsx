import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Database,
  ExternalLink,
  Globe,
  HardDrive,
  KeyRound,
  LayoutGrid,
  Lock,
  Moon,
  Palette,
  Pin,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Sun,
  Trash2,
  Unlock,
} from 'lucide-react';
import {
  AccountInfo,
  NetatmoScale,
  StorageStats,
  SyncProgress,
  UserSettings,
  WeatherStation,
} from '../types';
import { METRIC_METADATA } from '../utils/metrics';
import { getThemeDefinition, THEMES } from '../utils/themes';

interface SettingsViewProps {
  settings: UserSettings;
  account: AccountInfo;
  stations: WeatherStation[];
  syncProgress: SyncProgress;
  onUpdateSettings: (partial: Partial<UserSettings>) => Promise<void>;
  onSyncNow: (forceFull?: boolean) => Promise<void>;
  onStartWebLogin: () => Promise<void>;
  onStartOAuthLogin: (clientId: string, clientSecret: string) => Promise<void>;
  onTokenLogin: (token: string, refresh?: string) => Promise<void>;
  onLogout: () => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  account,
  stations,
  syncProgress,
  onUpdateSettings,
  onSyncNow,
  onStartWebLogin,
  onStartOAuthLogin,
  onTokenLogin,
  onLogout,
}) => {
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [customDaysInput, setCustomDaysInput] = useState<number>(
    settings.historyDays || 14
  );
  const [oauthClientId, setOauthClientId] = useState<string>(
    settings.oauthClientId || ''
  );
  const [oauthClientSecret, setOauthClientSecret] = useState<string>(
    settings.oauthClientSecret || ''
  );
  const [manualToken, setManualToken] = useState<string>('');
  const [manualRefresh, setManualRefresh] = useState<string>('');

  const loadStats = async () => {
    try {
      const st = await window.winatmo.getStorageStats();
      setStorageStats(st);
    } catch {}
  };

  useEffect(() => {
    loadStats();
  }, [syncProgress.pointsStored, syncProgress.phase]);

  useEffect(() => {
    setCustomDaysInput(settings.historyDays);
  }, [settings.historyDays]);

  const earliestStationSetup =
    stations.length > 0
      ? Math.min(...stations.map((s) => s.dateSetup || Date.now() / 1000))
      : null;

  const maxStationDays = earliestStationSetup
    ? Math.max(
        14,
        Math.ceil((Date.now() / 1000 - earliestStationSetup) / 86400)
      )
    : 1825;

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="settings-container">
      {/* 1. Historical Data Window & Cloud Sync */}
      <div className="settings-card highlight-border">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Database size={18} className="accent-icon" />
            <div>
              <h3>Historical Sensor Data Window & Sync</h3>
              <p>
                Per default winAtmo loads the last{' '}
                <strong>14 days</strong> of sensor history. Increase this up to
                the maximum Netatmo allows (all history since station setup).
              </p>
            </div>
          </div>
          <span className="active-window-badge">
            {settings.historyMaxMode
              ? `Maximum Allowed (~${maxStationDays} Days Since Setup)`
              : `${settings.historyDays} Days`}
          </span>
        </div>

        <div className="settings-section-body">
          <div className="history-presets-row">
            {(
              [
                [7, '7 Days'],
                [14, '14 Days (Default)'],
                [30, '30 Days'],
                [90, '90 Days'],
                [180, '180 Days'],
                [365, '1 Year (365d)'],
                [730, '2 Years (730d)'],
              ] as Array<[number, string]>
            ).map(([days, label]) => (
              <button
                key={days}
                className={`pill-btn ${
                  !settings.historyMaxMode && settings.historyDays === days
                    ? 'active'
                    : ''
                }`}
                onClick={() =>
                  onUpdateSettings({
                    historyDays: days,
                    historyMaxMode: false,
                  })
                }
              >
                {label}
              </button>
            ))}

            <button
              className={`pill-btn max-mode-btn ${
                settings.historyMaxMode ? 'active' : ''
              }`}
              onClick={() =>
                onUpdateSettings({
                  historyMaxMode: true,
                  historyDays: maxStationDays,
                })
              }
            >
              ★ Maximum Netatmo History (Since Station Setup)
            </button>
          </div>

          <div className="settings-grid-2">
            <div className="setting-field">
              <label>Custom History Window (Days)</label>
              <div className="inline-input-row">
                <input
                  type="range"
                  min={1}
                  max={Math.max(1095, maxStationDays)}
                  value={
                    settings.historyMaxMode ? maxStationDays : customDaysInput
                  }
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setCustomDaysInput(val);
                  }}
                  onMouseUp={() =>
                    onUpdateSettings({
                      historyDays: customDaysInput,
                      historyMaxMode: false,
                    })
                  }
                />
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={customDaysInput}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(3650, Number(e.target.value) || 14));
                    setCustomDaysInput(v);
                  }}
                  onBlur={() =>
                    onUpdateSettings({
                      historyDays: customDaysInput,
                      historyMaxMode: false,
                    })
                  }
                  className="num-input"
                />
                <span>days</span>
              </div>
              <small className="field-hint">
                Netatmo caps each <code>/api/getmeasure</code> call at 1,024 data
                points. winAtmo automatically chunks & paginates requests and
                only fetches uncached time ranges.
              </small>
            </div>

            <div className="setting-field">
              <label>Default Historical Resolution (`scale`) & Auto-Refresh</label>
              <div className="inline-selects-row">
                <select
                  value={settings.defaultScale}
                  onChange={(e) =>
                    onUpdateSettings({
                      defaultScale: e.target.value as NetatmoScale,
                    })
                  }
                  className="select-input"
                >
                  <option value="max">Max Resolution (~5 min steps)</option>
                  <option value="30min">30 Minutes (Recommended Fast)</option>
                  <option value="1hour">1 Hour</option>
                  <option value="3hours">3 Hours</option>
                  <option value="1day">1 Day</option>
                </select>

                <select
                  value={settings.refreshIntervalMinutes}
                  onChange={(e) =>
                    onUpdateSettings({
                      refreshIntervalMinutes: Number(e.target.value),
                    })
                  }
                  className="select-input"
                >
                  <option value={2}>Refresh every 2 min</option>
                  <option value={5}>Refresh every 5 min (Default)</option>
                  <option value={10}>Refresh every 10 min</option>
                  <option value={15}>Refresh every 15 min</option>
                  <option value={30}>Refresh every 30 min</option>
                </select>
              </div>
              <small className="field-hint">
                Netatmo Weather Stations upload measurements to the Netatmo Cloud
                approximately every 10 minutes.
              </small>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Fast & Lightweight Local SQLite Storage */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <HardDrive size={18} className="accent-icon" />
            <div>
              <h3>Local SQLite Time-Series Database</h3>
              <p>
                Powered by native <code>node:sqlite</code> with{' '}
                <code>WITHOUT ROWID</code> clustered B-tree indexing and WAL mode
                for sub-millisecond chart queries.
              </p>
            </div>
          </div>
          <div className="storage-actions-row">
            <button
              className="action-btn subtle"
              onClick={() => onSyncNow(false)}
              disabled={syncProgress.active}
            >
              <RefreshCw
                size={14}
                className={syncProgress.active ? 'spin' : ''}
              />
              Sync Delta Now
            </button>
            <button
              className="action-btn subtle"
              onClick={async () => {
                const st = await window.winatmo.optimizeStorage();
                setStorageStats(st);
              }}
            >
              Optimize / Vacuum
            </button>
            <button
              className="action-btn danger"
              onClick={async () => {
                const st = await window.winatmo.clearHistory();
                setStorageStats(st);
              }}
            >
              <Trash2 size={14} /> Clear Cache
            </button>
          </div>
        </div>

        {storageStats && (
          <div className="storage-metrics-bar">
            <div className="storage-metric-box">
              <span>Database Size</span>
              <strong>{formatBytes(storageStats.fileSizeBytes)}</strong>
            </div>
            <div className="storage-metric-box">
              <span>Stored Data Points</span>
              <strong>{storageStats.totalPoints.toLocaleString()}</strong>
            </div>
            <div className="storage-metric-box">
              <span>Indexed Sensors</span>
              <strong>{storageStats.moduleCount}</strong>
            </div>
            <div className="storage-metric-box">
              <span>Earliest Point</span>
              <strong>
                {storageStats.oldestTimestamp
                  ? new Date(
                      storageStats.oldestTimestamp * 1000
                    ).toLocaleDateString()
                  : '--'}
              </strong>
            </div>
            <div className="storage-metric-box">
              <span>Latest Point</span>
              <strong>
                {storageStats.newestTimestamp
                  ? new Date(
                      storageStats.newestTimestamp * 1000
                    ).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '--'}
              </strong>
            </div>
          </div>
        )}
      </div>

      {/* 3. Windows Taskbar Widget Settings */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <LayoutGrid size={18} className="accent-icon" />
            <div>
              <h3>Windows Taskbar Widget & System Tray</h3>
              <p>
                Floating always-on-top mini taskbar bar showing real-time values
                for your selected sensors right above the Windows taskbar.
              </p>
            </div>
          </div>
          <div className="storage-actions-row">
            <button
              className={`action-btn ${settings.widgetEnabled ? 'primary' : 'subtle'}`}
              onClick={() =>
                onUpdateSettings({ widgetEnabled: !settings.widgetEnabled })
              }
            >
              {settings.widgetEnabled
                ? 'Taskbar Widget Enabled'
                : 'Enable Taskbar Widget'}
            </button>
            <button
              className="action-btn subtle"
              onClick={() => window.winatmo.resetWidgetPosition()}
            >
              <RotateCcw size={14} /> Dock to Taskbar Corner
            </button>
          </div>
        </div>

        <div className="settings-grid-3">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.widgetAlwaysOnTop}
              onChange={(e) =>
                onUpdateSettings({ widgetAlwaysOnTop: e.target.checked })
              }
            />
            <span>Keep Taskbar Widget Always on Top</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.widgetLocked}
              onChange={(e) =>
                onUpdateSettings({ widgetLocked: e.target.checked })
              }
            />
            <span>
              {settings.widgetLocked ? <Lock size={13} /> : <Unlock size={13} />}{' '}
              Lock Widget Position
            </span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.minimizeToTray}
              onChange={(e) =>
                onUpdateSettings({ minimizeToTray: e.target.checked })
              }
            />
            <span>Keep Running in System Tray on Window Close</span>
          </label>
        </div>

        <div className="setting-field" style={{ marginTop: 14 }}>
          <label>
            Widget Opacity ({Math.round((settings.widgetOpacity ?? 0.94) * 100)}
            %{(settings.widgetOpacity ?? 0.94) >= 0.99 ? ' — Fully Opaque' : ''})
          </label>
          <div className="inline-input-row">
            <input
              type="range"
              min={25}
              max={100}
              step={1}
              value={Math.round((settings.widgetOpacity ?? 0.94) * 100)}
              onChange={(e) =>
                onUpdateSettings({
                  widgetOpacity: Number(e.target.value) / 100,
                })
              }
            />
            <button
              type="button"
              className={`pill-btn ${
                Math.round((settings.widgetOpacity ?? 0.94) * 100) === 80
                  ? 'active'
                  : ''
              }`}
              onClick={() => onUpdateSettings({ widgetOpacity: 0.8 })}
            >
              80%
            </button>
            <button
              type="button"
              className={`pill-btn ${
                Math.round((settings.widgetOpacity ?? 0.94) * 100) === 94
                  ? 'active'
                  : ''
              }`}
              onClick={() => onUpdateSettings({ widgetOpacity: 0.94 })}
            >
              94%
            </button>
            <button
              type="button"
              className={`pill-btn ${
                (settings.widgetOpacity ?? 0.94) >= 0.99 ? 'active' : ''
              }`}
              onClick={() => onUpdateSettings({ widgetOpacity: 1.0 })}
            >
              100% Opaque
            </button>
          </div>
          <small className="field-hint">
            Adjust transparency or slide to 100% for a completely solid opaque
            widget. You can also resize the widget directly from its edges or
            bottom-right corner.
          </small>
        </div>

        <div className="pinned-sensors-list-section">
          <h4>
            <Pin size={14} /> Pinned Sensors in Taskbar Widget (
            {settings.pinnedSensors.length})
          </h4>
          {settings.pinnedSensors.length === 0 ? (
            <p className="muted-text">
              No sensors pinned yet. Click the pin icon on any sensor card in the
              Dashboard tab to display it on the Windows Taskbar Widget.
            </p>
          ) : (
            <div className="pinned-chips-wrap">
              {settings.pinnedSensors.map((pin) => (
                <div key={pin.id} className="pinned-sensor-chip">
                  <span
                    className="chip-dot"
                    style={{ backgroundColor: pin.color || '#38bdf8' }}
                  />
                  <span>
                    <strong>{pin.moduleName}</strong> •{' '}
                    {METRIC_METADATA[pin.metric]?.label || pin.metric}
                  </span>
                  <button
                    className="legend-remove"
                    onClick={() =>
                      onUpdateSettings({
                        pinnedSensors: settings.pinnedSensors.filter(
                          (p) => p.id !== pin.id
                        ),
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 4. Appearance, Themes & Units */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Palette size={18} className="accent-icon" />
            <div>
              <h3>Appearance & Color Themes</h3>
              <p>
                Choose from 12 popular dark and light color themes for winAtmo
                Studio and the floating Windows Taskbar Widget.
              </p>
            </div>
          </div>
          <span className="active-window-badge">
            {getThemeDefinition(settings.theme).name}
          </span>
        </div>

        <div className="theme-category-label">
          <Moon size={13} /> Popular Dark Themes
        </div>
        <div className="theme-cards-grid">
          {THEMES.filter((t) => t.mode === 'dark').map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`theme-swatch-card ${
                settings.theme === theme.id ? 'active' : ''
              }`}
              onClick={() => onUpdateSettings({ theme: theme.id })}
            >
              <div className="theme-swatch-info">
                <span className="theme-swatch-title">{theme.name}</span>
                <span className="theme-swatch-sub">{theme.subtitle}</span>
              </div>
              <div className="theme-swatch-dots">
                {theme.swatches.map((hex, i) => (
                  <span
                    key={i}
                    className="theme-swatch-dot"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="theme-category-label">
          <Sun size={13} /> Popular Light Themes
        </div>
        <div className="theme-cards-grid">
          {THEMES.filter((t) => t.mode === 'light').map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`theme-swatch-card ${
                settings.theme === theme.id ? 'active' : ''
              }`}
              onClick={() => onUpdateSettings({ theme: theme.id })}
            >
              <div className="theme-swatch-info">
                <span className="theme-swatch-title">{theme.name}</span>
                <span className="theme-swatch-sub">{theme.subtitle}</span>
              </div>
              <div className="theme-swatch-dots">
                {theme.swatches.map((hex, i) => (
                  <span
                    key={i}
                    className="theme-swatch-dot"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 5. Units & Display Preferences */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Sliders size={18} className="accent-icon" />
            <div>
              <h3>Units & Display Preferences</h3>
              <p>Customize measurement units across charts, dashboard, and taskbar widget.</p>
            </div>
          </div>
        </div>

        <div className="settings-grid-4">
          <div className="setting-field">
            <label>Temperature Unit</label>
            <select
              value={settings.temperatureUnit}
              onChange={(e) =>
                onUpdateSettings({
                  temperatureUnit: e.target.value as 'C' | 'F',
                })
              }
              className="select-input"
            >
              <option value="C">Celsius (°C)</option>
              <option value="F">Fahrenheit (°F)</option>
            </select>
          </div>

          <div className="setting-field">
            <label>Pressure Unit</label>
            <select
              value={settings.pressureUnit}
              onChange={(e) =>
                onUpdateSettings({
                  pressureUnit: e.target.value as any,
                })
              }
              className="select-input"
            >
              <option value="mbar">mbar</option>
              <option value="hPa">hPa</option>
              <option value="mmHg">mmHg</option>
              <option value="inHg">inHg</option>
            </select>
          </div>

          <div className="setting-field">
            <label>Wind Speed Unit</label>
            <select
              value={settings.windUnit}
              onChange={(e) =>
                onUpdateSettings({
                  windUnit: e.target.value as any,
                })
              }
              className="select-input"
            >
              <option value="kph">km/h</option>
              <option value="ms">m/s</option>
              <option value="mph">mph</option>
              <option value="kn">Knots (kn)</option>
            </select>
          </div>

          <div className="setting-field">
            <label>Rain Unit</label>
            <select
              value={settings.rainUnit}
              onChange={(e) =>
                onUpdateSettings({
                  rainUnit: e.target.value as 'mm' | 'in',
                })
              }
              className="select-input"
            >
              <option value="mm">Millimeters (mm)</option>
              <option value="in">Inches (in)</option>
            </select>
          </div>
        </div>
      </div>

      {/* 5. Netatmo Authentication & Developer OAuth2 */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <ShieldCheck size={18} className="accent-icon" />
            <div>
              <h3>Netatmo Account & API Authentication</h3>
              <p>
                Connect via direct Netatmo Web Login, official Netatmo Connect
                OAuth 2.0 (<code>dev.netatmo.com</code>), or a Personal Access Token.
              </p>
            </div>
          </div>
          {account.loggedIn && (
            <button className="action-btn danger" onClick={onLogout}>
              Sign Out ({account.email || account.authMethod})
            </button>
          )}
        </div>

        <div className="auth-methods-grid">
          <div className="auth-method-box">
            <h4>
              <Globe size={15} /> 1. Direct Web Login (Recommended)
            </h4>
            <p>
              Sign in directly to your Netatmo account via the embedded Netatmo
              web portal. Automatically captures & refreshes your session token.
            </p>
            <button className="action-btn primary" onClick={onStartWebLogin}>
              <Globe size={14} /> Open Netatmo Web Login
            </button>
          </div>

          <div className="auth-method-box">
            <h4>
              <KeyRound size={15} /> 2. Netatmo Connect OAuth2 App
            </h4>
            <p>
              Use your own Client ID & Secret from{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  window.winatmo.openExternal(
                    'https://dev.netatmo.com/apidocumentation/oauth'
                  );
                }}
              >
                dev.netatmo.com <ExternalLink size={11} />
              </a>
            </p>
            <div className="compact-form">
              <input
                type="text"
                placeholder="Client ID"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                className="text-input"
              />
              <input
                type="password"
                placeholder="Client Secret"
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                className="text-input"
              />
              <button
                className="action-btn subtle"
                onClick={() =>
                  onStartOAuthLogin(oauthClientId, oauthClientSecret)
                }
              >
                Authorize via OAuth2
              </button>
            </div>
          </div>

          <div className="auth-method-box">
            <h4>
              <CheckCircle2 size={15} /> 3. Direct Access Token
            </h4>
            <p>
              Paste an <code>access_token</code> generated from your Netatmo
              Developer dashboard.
            </p>
            <div className="compact-form">
              <input
                type="password"
                placeholder="Access Token (Bearer)"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                className="text-input"
              />
              <input
                type="password"
                placeholder="Refresh Token (Optional)"
                value={manualRefresh}
                onChange={(e) => setManualRefresh(e.target.value)}
                className="text-input"
              />
              <button
                className="action-btn subtle"
                onClick={() => onTokenLogin(manualToken, manualRefresh)}
              >
                Connect with Token
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
