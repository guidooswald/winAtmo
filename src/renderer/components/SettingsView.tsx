import React, { useEffect, useState, useMemo } from 'react';
import {
  AlertTriangle,
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
  Terminal,
  Trash2,
  Unlock,
} from 'lucide-react';
import {
  AccountInfo,
  NetatmoScale,
  StorageStats,
  StoredApiKeysInfo,
  SyncProgress,
  UserSettings,
  WeatherStation,
} from '../types';
import { METRIC_METADATA } from '../utils/metrics';
import { getThemeDefinition, THEMES } from '../utils/themes';
import { useI18n, LANGUAGES } from '../utils/i18n';

interface SettingsViewProps {
  settings: UserSettings;
  account: AccountInfo;
  stations: WeatherStation[];
  syncProgress: SyncProgress;
  onUpdateSettings: (partial: Partial<UserSettings>) => Promise<void>;
  onSyncNow: (forceFull?: boolean) => Promise<void>;
  onStartWebLogin: () => Promise<void>;
  onStartOAuthLogin: (
    clientId: string,
    clientSecret: string,
    storeLocally?: boolean
  ) => Promise<void>;
  onTokenLogin: (
    token: string,
    refresh?: string,
    clientId?: string,
    clientSecret?: string,
    storeLocally?: boolean
  ) => Promise<void>;
  onLogout: (eraseDatabase?: boolean) => Promise<void>;
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
  const { t, formatNumber, formatDate, formatTime } = useI18n();
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [loadingStats, setLoadingStats] = useState<boolean>(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState<boolean>(false);
  const [eraseDbOnLogout, setEraseDbOnLogout] = useState<boolean>(false);
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
  const [storedKeysInfo, setStoredKeysInfo] =
    useState<StoredApiKeysInfo | null>(null);
  const [savingKeys, setSavingKeys] = useState<boolean>(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [refreshingToken, setRefreshingToken] = useState<boolean>(false);
  const [refreshFeedback, setRefreshFeedback] = useState<string | null>(null);
  const [debugRestartNeeded, setDebugRestartNeeded] = useState<boolean>(false);

  const handleOpenDebugWindow = () => {
    if (typeof window.winatmo?.openDebugWindow === 'function') {
      setDebugRestartNeeded(false);
      window.winatmo.openDebugWindow();
    } else {
      setDebugRestartNeeded(true);
    }
  };

  const loadKeysInfo = async () => {
    try {
      const info = await window.winatmo.getStoredApiKeysInfo();
      setStoredKeysInfo(info);
      if (info.clientId && !oauthClientId) {
        setOauthClientId(settings.oauthClientId || '');
      }
    } catch {}
  };

  const handleSaveApiKeys = async () => {
    if (!oauthClientId.trim() || !oauthClientSecret.trim()) {
      setSaveFeedback('Please enter both Client ID and Client Secret.');
      return;
    }
    setSavingKeys(true);
    setSaveFeedback(null);
    try {
      const res = await window.winatmo.saveApiKeys({
        clientId: oauthClientId.trim(),
        clientSecret: oauthClientSecret.trim(),
        accessToken: manualToken.trim() || undefined,
        refreshToken: manualRefresh.trim() || undefined,
        autoUpdate: settings.autoUpdateTokens !== false,
      });
      if (res.success) {
        setSaveFeedback('API keys saved locally in encrypted file (DPAPI).');
        await loadKeysInfo();
        setTimeout(() => setSaveFeedback(null), 4000);
      } else {
        setSaveFeedback(res.error || 'Failed to save API keys.');
      }
    } catch (err: any) {
      setSaveFeedback(err?.message || 'Error saving keys');
    } finally {
      setSavingKeys(false);
    }
  };

  const handleClearStoredKeys = async () => {
    try {
      await window.winatmo.clearStoredApiKeys();
      setOauthClientId('');
      setOauthClientSecret('');
      setSaveFeedback('Stored API keys cleared from encrypted file.');
      await loadKeysInfo();
      setTimeout(() => setSaveFeedback(null), 4000);
    } catch (err: any) {
      setSaveFeedback(err?.message || 'Failed to clear keys');
    }
  };

  const handleTestTokenRefresh = async () => {
    setRefreshingToken(true);
    setRefreshFeedback(null);
    try {
      const res = await window.winatmo.refreshTokenNow();
      if (res.refreshed) {
        setRefreshFeedback(
          `Token auto-updated successfully! Valid until ${
            res.expiresAt
              ? new Date(res.expiresAt * 1000).toLocaleTimeString()
              : 'next period'
          }.`
        );
        await loadKeysInfo();
      } else {
        setRefreshFeedback(
          res.error || 'Token is already fresh or refresh was not needed.'
        );
      }
      setTimeout(() => setRefreshFeedback(null), 5000);
    } catch (err: any) {
      setRefreshFeedback(err?.message || 'Token refresh failed');
    } finally {
      setRefreshingToken(false);
    }
  };

  useEffect(() => {
    loadKeysInfo();
  }, [account.loggedIn, account.tokenExpiresAt, settings.storeApiKeysLocally]);

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const st = await window.winatmo.getStorageStats();
      setStorageStats(st);
    } catch (err) {
      console.warn('[SettingsView] Failed to load storage stats:', err);
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, [syncProgress.pointsStored, syncProgress.phase]);

  useEffect(() => {
    setCustomDaysInput(settings.historyDays);
  }, [settings.historyDays]);

  const themeFamilies = useMemo(() => {
    const familyMap = new Map<
      string,
      {
        id: string;
        title: string;
        styleLabel: string;
        dark?: (typeof THEMES)[0];
        light?: (typeof THEMES)[0];
      }
    >();

    for (const t of THEMES) {
      if (!familyMap.has(t.family)) {
        familyMap.set(t.family, {
          id: t.family,
          title: t.familyTitle,
          styleLabel: t.styleLabel,
        });
      }
      const entry = familyMap.get(t.family)!;
      if (t.mode === 'dark') {
        entry.dark = t;
      } else {
        entry.light = t;
      }
    }

    return Array.from(familyMap.values());
  }, []);

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
            t < 0
              ? '#7dd3fc'
              : t < 15
              ? '#38bdf8'
              : t >= 28
              ? '#f87171'
              : t >= 23
              ? '#fbbf24'
              : '#34d399';
          return {
            text: val >= 100 || val <= -100 ? `${Math.round(val)}` : val.toFixed(1),
            color,
            label: `${outdoor.moduleName}: ${val.toFixed(1)}°${settings.temperatureUnit}`,
          };
        }
      }
      return {
        text: isF ? '64.4' : '18.2',
        color: '#34d399',
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
            t < 0
              ? '#7dd3fc'
              : t < 15
              ? '#38bdf8'
              : t >= 28
              ? '#f87171'
              : t >= 23
              ? '#fbbf24'
              : '#34d399';
          return {
            text: val >= 100 || val <= -100 ? `${Math.round(val)}` : val.toFixed(1),
            color,
            label: `${main.moduleName}: ${val.toFixed(1)}°${settings.temperatureUnit}`,
          };
        }
      }
      return {
        text: isF ? '70.5' : '21.4',
        color: '#34d399',
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
            co2 >= 1500 ? '#f87171' : co2 >= 1000 ? '#fbbf24' : '#34d399';
          return { text, color, label: `${mod.moduleName} CO₂: ${co2} ppm` };
        }
      }
      return { text: '650', color: '#34d399', label: 'CO₂: 650 ppm' };
    }

    if (target === 'outdoor_humidity' || target === 'indoor_humidity') {
      for (const st of stations) {
        const mod = st.modules.find((m) => m.dashboard?.Humidity !== undefined);
        if (mod?.dashboard?.Humidity !== undefined) {
          const h = Math.round(mod.dashboard.Humidity);
          const color = h < 30 ? '#fbbf24' : h > 65 ? '#60a5fa' : '#38bdf8';
          return { text: `${h}%`, color, label: `${mod.moduleName} Humidity: ${h}%` };
        }
      }
      return { text: '55%', color: '#38bdf8', label: 'Humidity: 55%' };
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
            color: '#a78bfa',
            label: `Pressure: ${p.toFixed(1)} ${settings.pressureUnit}`,
          };
        }
      }
      return {
        text: '1015',
        color: '#a78bfa',
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
            : metric === 'noise'
            ? d.Noise
            : metric === 'rain'
            ? d.Rain
            : metric === 'windstrength'
            ? d.WindStrength
            : undefined;
        if (raw !== undefined) {
          if (metric === 'temperature') {
            const val = isF ? (raw * 9) / 5 + 32 : raw;
            const color =
              raw < 0
                ? '#7dd3fc'
                : raw < 15
                ? '#38bdf8'
                : raw >= 28
                ? '#f87171'
                : raw >= 23
                ? '#fbbf24'
                : '#34d399';
            return {
              text: val >= 100 || val <= -100 ? `${Math.round(val)}` : val.toFixed(1),
              color,
              label: `${mod.moduleName}: ${val.toFixed(1)}°${settings.temperatureUnit}`,
            };
          }
          if (metric === 'humidity') {
            const h = Math.round(raw);
            const color = h < 30 ? '#fbbf24' : h > 65 ? '#60a5fa' : '#38bdf8';
            return { text: `${h}%`, color, label: `${mod.moduleName} Humidity: ${h}%` };
          }
          if (metric === 'co2') {
            const text = raw >= 1000 ? `${(raw / 1000).toFixed(1)}k` : `${raw}`;
            const color =
              raw >= 1500 ? '#f87171' : raw >= 1000 ? '#fbbf24' : '#34d399';
            return { text, color, label: `${mod.moduleName} CO₂: ${raw} ppm` };
          }
          if (metric === 'pressure') {
            const text =
              settings.pressureUnit === 'inHg' ? raw.toFixed(1) : `${Math.round(raw)}`;
            return {
              text,
              color: '#a78bfa',
              label: `${mod.moduleName} Pressure: ${raw.toFixed(1)} ${settings.pressureUnit}`,
            };
          }
          if (metric === 'noise') {
            const color = raw >= 65 ? '#f87171' : raw >= 50 ? '#fbbf24' : '#34d399';
            return {
              text: `${Math.round(raw)}`,
              color,
              label: `${mod.moduleName} Noise: ${Math.round(raw)} dB`,
            };
          }
          if (metric === 'rain') {
            const color = raw > 0 ? '#38bdf8' : '#cbd5e1';
            return {
              text: `${raw.toFixed(1)}`,
              color,
              label: `${mod.moduleName} Rain: ${raw.toFixed(1)} mm`,
            };
          }
          if (metric === 'windstrength') {
            const color = raw >= 35 ? '#f87171' : raw >= 15 ? '#38bdf8' : '#2dd4bf';
            return {
              text: `${Math.round(raw)}`,
              color,
              label: `${mod.moduleName} Wind: ${Math.round(raw)}`,
            };
          }
          return {
            text: `${Math.round(raw)}`,
            color: '#38bdf8',
            label: `${mod.moduleName}: ${raw}`,
          };
        }
      }
    }

    return {
      text: isF ? '64°' : '18°',
      color: '#34d399',
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
      {/* 0. Language & Localization */}
      <div className="settings-card highlight-border">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Globe size={18} className="accent-icon" />
            <div>
              <h3>{t('section_language_title')}</h3>
              <p>{t('section_language_desc')}</p>
            </div>
          </div>
          <span className="active-window-badge">
            {LANGUAGES.find((l) => l.id === (settings.language || 'en'))?.flag}{' '}
            {LANGUAGES.find((l) => l.id === (settings.language || 'en'))?.nativeName}
          </span>
        </div>

        <div className="language-selector-grid">
          {LANGUAGES.map((lang) => {
            const isSelected = (settings.language || 'en') === lang.id;
            return (
              <button
                key={lang.id}
                type="button"
                className={`language-card-btn ${isSelected ? 'active' : ''}`}
                onClick={() => onUpdateSettings({ language: lang.id })}
                title={`${lang.nativeName} (${lang.name})`}
              >
                <span className="language-flag">{lang.flag}</span>
                <div className="language-label-wrap">
                  <span className="language-native-name">{lang.nativeName}</span>
                  <span className="language-english-name">{lang.name}</span>
                </div>
                {isSelected && (
                  <CheckCircle2 size={16} className="language-check-icon" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. Historical Data Window & Cloud Sync */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Database size={18} className="accent-icon" />
            <div>
              <h3>{t('section_history_title')}</h3>
              <p>{t('section_history_desc')}</p>
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
                  <option value={5}>Refresh every 5 min</option>
                  <option value={10}>Refresh every 10 min (Default)</option>
                  <option value={15}>Refresh every 15 min</option>
                  <option value={30}>Refresh every 30 min</option>
                </select>
              </div>
              <small className="field-hint">
                Netatmo Weather Stations upload measurements approximately every
                10 minutes. This cycle also refreshes Security camera status &amp;
                unseen events.
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
              <h3>{t('section_database_title')}</h3>
              <p>{t('section_database_desc')}</p>
            </div>
          </div>
          <div className="storage-actions-row">
            <button
              className="action-btn subtle"
              onClick={handleOpenDebugWindow}
              title="Open API & Sync Debug Console (raw API output, transfer rates, logs)"
            >
              <Terminal size={14} />
              Debug Console
            </button>
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
            <button
              className="action-btn danger"
              onClick={async () => {
                if (typeof window.winatmo?.clearSecurityData === 'function') {
                  const st = await window.winatmo.clearSecurityData();
                  setStorageStats(st);
                }
              }}
              title="Delete all stored camera status, known persons, and security events from SQLite"
            >
              <Trash2 size={14} /> Delete Security Data
            </button>
          </div>
        </div>

        {loadingStats ? (
          <div className="storage-metrics-bar loading">
            <div className="storage-metric-loading">
              <RefreshCw size={15} className="spin" />
              <span>Querying local SQLite database statistics...</span>
            </div>
          </div>
        ) : storageStats && (
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
              <span>Security Events</span>
              <strong>
                {(storageStats.securityEventsCount ?? 0).toLocaleString()}
                {(storageStats.securityCamerasCount ?? 0) > 0
                  ? ` (${storageStats.securityCamerasCount} cam)`
                  : ''}
              </strong>
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

        <div className="settings-switch-row">
          <div className="settings-switch-text">
            <strong>Store Security Data in SQLite</strong>
            <span>
              Save cameras, known persons, and events locally so refreshes only
              fetch new, unseen events. Turn off to avoid storing any security
              data locally.
            </span>
          </div>
          <label
            className="toggle-switch"
            title="Toggle saving Netatmo Security data in local SQLite database"
          >
            <input
              type="checkbox"
              checked={settings.storeSecurityData !== false}
              onChange={(e) =>
                onUpdateSettings({ storeSecurityData: e.target.checked })
              }
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {/* 3. Windows Taskbar Widget Settings */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <LayoutGrid size={18} className="accent-icon" />
            <div>
              <h3>{t('section_widget_title')}</h3>
              <p>{t('section_widget_desc')}</p>
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

        <div className="settings-grid-2">
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

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(settings.launchOnStartup)}
              onChange={(e) =>
                onUpdateSettings({ launchOnStartup: e.target.checked })
              }
            />
            <span>Start winAtmo automatically on Windows login</span>
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

              {/* Live Preview on Taskbar simulated swatches */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 14px',
                  background: 'var(--bg-subtle)',
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                  marginTop: 14,
                  flexWrap: 'wrap',
                }}
              >
                <div
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Tray Preview:
                </div>
                {/* Dark Taskbar Swatch */}
                <div
                  title="Preview on Dark Taskbar (no black box background)"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 5,
                    background: '#1f2430',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: previewInfo.color,
                    fontWeight: 700,
                    fontSize:
                      previewInfo.text.length <= 3
                        ? 16.5
                        : previewInfo.text.length === 4
                        ? 14
                        : 11.5,
                    textShadow:
                      '0 1px 3px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.9)',
                    fontFamily:
                      '"Segoe UI Variable Display", "Segoe UI", Arial, sans-serif',
                    userSelect: 'none',
                  }}
                >
                  {previewInfo.text}
                </div>
                {/* Light Taskbar Swatch */}
                <div
                  title="Preview on Light Taskbar (no black box background)"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 5,
                    background: '#f8fafc',
                    border: '1px solid rgba(0, 0, 0, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: previewInfo.color,
                    fontWeight: 700,
                    fontSize:
                      previewInfo.text.length <= 3
                        ? 16.5
                        : previewInfo.text.length === 4
                        ? 14
                        : 11.5,
                    textShadow:
                      '0 1px 3px rgba(0, 0, 0, 0.95), 0 0 2px rgba(0, 0, 0, 0.9), 0 0 1px rgba(0, 0, 0, 0.95)',
                    fontFamily:
                      '"Segoe UI Variable Display", "Segoe UI", Arial, sans-serif',
                    userSelect: 'none',
                  }}
                >
                  {previewInfo.text}
                </div>
                <div
                  style={{
                    fontSize: '12.5px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}
                >
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

      {/* 4. Appearance, Themes & Styles */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Palette size={18} className="accent-icon" />
            <div>
              <h3>{t('section_appearance_title')}</h3>
              <p>{t('section_appearance_desc')}</p>
            </div>
          </div>
          <span className="active-window-badge">
            {getThemeDefinition(settings.theme).name} ({getThemeDefinition(settings.theme).styleLabel.split('•')[0].trim()})
          </span>
        </div>

        <div className="theme-families-container">
          {themeFamilies.map((fam) => (
            <div key={fam.id} className="theme-family-card">
              <div className="theme-family-header">
                <div className="theme-family-title-wrap">
                  <h4 className="theme-family-title">{fam.title}</h4>
                  <span className="theme-family-badge">{fam.styleLabel}</span>
                </div>
              </div>
              <div className="theme-family-pair-grid">
                {fam.dark && (
                  <button
                    key={fam.dark.id}
                    type="button"
                    className={`theme-swatch-card ${
                      settings.theme === fam.dark.id ? 'active' : ''
                    }`}
                    onClick={() => onUpdateSettings({ theme: fam.dark!.id })}
                  >
                    <div className="theme-swatch-info">
                      <div className="theme-mode-label">
                        <Moon size={12} />
                        <span className="theme-swatch-title">{fam.dark.name}</span>
                      </div>
                      <span className="theme-swatch-sub">{fam.dark.subtitle}</span>
                    </div>
                    <div className="theme-swatch-dots">
                      {fam.dark.swatches.map((hex, i) => (
                        <span
                          key={i}
                          className="theme-swatch-dot"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </div>
                  </button>
                )}
                {fam.light && (
                  <button
                    key={fam.light.id}
                    type="button"
                    className={`theme-swatch-card ${
                      settings.theme === fam.light.id ? 'active' : ''
                    }`}
                    onClick={() => onUpdateSettings({ theme: fam.light!.id })}
                  >
                    <div className="theme-swatch-info">
                      <div className="theme-mode-label">
                        <Sun size={12} />
                        <span className="theme-swatch-title">{fam.light.name}</span>
                      </div>
                      <span className="theme-swatch-sub">{fam.light.subtitle}</span>
                    </div>
                    <div className="theme-swatch-dots">
                      {fam.light.swatches.map((hex, i) => (
                        <span
                          key={i}
                          className="theme-swatch-dot"
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </div>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 5. Units & Display Preferences */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Sliders size={18} className="accent-icon" />
            <div>
              <h3>{t('section_units_title')}</h3>
              <p>{t('section_units_desc')}</p>
            </div>
          </div>
        </div>

        <div className="settings-grid-4">
          <div className="setting-field">
            <label>{t('unit_temperature')}</label>
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
            <label>{t('unit_pressure')}</label>
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
            <label>{t('unit_wind')}</label>
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
            <label>{t('unit_rain')}</label>
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

      {/* 6. Netatmo Authentication & Developer OAuth2 */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <ShieldCheck size={18} className="accent-icon" />
            <div>
              <h3>{t('section_auth_title')}</h3>
              <p>{t('section_auth_desc')}</p>
            </div>
          </div>
          {account.loggedIn && (
            account.authMethod === 'demo' ? (
              <button
                className="action-btn warning"
                onClick={() => onLogout(false)}
              >
                {t('exit_demo')}
              </button>
            ) : (
              <button
                className="action-btn danger"
                onClick={() => setShowLogoutConfirm(true)}
              >
                {t('sign_out')} ({account.email || account.authMethod})
              </button>
            )
          )}
        </div>

        <div className="auth-methods-grid">
          {/* Stored API Keys & Auto-Update Configuration */}
          <div className="auth-method-box" style={{ gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h4>
                <ShieldCheck size={16} /> Local Encrypted API Keys &amp; Auto-Update
              </h4>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                {storedKeysInfo?.hasStoredKeys ? (
                  <span className="badge success" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Lock size={11} /> Locally Encrypted (DPAPI)
                  </span>
                ) : (
                  <span className="badge subtle">No Stored File</span>
                )}
                {settings.autoUpdateTokens !== false && (
                  <span className="badge info" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <RefreshCw size={10} /> Auto-Update On
                  </span>
                )}
              </div>
            </div>

            <p>
              Save your Netatmo Developer credentials (<code>client_id</code> &amp; <code>client_secret</code> from{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  window.winatmo.openExternal('https://dev.netatmo.com/apps/');
                }}
              >
                dev.netatmo.com/apps <ExternalLink size={11} />
              </a>
              ) in a local encrypted file on your PC. Secrets are encrypted using Windows DPAPI (crypt32) and are never sent to GitHub or cloud servers.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Boolean(settings.storeApiKeysLocally || storedKeysInfo?.hasStoredKeys)}
                  onChange={(e) => onUpdateSettings({ storeApiKeysLocally: e.target.checked })}
                />
                <span><strong>Store API keys locally in an encrypted file</strong> (AES/DPAPI hardware-backed)</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.autoUpdateTokens !== false}
                  onChange={(e) => onUpdateSettings({ autoUpdateTokens: e.target.checked })}
                />
                <span><strong>Auto-update tokens</strong> (proactively refreshes your 3-hour access token before expiration)</span>
              </label>
            </div>

            <div className="compact-form" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <input
                type="text"
                placeholder="Client ID (from dev.netatmo.com)"
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
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button
                className="action-btn primary"
                onClick={handleSaveApiKeys}
                disabled={savingKeys || !oauthClientId.trim() || !oauthClientSecret.trim()}
              >
                <Lock size={13} /> {savingKeys ? 'Encrypting & Saving...' : 'Save Encrypted API Keys'}
              </button>

              {storedKeysInfo?.hasStoredKeys && (
                <button
                  className="action-btn subtle"
                  onClick={handleClearStoredKeys}
                >
                  <Trash2 size={13} /> Clear Stored Keys
                </button>
              )}

              {account.loggedIn && (
                <button
                  className="action-btn subtle"
                  onClick={handleTestTokenRefresh}
                  disabled={refreshingToken}
                >
                  <RefreshCw size={13} className={refreshingToken ? 'spin' : ''} />
                  <span>{refreshingToken ? 'Refreshing...' : 'Refresh Token Now'}</span>
                </button>
              )}
            </div>

            {account.tokenExpiresAt ? (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-subtle)' }}>
                Active token expires around {new Date(account.tokenExpiresAt * 1000).toLocaleTimeString()} (auto-refreshed in background).
              </div>
            ) : null}

            {saveFeedback && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={13} /> {saveFeedback}
              </div>
            )}
            {refreshFeedback && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={13} /> {refreshFeedback}
              </div>
            )}
          </div>

          <div className="auth-method-box">
            <h4>
              <Globe size={15} /> 1. Direct Web Login (Recommended)
            </h4>
            <p>
              Sign in directly to your Netatmo account via the embedded Netatmo
              web portal. Automatically captures &amp; refreshes your session token.
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
              Authorize winAtmo using your Client ID &amp; Secret from{' '}
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
              <button
                className="action-btn subtle"
                onClick={() =>
                  onStartOAuthLogin(
                    oauthClientId,
                    oauthClientSecret,
                    settings.storeApiKeysLocally
                  )
                }
                disabled={!oauthClientId.trim() || !oauthClientSecret.trim()}
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
                placeholder="Refresh Token (Optional, for auto-refresh)"
                value={manualRefresh}
                onChange={(e) => setManualRefresh(e.target.value)}
                className="text-input"
              />
              <button
                className="action-btn subtle"
                onClick={() =>
                  onTokenLogin(
                    manualToken,
                    manualRefresh,
                    oauthClientId || undefined,
                    oauthClientSecret || undefined,
                    settings.storeApiKeysLocally
                  )
                }
                disabled={!manualToken.trim()}
              >
                Connect with Token
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 7. API & Sync Debug Console */}
      <div className="settings-card">
        <div className="settings-card-header">
          <div className="settings-title-group">
            <Terminal size={18} className="accent-icon" />
            <div>
              <h3>API &amp; Sync Debug Console</h3>
              <p>
                Inspect live Netatmo HTTP requests, raw JSON API responses, payload transfer rates (KB/s), request latency, rate limits (429), and internal log messages in real time.
              </p>
            </div>
          </div>
          <div className="storage-actions-row">
            <button
              type="button"
              className="action-btn primary"
              onClick={handleOpenDebugWindow}
            >
              <Terminal size={14} />
              Open Debug Window
            </button>
          </div>
        </div>
        {debugRestartNeeded && (
          <div className="modal-danger-alert" style={{ marginTop: 12 }}>
            <AlertTriangle size={15} />
            <span>
              winAtmo&apos;s background Electron main/preload process is running an older build. Please close winAtmo and restart it (e.g. <code>npm run dev</code>) to enable the Debug Console window.
            </span>
          </div>
        )}
      </div>

      {showLogoutConfirm && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-header">
              <AlertTriangle size={20} className="warning-icon" />
              <h3>{t('modal_signout_title')}</h3>
            </div>
            <div className="modal-body">
              <p className="modal-prompt">
                {t('modal_signout_prompt', {
                  name: account.email || account.authMethod || '',
                })}
              </p>

              <div className="modal-checkbox-card">
                <label className="modal-checkbox-label">
                  <input
                    type="checkbox"
                    checked={eraseDbOnLogout}
                    onChange={(e) => setEraseDbOnLogout(e.target.checked)}
                  />
                  <div className="modal-checkbox-text">
                    <span className="modal-checkbox-title">
                      {t('modal_signout_erase_db')}
                    </span>
                    <span className="modal-checkbox-desc">
                      Default is unchecked: keeps your measurements and sync history intact in SQLite.
                    </span>
                  </div>
                </label>
              </div>

              {eraseDbOnLogout && (
                <div className="modal-danger-alert">
                  <AlertTriangle size={15} />
                  <span>
                    Warning: All local measurements and history will be permanently deleted from your disk.
                  </span>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="action-btn subtle"
                onClick={() => {
                  setShowLogoutConfirm(false);
                  setEraseDbOnLogout(false);
                }}
              >
                {t('modal_signout_cancel')}
              </button>
              <button
                className="action-btn danger"
                onClick={async () => {
                  setShowLogoutConfirm(false);
                  await onLogout(eraseDbOnLogout);
                }}
              >
                {t('sign_out')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
