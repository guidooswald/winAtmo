import React, { useEffect, useState } from 'react';
import {
  Activity,
  CloudSun,
  Database,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  Play,
  RefreshCw,
  Settings,
  Sparkles,
} from 'lucide-react';
import {
  AccountInfo,
  MetricType,
  SyncProgress,
  ThemeId,
  UserSettings,
  WeatherStation,
} from './types';
import { StationDashboard } from './components/StationDashboard';
import { ChartStudio } from './components/ChartStudio';
import { SettingsView } from './components/SettingsView';
import { TaskbarWidget } from './components/TaskbarWidget';
import { applyThemeToDocument, THEMES } from './utils/themes';
import { WinAtmoAPI } from '../main/preload';

declare global {
  interface Window {
    winatmo: WinAtmoAPI;
  }
}

export const App: React.FC = () => {
  const isWidgetMode =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mode') === 'widget';

  if (isWidgetMode) {
    return <TaskbarWidget />;
  }

  return <MainStudioApp />;
};

const MainStudioApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'charts' | 'settings'>(
    'dashboard'
  );
  const [account, setAccount] = useState<AccountInfo>({ loggedIn: false });
  const [stations, setStations] = useState<WeatherStation[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress>({
    active: false,
    phase: 'idle',
    message: 'Idle',
    completedModules: 0,
    totalModules: 0,
    pointsStored: 0,
  });
  const [authBannerError, setAuthBannerError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [chartFocus, setChartFocus] = useState<{
    moduleId: string;
    metric?: string;
  } | null>(null);

  useEffect(() => {
    const init = async () => {
      const [acc, cached, s, prog] = await Promise.all([
        window.winatmo.getAccountInfo(),
        window.winatmo.getCachedStations(),
        window.winatmo.getSettings(),
        window.winatmo.getSyncProgress(),
      ]);
      setAccount(acc);
      setStations(cached.stations || []);
      setSettings(s);
      setSyncProgress(prog);
    };
    init();

    const unsubStations = window.winatmo.onStationsUpdated((next) => {
      setStations(next);
      window.winatmo.getAccountInfo().then(setAccount);
    });

    const unsubProgress = window.winatmo.onSyncProgress((prog) => {
      setSyncProgress(prog);
    });

    const unsubSettings = window.winatmo.onSettingsUpdated((next) => {
      setSettings(next);
    });

    const unsubFocus = window.winatmo.onFocusSensor((payload) => {
      setChartFocus(payload);
      setActiveTab('charts');
    });

    return () => {
      unsubStations();
      unsubProgress();
      unsubSettings();
      unsubFocus();
    };
  }, []);

  const handleUpdateSettings = async (partial: Partial<UserSettings>) => {
    const next = await window.winatmo.updateSettings(partial);
    setSettings(next);
  };

  const handleStartWebLogin = async () => {
    setAuthBusy(true);
    setAuthBannerError(null);
    try {
      const res = await window.winatmo.startWebLogin();
      if (res.success && res.account) {
        setAccount(res.account);
        const cached = await window.winatmo.getCachedStations();
        setStations(cached.stations || []);
      } else if (res.error) {
        setAuthBannerError(res.error);
      }
    } catch (err: any) {
      setAuthBannerError(err?.message || 'Web login failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleStartOAuthLogin = async (
    clientId: string,
    clientSecret: string
  ) => {
    setAuthBusy(true);
    setAuthBannerError(null);
    try {
      const res = await window.winatmo.startOAuthLogin(clientId, clientSecret);
      if (res.success && res.account) {
        setAccount(res.account);
        const cached = await window.winatmo.getCachedStations();
        setStations(cached.stations || []);
      } else if (res.error) {
        setAuthBannerError(res.error);
      }
    } catch (err: any) {
      setAuthBannerError(err?.message || 'OAuth login failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleTokenLogin = async (token: string, refresh?: string) => {
    setAuthBusy(true);
    setAuthBannerError(null);
    try {
      const res = await window.winatmo.loginWithToken(token, refresh);
      if (res.success && res.account) {
        setAccount(res.account);
        const cached = await window.winatmo.getCachedStations();
        setStations(cached.stations || []);
      } else if (res.error) {
        setAuthBannerError(res.error);
      }
    } catch (err: any) {
      setAuthBannerError(err?.message || 'Token login failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleEnableDemo = async () => {
    setAuthBusy(true);
    setAuthBannerError(null);
    try {
      const res = await window.winatmo.enableDemoMode();
      setAccount(res.account);
      setStations(res.stations);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    await window.winatmo.logout();
    setAccount({ loggedIn: false });
    setStations([]);
  };

  const handleSyncNow = async (forceFull = false) => {
    await window.winatmo.syncHistory({ forceFull });
  };

  useEffect(() => {
    if (settings?.theme) {
      applyThemeToDocument(settings.theme);
    }
  }, [settings?.theme]);

  if (!settings) {
    return (
      <div className="loading-screen">
        <RefreshCw size={24} className="spin" />
        <span>Initializing winAtmo...</span>
      </div>
    );
  }

  const darkThemes = THEMES.filter((t) => t.mode === 'dark');
  const lightThemes = THEMES.filter((t) => t.mode === 'light');

  return (
    <div className={`app-shell theme-${settings.theme}`}>
      {/* Top Navigation & Status Header */}
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-logo-icon">
            <CloudSun size={20} />
          </div>
          <div>
            <h1>winAtmo</h1>
            <span className="brand-tagline">
              Netatmo Weather & Air Quality Studio
            </span>
          </div>
        </div>

        <nav className="main-nav-tabs">
          <button
            className={`nav-tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={15} />
            <span>Sensors & Dashboard</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'charts' ? 'active' : ''}`}
            onClick={() => setActiveTab('charts')}
          >
            <LineChart size={15} />
            <span>Flexible Charts</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={15} />
            <span>Settings & SQLite</span>
          </button>
        </nav>

        <div className="header-right-controls">
          {syncProgress.active && (
            <div className="sync-status-pill active">
              <RefreshCw size={13} className="spin" />
              <span>
                {syncProgress.message} (
                {syncProgress.completedModules}/{syncProgress.totalModules})
              </span>
            </div>
          )}

          <select
            className="header-theme-select"
            value={settings.theme}
            onChange={(e) =>
              handleUpdateSettings({ theme: e.target.value as ThemeId })
            }
            title="Switch complete visual theme & density"
          >
            <optgroup label="Dark Themes">
              {darkThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  🌙 {t.familyTitle}: {t.name} ({t.styleLabel.split('•')[0].trim()})
                </option>
              ))}
            </optgroup>
            <optgroup label="Light Themes">
              {lightThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  ☀️ {t.familyTitle}: {t.name} ({t.styleLabel.split('•')[0].trim()})
                </option>
              ))}
            </optgroup>
          </select>

          <button
            className={`header-btn ${settings.widgetEnabled ? 'widget-on' : ''}`}
            onClick={() => window.winatmo.toggleWidget()}
            title="Show or hide the floating Windows Taskbar Widget"
          >
            <LayoutGrid size={14} />
            <span>
              Taskbar Widget: {settings.widgetEnabled ? 'ON' : 'OFF'}
            </span>
          </button>

          {account.loggedIn && (
            <button
              className="header-btn primary"
              onClick={() => handleSyncNow(false)}
              disabled={syncProgress.active}
              title={`Sync current readings & ${
                settings.historyMaxMode
                  ? 'max history'
                  : `${settings.historyDays}d history`
              }`}
            >
              <RefreshCw
                size={14}
                className={syncProgress.active ? 'spin' : ''}
              />
              <span>Sync Now</span>
            </button>
          )}
        </div>
      </header>

      {authBannerError && (
        <div className="error-banner">
          <span>{authBannerError}</span>
          <button onClick={() => setAuthBannerError(null)}>×</button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="app-main-content">
        {!account.loggedIn && stations.length === 0 ? (
          <div className="welcome-onboarding-card">
            <div className="welcome-hero-icon">
              <CloudSun size={40} />
            </div>
            <h2>Connect Your Netatmo Weather Station</h2>
            <p>
              Sign in directly with your Netatmo account via the secure web
              login window. winAtmo automatically loads your live sensor
              readings, stores historical time-series data in a fast local
              SQLite database (default <strong>14 days</strong>, configurable up
              to Netatmo&apos;s maximum), and pins live metrics to your Windows
              Taskbar Widget.
            </p>

            <div className="welcome-cta-row">
              <button
                className="cta-btn primary"
                onClick={handleStartWebLogin}
                disabled={authBusy}
              >
                <Globe size={17} />
                <span>
                  {authBusy
                    ? 'Waiting for Netatmo Login...'
                    : 'Sign in with Netatmo via Web'}
                </span>
              </button>

              <button
                className="cta-btn secondary"
                onClick={handleEnableDemo}
                disabled={authBusy}
              >
                <Sparkles size={17} />
                <span>Try Interactive Demo Station (30d History)</span>
              </button>

              <button
                className="cta-btn ghost"
                onClick={() => setActiveTab('settings')}
              >
                <Settings size={16} />
                <span>OAuth2 / Personal Token Settings</span>
              </button>
            </div>

            <div className="welcome-features-grid">
              <div className="feature-mini-card">
                <LineChart size={18} />
                <h4>Multi-Curve Flexible Charting</h4>
                <p>
                  Compare up to 6 curves across indoor, outdoor, wind, and rain
                  modules with dual Y-axes, stacked panels, moving averages, and
                  CSV export.
                </p>
              </div>
              <div className="feature-mini-card">
                <Database size={18} />
                <h4>Fast Local SQLite Engine</h4>
                <p>
                  Lightweight <code>WITHOUT ROWID</code> time-series storage.
                  Default 14-day history, expandable up to all history since
                  station setup.
                </p>
              </div>
              <div className="feature-mini-card">
                <LayoutGrid size={18} />
                <h4>Windows Taskbar Widget</h4>
                <p>
                  Always-on-top compact taskbar bar & system tray icon displaying
                  live temperatures, CO₂, rain, and 24h mini sparklines.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {account.authMethod === 'demo' && (
              <div className="demo-mode-banner">
                <div>
                  <Sparkles size={15} />
                  <span>
                    <strong>Demo Mode Active:</strong> Showing simulated Zürich
                    Weather Station with 5 modules & 30 days of historical SQLite
                    data.
                  </span>
                </div>
                <button
                  className="banner-login-btn"
                  onClick={handleStartWebLogin}
                >
                  <Globe size={13} /> Sign in with Real Netatmo Account
                </button>
              </div>
            )}

            {activeTab === 'dashboard' && (
              <StationDashboard
                stations={stations}
                settings={settings}
                onUpdateSettings={handleUpdateSettings}
                onOpenInChart={(moduleId: string, metric: MetricType) => {
                  setChartFocus({ moduleId, metric });
                  setActiveTab('charts');
                }}
              />
            )}

            {activeTab === 'charts' && (
              <ChartStudio
                stations={stations}
                settings={settings}
                initialFocus={chartFocus}
                onClearFocus={() => setChartFocus(null)}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                settings={settings}
                account={account}
                stations={stations}
                syncProgress={syncProgress}
                onUpdateSettings={handleUpdateSettings}
                onSyncNow={handleSyncNow}
                onStartWebLogin={handleStartWebLogin}
                onStartOAuthLogin={handleStartOAuthLogin}
                onTokenLogin={handleTokenLogin}
                onLogout={handleLogout}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};
