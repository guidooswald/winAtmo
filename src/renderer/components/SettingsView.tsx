import React, { useEffect, useState, useMemo } from 'react';
import {
  CheckCircle2,
  Database,
  ExternalLink,
  Gauge,
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

  // Build discovered station sensor options for the taskbar icon selector
  const stationSensorOptions = useMemo(() => {
    const list: Array<{ value: string; label: string }> = [];
    for (const st of stations) {
      for (const mod of st.modules) {
        if (!mod.dashboard) continue;
        const d = mod.dashboard as Record<string, any>;
        if (d.Temperature !== undefined) {
          list.push({
            value: `${st.id}::${mod.id}::temperature`,
            label: `${st.stationName} — ${mod.moduleName} (Temperature)`,
          });
        }
        if (d.CO2 !== undefined) {
          list.push({
            value: `${st.id}::${mod.id}::co2`,
            label: `${st.stationName} — ${mod.moduleName} (CO₂)`,
          });
        }
        if (d.Humidity !== undefined) {
          list.push({
            value: `${st.id}::${mod.id}::humidity`,
            label: `${st.stationName} — ${mod.moduleName} (Humidity)`,
          });
        }
        if (d.Pressure !== undefined) {
          list.push({
            value: `${st.id}::${mod.id}::pressure`,
            label: `${st.stationName} — ${mod.moduleName} (Pressure)`,
          });
        }
        if (d.Rain !== undefined) {
          list.push({
            value: `${st.id}::${mod.id}::rain`,
            label: `${st.stationName} — ${mod.moduleName} (Rain)`,
          });
        }
        if (d.WindStrength !== undefined) {
          list.push({
            value: `${st.id}::${mod.id}::windstrength`,
            label: `${st.stationName} — ${mod.moduleName} (Wind)`,
          });
        }
      }
    }
    return list;
  }, [stations]);

  // Live preview for taskbar icon badge
  const previewInfo = useMemo(() => {
    const target = settings.taskbarSensorTarget || 'outdoor_temp';
    const isF = settings.temperatureUnit === 'F';

    if (target === 'outdoor_temp') {
      for (const st of stations) {
        const outdoor = st.modules.find(
          (m) =>
            (m.type === 'NAModule1' ||
              m.moduleName.toLowerCase().includes('outdoor') ||
              m.moduleName.toLowerCase().includes('aussen') ||
              m.moduleName.toLowerCase().includes('ext')) &&
            m.dashboard?.Temperature !== undefined
        );
        if (outdoor?.dashboard?.Temperature !== undefined) {
          const t = outdoor.dashboard.Temperature;
          const val = isF ? (t * 9) / 5 + 32 : t;
          const color =
            t < 0 ? '#38bdf8' : t < 15 ? '#0ea5e9' : t >= 28 ? '#ef4444' : t >= 23 ? '#f59e0b' : '#10b981';
          return {
            text: val >= 100 || val <= -100 ? `${Math.round(val)}` : val.toFixed(1),
            color,
            label: `${outdoor.moduleName}: ${val.toFixed(1)}°${settings.temperatureUnit}`,
          };
        }
      }
      return {
        text: isF ? '64.4' : '18.2',
        color: '#10b981',
        label: `Outside Temp: ${isF ? '64.4°F' : '18.2°C'}`,
      };
    }

    if (target === 'indoor_temp') {
      for (const st of stations) {
        const main = st.modules.find(
          (m) =>
            (m.type === 'NAMain' || m.type === 'NAModule4') &&
            m.dashboard?.Temperature !== undefined
        );
        if (main?.dashboard?.Temperature !== undefined) {
          const t = main.dashboard.Temperature;
          const val = isF ? (t * 9) / 5 + 32 : t;
          const color =
            t < 0 ? '#38bdf8' : t < 15 ? '#0ea5e9' : t >= 28 ? '#ef4444' : t >= 23 ? '#f59e0b' : '#10b981';
          return {
            text: val >= 100 || val <= -100 ? `${Math.round(val)}` : val.toFixed(1),
            color,
            label: `${main.moduleName}: ${val.toFixed(1)}°${settings.temperatureUnit}`,
          };
        }
      }
      return {
        text: isF ? '70.5' : '21.4',
        color: '#10b981',
        label: `Indoor Temp: ${isF ? '70.5°F' : '21.4°C'}`,
      };
    }

    if (target === 'indoor_co2') {
      for (const st of stations) {
        const mod = st.modules.find((m) => m.dashboard?.CO2 !== undefined);
        if (mod?.dashboard?.CO2 !== undefined) {
          const co2 = mod.dashboard.CO2;
          const text = co2 >= 1000 ? `${(co2 / 1000).toFixed(1)}k` : `${co2}`;
          const color =
            co2 >= 1500 ? '#ef4444' : co2 >= 1000 ? '#f59e0b' : '#10b981';
          return { text, color, label: `${mod.moduleName} CO₂: ${co2} ppm` };
        }
      }
      return { text: '650', color: '#10b981', label: 'CO₂: 650 ppm' };
    }

    if (target === 'outdoor_humidity' || target === 'indoor_humidity') {
      for (const st of stations) {
        const mod = st.modules.find((m) => m.dashboard?.Humidity !== undefined);
        if (mod?.dashboard?.Humidity !== undefined) {
          const h = Math.round(mod.dashboard.Humidity);
          const color = h < 30 ? '#f59e0b' : h > 70 ? '#3b82f6' : '#0ea5e9';
          return { text: `${h}%`, color, label: `${mod.moduleName} Humidity: ${h}%` };
        }
      }
      return { text: '55%', color: '#0ea5e9', label: 'Humidity: 55%' };
    }

    if (target === 'pressure') {
      for (const st of stations) {
        const mod = st.modules.find((m) => m.dashboard?.Pressure !== undefined);
        if (mod?.dashboard?.Pressure !== undefined) {
          const p = mod.dashboard.Pressure;
          const text =
            settings.pressureUnit === 'inHg' ? p.toFixed(1) : `${Math.round(p)}`;
          return {
            text,
            color: '#8b5cf6',
            label: `Pressure: ${p.toFixed(1)} ${settings.pressureUnit}`,
          };
        }
      }
      return {
        text: '1015',
        color: '#8b5cf6',
        label: `Pressure: 1015 ${settings.pressureUnit}`,
      };
    }

    if (target.includes('::')) {
      const [stationId, moduleId, metric] = target.split('::');
      const st = stations.find((s) => s.id === stationId);
      const mod = st?.modules.find((m) => m.id === moduleId);
      if (mod?.dashboard) {
        const d = mod.dashboard as Record<string, any>;
        const raw =
          metric === 'temperature'
            ? d.Temperature
            : metric === 'humidity'
            ? d.Humidity
            : metric === 'co2'
            ? d.CO2
            : metric === 'pressure'
            ? d.Pressure
            : d.Noise;
        if (raw !== undefined) {
          if (metric === 'temperature') {
            const val = isF ? (raw * 9) / 5 + 32 : raw;
            const rounded = Math.round(val);
            const color =
              raw < 0
                ? '#38bdf8'
                : raw < 15
                ? '#0ea5e9'
                : raw >= 28
                ? '#ef4444'
                : raw >= 23
                ? '#f59e0b'
                : '#10b981';
            return {
              text: val >= 100 || val <= -100 ? `${Math.round(val)}` : val.toFixed(1),
              color,
              label: `${mod.moduleName}: ${val.toFixed(1)}°${settings.temperatureUnit}`,
            };
          }
          return {
            text: `${Math.round(raw)}`,
            color: '#0ea5e9',
            label: `${mod.moduleName}: ${raw}`,
          };
        }
      }
    }

    return {
      text: isF ? '64°' : '18°',
      color: '#10b981',
      label: `Outside Temp: ${isF ? '64.4°F' : '18.0°C'}`,
    };
  }, [stations, settings]);

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

        {/* Taskbar & System Tray Icon Display Mode */}
        <div className="setting-field" style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Gauge size={14} className="accent-icon" /> Taskbar & System Tray Icon Display
              </label>
              <small className="field-hint" style={{ marginTop: 2, display: 'block' }}>
                Show a live sensor reading (e.g. outside temperature) directly in your Windows taskbar tray instead of the standard icon.
              </small>
            </div>
            <div className="inline-input-row" style={{ marginTop: 0 }}>
              <button
                type="button"
                className={`pill-btn ${settings.taskbarDisplayMode !== 'icon' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ taskbarDisplayMode: 'sensor' })}
              >
                Live Sensor Reading
              </button>
              <button
                type="button"
                className={`pill-btn ${settings.taskbarDisplayMode === 'icon' ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ taskbarDisplayMode: 'icon' })}
              >
                Default App Icon
              </button>
            </div>
          </div>

          {settings.taskbarDisplayMode !== 'icon' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Target Sensor Reading
                </label>
                <select
                  className="select-input"
                  style={{ width: '100%', padding: '7px 10px', borderRadius: 6 }}
                  value={settings.taskbarSensorTarget || 'outdoor_temp'}
                  onChange={(e) => onUpdateSettings({ taskbarSensorTarget: e.target.value })}
                >
                  <optgroup label="Standard Presets">
                    <option value="outdoor_temp">Outside Temperature (Default)</option>
                    <option value="indoor_temp">Indoor Temperature (Main Station)</option>
                    <option value="indoor_co2">Indoor CO₂ (Main Station)</option>
                    <option value="outdoor_humidity">Outdoor Humidity</option>
                    <option value="indoor_humidity">Indoor Humidity</option>
                    <option value="pressure">Barometric Pressure</option>
                  </optgroup>
                  {stationSensorOptions.length > 0 && (
                    <optgroup label="Connected Station Sensors">
                      {stationSensorOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {/* Live Preview Badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: 'var(--bg-subtle)', borderRadius: 8, border: '1px solid var(--border-subtle)', marginTop: 14 }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Tray Preview:
                </div>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 5,
                    background: '#090d16',
                    border: `1.5px solid ${previewInfo.color}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize:
                      previewInfo.text.length <= 3
                        ? 16.5
                        : previewInfo.text.length === 4
                        ? 14.5
                        : 11.5,
                    boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                    fontFamily:
                      '"Segoe UI Variable Display", "Segoe UI", Arial, sans-serif',
                  }}
                >
                  {previewInfo.text}
                </div>
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {previewInfo.label}
                </div>
              </div>
            </div>
          )}
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
