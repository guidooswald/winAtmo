import React, { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  CloudSun,
  Database,
  ExternalLink,
  Globe,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  Play,
  RefreshCw,
  Settings,
  Shield,
  ShieldCheck,
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
import { SecurityView } from './components/SecurityView';
import { SettingsView } from './components/SettingsView';
import { TaskbarWidget } from './components/TaskbarWidget';
import { DebugConsoleWindow } from './components/DebugConsoleWindow';
import { SyncOverlayWindow } from './components/SyncOverlayWindow';
import { WindowTopBar } from './components/WindowTopBar';
import { applyThemeToDocument, THEMES } from './utils/themes';
import { LanguageProvider, useI18n } from './utils/i18n';
import { WinAtmoAPI } from '../main/preload';

declare global {
  interface Window {
    winatmo: WinAtmoAPI;
  }
}

export const App: React.FC = () => {
  const mode =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('mode')
      : null;

  if (mode === 'widget') {
    return <TaskbarWidget />;
  }

  if (mode === 'debug') {
    return <DebugConsoleWindow />;
  }

  return <MainStudioApp />;
};

const MainStudioApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'charts' | 'security' | 'settings'
  >('dashboard');
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
  const [showInlineAuth, setShowInlineAuth] = useState<boolean>(false);
  const [welcomeAuthTab, setWelcomeAuthTab] = useState<'token' | 'oauth'>('token');
  const [welcomeToken, setWelcomeToken] = useState<string>('');
  const [welcomeRefresh, setWelcomeRefresh] = useState<string>('');
  const [welcomeClientId, setWelcomeClientId] = useState<string>('');
  const [welcomeClientSecret, setWelcomeClientSecret] = useState<string>('');
  const [welcomeStoreLocally, setWelcomeStoreLocally] = useState<boolean>(true);
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
      if (s?.oauthClientId) setWelcomeClientId(s.oauthClientId);
      if (s?.oauthClientSecret) setWelcomeClientSecret(s.oauthClientSecret);
    };
    init();

    const unsubStations = window.winatmo.onStationsUpdated((next) => {
      setStations(next);
      window.winatmo.getAccountInfo().then(setAccount);
    });

    const unsubAccount = window.winatmo.onAccountUpdated?.((next) => {
      setAccount(next);
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
      unsubAccount?.();
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
        setActiveTab('dashboard');
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
    clientSecret: string,
    storeLocally = true
  ) => {
    setAuthBusy(true);
    setAuthBannerError(null);
    try {
      const res = await window.winatmo.startOAuthLogin(
        clientId,
        clientSecret,
        storeLocally
      );
      if (res.success && res.account) {
        setAccount(res.account);
        const cached = await window.winatmo.getCachedStations();
        setStations(cached.stations || []);
        setActiveTab('dashboard');
      } else if (res.error) {
        setAuthBannerError(res.error);
      }
    } catch (err: any) {
      setAuthBannerError(err?.message || 'OAuth login failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleTokenLogin = async (
    token: string,
    refresh?: string,
    clientId?: string,
    clientSecret?: string,
    storeLocally = true
  ) => {
    setAuthBusy(true);
    setAuthBannerError(null);
    try {
      const res = await window.winatmo.loginWithToken(
        token,
        refresh,
        clientId,
        clientSecret,
        storeLocally
      );
      if (res.success && res.account) {
        setAccount(res.account);
        const cached = await window.winatmo.getCachedStations();
        setStations(cached.stations || []);
        setActiveTab('dashboard');
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
      setActiveTab('dashboard');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async (eraseDatabase = false) => {
    await window.winatmo.logout({ eraseDatabase });
    setAccount({ loggedIn: false });
    setStations([]);
    setChartFocus(null);
    setActiveTab('dashboard');
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

  return (
    <LanguageProvider language={settings.language}>
      <MainStudioShell
        settings={settings}
        account={account}
        stations={stations}
        syncProgress={syncProgress}
        authBannerError={authBannerError}
        setAuthBannerError={setAuthBannerError}
        authBusy={authBusy}
        showInlineAuth={showInlineAuth}
        setShowInlineAuth={setShowInlineAuth}
        welcomeAuthTab={welcomeAuthTab}
        setWelcomeAuthTab={setWelcomeAuthTab}
        welcomeToken={welcomeToken}
        setWelcomeToken={setWelcomeToken}
        welcomeRefresh={welcomeRefresh}
        setWelcomeRefresh={setWelcomeRefresh}
        welcomeClientId={welcomeClientId}
        setWelcomeClientId={setWelcomeClientId}
        welcomeClientSecret={welcomeClientSecret}
        setWelcomeClientSecret={setWelcomeClientSecret}
        welcomeStoreLocally={welcomeStoreLocally}
        setWelcomeStoreLocally={setWelcomeStoreLocally}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        chartFocus={chartFocus}
        setChartFocus={setChartFocus}
        handleUpdateSettings={handleUpdateSettings}
        handleStartWebLogin={handleStartWebLogin}
        handleStartOAuthLogin={handleStartOAuthLogin}
        handleTokenLogin={handleTokenLogin}
        handleEnableDemo={handleEnableDemo}
        handleLogout={handleLogout}
        handleSyncNow={handleSyncNow}
      />
    </LanguageProvider>
  );
};

interface MainStudioShellProps {
  settings: UserSettings;
  account: AccountInfo;
  stations: WeatherStation[];
  syncProgress: SyncProgress;
  authBannerError: string | null;
  setAuthBannerError: (err: string | null) => void;
  authBusy: boolean;
  showInlineAuth: boolean;
  setShowInlineAuth: React.Dispatch<React.SetStateAction<boolean>>;
  welcomeAuthTab: 'token' | 'oauth';
  setWelcomeAuthTab: (tab: 'token' | 'oauth') => void;
  welcomeToken: string;
  setWelcomeToken: (val: string) => void;
  welcomeRefresh: string;
  setWelcomeRefresh: (val: string) => void;
  welcomeClientId: string;
  setWelcomeClientId: (val: string) => void;
  welcomeClientSecret: string;
  setWelcomeClientSecret: (val: string) => void;
  welcomeStoreLocally: boolean;
  setWelcomeStoreLocally: (val: boolean) => void;
  activeTab: 'dashboard' | 'charts' | 'security' | 'settings';
  setActiveTab: (tab: 'dashboard' | 'charts' | 'security' | 'settings') => void;
  chartFocus: { moduleId: string; metric?: string } | null;
  setChartFocus: (focus: { moduleId: string; metric?: string } | null) => void;
  handleUpdateSettings: (partial: Partial<UserSettings>) => Promise<void>;
  handleStartWebLogin: () => Promise<void>;
  handleStartOAuthLogin: (
    clientId: string,
    clientSecret: string,
    storeLocally?: boolean
  ) => Promise<void>;
  handleTokenLogin: (
    token: string,
    refresh?: string,
    clientId?: string,
    clientSecret?: string,
    storeLocally?: boolean
  ) => Promise<void>;
  handleEnableDemo: () => Promise<void>;
  handleLogout: (eraseDatabase?: boolean) => Promise<void>;
  handleSyncNow: (forceFull?: boolean) => Promise<void>;
}

const MainStudioShell: React.FC<MainStudioShellProps> = ({
  settings,
  account,
  stations,
  syncProgress,
  authBannerError,
  setAuthBannerError,
  authBusy,
  showInlineAuth,
  setShowInlineAuth,
  welcomeAuthTab,
  setWelcomeAuthTab,
  welcomeToken,
  setWelcomeToken,
  welcomeRefresh,
  setWelcomeRefresh,
  welcomeClientId,
  setWelcomeClientId,
  welcomeClientSecret,
  setWelcomeClientSecret,
  welcomeStoreLocally,
  setWelcomeStoreLocally,
  activeTab,
  setActiveTab,
  chartFocus,
  setChartFocus,
  handleUpdateSettings,
  handleStartWebLogin,
  handleStartOAuthLogin,
  handleTokenLogin,
  handleEnableDemo,
  handleLogout,
  handleSyncNow,
}) => {
  const { t } = useI18n();
  const primaryStation = stations.length > 0 ? stations[0] : undefined;
  const primaryStationName =
    primaryStation?.stationName || primaryStation?.homeName;

  return (
    <div
      className={`app-shell theme-${settings.theme} platform-${
        window.winatmo?.platform || 'win32'
      }`}
    >
      {/* Theme-Synced Window Top Bar with Integrated Theme Selector & Controls */}
      <WindowTopBar
        title="winAtmo"
        activeStationName={primaryStationName}
        currentTheme={settings.theme}
        onThemeChange={(theme) => handleUpdateSettings({ theme })}
      />

      {/* Top Navigation & Status Header */}
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-logo-icon">
            <CloudSun size={20} />
          </div>
          <div>
            <h1>winAtmo</h1>
            <span className="brand-tagline">
              {t('brand_tagline')}
            </span>
          </div>
        </div>

        <nav className="main-nav-tabs">
          <button
            className={`nav-tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            <LayoutDashboard size={15} />
            <span>{t('nav_sensors')}</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'charts' ? 'active' : ''}`}
            onClick={() => setActiveTab('charts')}
          >
            <LineChart size={15} />
            <span>{t('nav_charts')}</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'security' ? 'active' : ''}`}
            onClick={() => setActiveTab('security')}
          >
            <Shield size={15} />
            <span>{t('nav_security')}</span>
          </button>
          <button
            className={`nav-tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
          >
            <Settings size={15} />
            <span>{t('nav_settings')}</span>
          </button>
        </nav>

        <div className="header-right-controls">
          <button
            className={`header-btn ${settings.widgetEnabled ? 'widget-on' : ''}`}
            onClick={() => window.winatmo.toggleWidget()}
            title="Show or hide the floating Windows Taskbar Widget"
          >
            <LayoutGrid size={14} />
            <span>
              {t('taskbar_widget_btn', {
                status: settings.widgetEnabled ? t('on') : t('off'),
              })}
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
              <span>{syncProgress.active ? t('syncing') : t('sync_now')}</span>
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
        {activeTab === 'settings' ? (
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
        ) : !account.loggedIn && stations.length === 0 ? (
          <div className="welcome-onboarding-card">
            <div className="welcome-hero-icon">
              <CloudSun size={40} />
            </div>
            <h2>{t('welcome_title')}</h2>
            <p>{t('welcome_desc')}</p>

            <div className="welcome-cta-row">
              <button
                className="cta-btn primary"
                onClick={handleStartWebLogin}
                disabled={authBusy}
              >
                <Globe size={17} />
                <span>
                  {authBusy
                    ? t('welcome_btn_web_waiting')
                    : t('welcome_btn_web')}
                </span>
              </button>

              <button
                className="cta-btn secondary"
                onClick={handleEnableDemo}
                disabled={authBusy}
              >
                <Sparkles size={17} />
                <span>{t('welcome_btn_demo')}</span>
              </button>

              <button
                className={`cta-btn ghost ${showInlineAuth ? 'active' : ''}`}
                onClick={() => setShowInlineAuth((prev) => !prev)}
                title="Enter Personal Access Token or OAuth2 App Credentials"
              >
                <KeyRound size={16} />
                <span>{t('welcome_btn_token')}</span>
              </button>
            </div>

            {showInlineAuth && (
              <div className="welcome-inline-auth-card">
                <div className="inline-auth-tabs">
                  <button
                    className={`inline-auth-tab ${welcomeAuthTab === 'token' ? 'active' : ''}`}
                    onClick={() => setWelcomeAuthTab('token')}
                  >
                    <KeyRound size={14} />
                    <span>{t('welcome_tab_token')}</span>
                  </button>
                  <button
                    className={`inline-auth-tab ${welcomeAuthTab === 'oauth' ? 'active' : ''}`}
                    onClick={() => setWelcomeAuthTab('oauth')}
                  >
                    <ShieldCheck size={14} />
                    <span>{t('welcome_tab_oauth')}</span>
                  </button>
                </div>

                {welcomeAuthTab === 'token' ? (
                  <div className="inline-auth-form">
                    <p className="inline-auth-desc">
                      {t('welcome_token_desc')}{' '}
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          window.winatmo.openExternal(
                            'https://dev.netatmo.com/apps/'
                          );
                        }}
                      >
                        Netatmo Developer Portal <ExternalLink size={11} />
                      </a>:
                    </p>
                    <div className="inline-auth-inputs">
                      <input
                        type="password"
                        placeholder={t('welcome_token_placeholder')}
                        value={welcomeToken}
                        onChange={(e) => setWelcomeToken(e.target.value)}
                        className="text-input"
                        autoFocus
                      />
                      <input
                        type="password"
                        placeholder={t('welcome_refresh_placeholder')}
                        value={welcomeRefresh}
                        onChange={(e) => setWelcomeRefresh(e.target.value)}
                        className="text-input"
                      />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
                        <input
                          type="text"
                          placeholder={t('welcome_client_id_placeholder')}
                          value={welcomeClientId}
                          onChange={(e) => setWelcomeClientId(e.target.value)}
                          className="text-input"
                        />
                        <input
                          type="password"
                          placeholder={t('welcome_client_secret_placeholder')}
                          value={welcomeClientSecret}
                          onChange={(e) => setWelcomeClientSecret(e.target.value)}
                          className="text-input"
                        />
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-subtle)', cursor: 'pointer', marginTop: 6 }}>
                        <input
                          type="checkbox"
                          checked={welcomeStoreLocally}
                          onChange={(e) => setWelcomeStoreLocally(e.target.checked)}
                        />
                        <span>{t('welcome_store_locally_checkbox')}</span>
                      </label>
                    </div>
                    <div className="inline-auth-actions">
                      <button
                        className="cta-btn primary"
                        disabled={!welcomeToken.trim() || authBusy}
                        onClick={() =>
                          handleTokenLogin(
                            welcomeToken.trim(),
                            welcomeRefresh.trim() || undefined,
                            welcomeClientId.trim() || undefined,
                            welcomeClientSecret.trim() || undefined,
                            welcomeStoreLocally
                          )
                        }
                      >
                        <CheckCircle2 size={15} />
                        <span>
                          {authBusy ? t('welcome_btn_connecting') : t('welcome_btn_connect_token')}
                        </span>
                      </button>
                      <button
                        className="cta-btn ghost"
                        onClick={() => setActiveTab('settings')}
                      >
                        <Settings size={14} />
                        <span>{t('welcome_btn_open_settings')}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="inline-auth-form">
                    <p className="inline-auth-desc">
                      {t('welcome_oauth_desc')}{' '}
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
                      </a>:
                    </p>
                    <div className="inline-auth-inputs">
                      <input
                        type="text"
                        placeholder={t('welcome_oauth_client_id')}
                        value={welcomeClientId}
                        onChange={(e) => setWelcomeClientId(e.target.value)}
                        className="text-input"
                        autoFocus
                      />
                      <input
                        type="password"
                        placeholder={t('welcome_oauth_client_secret')}
                        value={welcomeClientSecret}
                        onChange={(e) =>
                          setWelcomeClientSecret(e.target.value)
                        }
                        className="text-input"
                      />
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-subtle)', cursor: 'pointer', marginTop: 6 }}>
                        <input
                          type="checkbox"
                          checked={welcomeStoreLocally}
                          onChange={(e) => setWelcomeStoreLocally(e.target.checked)}
                        />
                        <span>{t('welcome_store_locally_checkbox')}</span>
                      </label>
                    </div>
                    <div className="inline-auth-actions">
                      <button
                        className="cta-btn primary"
                        disabled={
                          !welcomeClientId.trim() ||
                          !welcomeClientSecret.trim() ||
                          authBusy
                        }
                        onClick={() =>
                          handleStartOAuthLogin(
                            welcomeClientId.trim(),
                            welcomeClientSecret.trim(),
                            welcomeStoreLocally
                          )
                        }
                      >
                        <ShieldCheck size={15} />
                        <span>
                          {authBusy ? t('welcome_btn_authorizing') : t('welcome_btn_authorize')}
                        </span>
                      </button>
                      <button
                        className="cta-btn ghost"
                        onClick={() => setActiveTab('settings')}
                      >
                        <Settings size={14} />
                        <span>{t('welcome_btn_open_settings')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="welcome-features-grid">
              <div className="feature-mini-card">
                <LineChart size={18} />
                <h4>{t('welcome_feature_2_title')}</h4>
                <p>{t('welcome_feature_2_desc')}</p>
              </div>
              <div className="feature-mini-card">
                <Database size={18} />
                <h4>{t('welcome_feature_1_title')}</h4>
                <p>{t('welcome_feature_1_desc')}</p>
              </div>
              <div className="feature-mini-card">
                <LayoutGrid size={18} />
                <h4>{t('welcome_feature_3_title')}</h4>
                <p>{t('welcome_feature_3_desc')}</p>
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
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    className="banner-exit-btn"
                    onClick={() => handleLogout(false)}
                  >
                    {t('exit_demo')}
                  </button>
                  <button
                    className="banner-login-btn"
                    onClick={handleStartWebLogin}
                  >
                    <Globe size={13} /> {t('welcome_btn_web')}
                  </button>
                </div>
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

            {activeTab === 'security' && (
              <SecurityView
                account={account}
                onOpenSettings={() => setActiveTab('settings')}
              />
            )}
          </>
        )}
      </main>

      {/* Floating Sync & Download Overlay Window */}
      <SyncOverlayWindow progress={syncProgress} />
    </div>
  );
};
