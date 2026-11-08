import React, { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BatteryCharging,
  CloudRain,
  Compass,
  Cpu,
  Droplets,
  ExternalLink,
  Gauge,
  LineChart,
  MapPin,
  Pin,
  Radio,
  Thermometer,
  Volume2,
  Wifi,
  Wind,
} from 'lucide-react';
import {
  MetricType,
  PinnedSensorItem,
  StationModule,
  UserSettings,
  WeatherStation,
} from '../types';
import {
  extractLiveMetricValue,
  formatMetricValue,
  getCo2QualityBadge,
  getCompassDirection,
  getModuleTypeLabel,
  getRfQualityLabel,
  getWifiQualityLabel,
  METRIC_METADATA,
  SERIES_PALETTE,
} from '../utils/metrics';
import { useI18n } from '../utils/i18n';

declare const __APP_VERSION__: string | undefined;
declare const __APP_BUILD__: number | undefined;
declare const __APP_COMMIT__: string | undefined;
declare const __APP_DATE__: string | undefined;

function getWeathermapUrl(station: WeatherStation): string {
  const loc = station.place?.location;
  if (loc && Array.isArray(loc) && loc.length >= 2) {
    const lon = Number(loc[0]);
    const lat = Number(loc[1]);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      return `https://weathermap.netatmo.com/?zoom=13&lat=${lat}&lng=${lon}&lon=${lon}`;
    }
  }
  return 'https://weathermap.netatmo.com/';
}

interface StationDashboardProps {
  stations: WeatherStation[];
  settings: UserSettings;
  onUpdateSettings: (partial: Partial<UserSettings>) => void;
  onOpenInChart: (moduleId: string, metric: MetricType) => void;
}

export const StationDashboard: React.FC<StationDashboardProps> = ({
  stations,
  settings,
  onUpdateSettings,
  onOpenInChart,
}) => {
  const { t, formatDate, formatTime } = useI18n();
  const [filterMode, setFilterMode] = useState<
    'all' | 'indoor' | 'outdoor' | 'diagnostics'
  >('all');
  const [versionInfo, setVersionInfo] = useState<{
    version: string;
    build: number;
    commit: string;
    date: string;
  }>({
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.2.0',
    build: typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 1,
    commit: typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'main',
    date: typeof __APP_DATE__ !== 'undefined' ? __APP_DATE__ : '2026-10-24',
  });

  useEffect(() => {
    fetch('/__winatmo_version')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.version) {
          setVersionInfo(data);
        }
      })
      .catch(() => {});
  }, []);

  const isPinned = (stationId: string, moduleId: string, metric: MetricType) => {
    const id = `${stationId}::${moduleId}::${metric}`;
    return settings.pinnedSensors.some((p) => p.id === id);
  };

  const togglePinSensor = (
    st: WeatherStation,
    mod: StationModule,
    metric: MetricType
  ) => {
    const id = `${st.id}::${mod.id}::${metric}`;
    const existing = settings.pinnedSensors.find((p) => p.id === id);
    let nextPinned: PinnedSensorItem[];
    if (existing) {
      nextPinned = settings.pinnedSensors.filter((p) => p.id !== id);
    } else {
      const color =
        METRIC_METADATA[metric]?.defaultColor ||
        SERIES_PALETTE[settings.pinnedSensors.length % SERIES_PALETTE.length];
      nextPinned = [
        ...settings.pinnedSensors,
        {
          id,
          stationId: st.id,
          moduleId: mod.id,
          moduleName: mod.moduleName,
          stationName: st.stationName,
          metric,
          color,
        },
      ];
    }
    onUpdateSettings({ pinnedSensors: nextPinned });
  };

  const renderTrendIcon = (trend?: 'up' | 'down' | 'stable') => {
    if (trend === 'up') {
      return (
        <span className="trend-badge up" title={t('trend_up')}>
          <ArrowUpRight size={13} /> {t('trend_up')}
        </span>
      );
    }
    if (trend === 'down') {
      return (
        <span className="trend-badge down" title={t('trend_down')}>
          <ArrowDownRight size={13} /> {t('trend_down')}
        </span>
      );
    }
    if (trend === 'stable') {
      return (
        <span className="trend-badge stable" title={t('trend_stable')}>
          <ArrowRight size={13} /> {t('trend_stable')}
        </span>
      );
    }
    return null;
  };

  const hasWindOrRain = stations.some((st) =>
    st.modules.some((m) => m.type === 'NAModule2' || m.type === 'NAModule3')
  );

  return (
    <div className="dashboard-container">
      {/* Filter & Pin Info Bar */}
      <div className="dashboard-topbar">
        <div className="pill-group">
          <button
            className={`pill-btn ${filterMode === 'all' ? 'active' : ''}`}
            onClick={() => setFilterMode('all')}
          >
            {t('filter_all')}
          </button>
          <button
            className={`pill-btn ${filterMode === 'indoor' ? 'active' : ''}`}
            onClick={() => setFilterMode('indoor')}
          >
            {t('filter_indoor')}
          </button>
          <button
            className={`pill-btn ${filterMode === 'outdoor' ? 'active' : ''}`}
            onClick={() => setFilterMode('outdoor')}
          >
            {hasWindOrRain ? t('filter_outdoor_wind_rain') : t('filter_outdoor')}
          </button>
          <button
            className={`pill-btn ${filterMode === 'diagnostics' ? 'active' : ''}`}
            onClick={() => setFilterMode('diagnostics')}
          >
            {t('filter_diagnostics')}
          </button>
        </div>

        <div className="pinned-summary-pill">
          <Pin size={13} />
          <span>
            {settings.pinnedSensors.length === 1
              ? t('pinned_summary_single')
              : t('pinned_summary_plural', { count: settings.pinnedSensors.length })}
          </span>
        </div>
      </div>

      {stations.map((station) => {
        const filteredModules = station.modules.filter((m) => {
          if (filterMode === 'indoor') {
            return (
              m.type === 'NAMain' || m.type === 'NAModule4' || m.type === 'NHC'
            );
          }
          if (filterMode === 'outdoor') {
            return (
              m.type === 'NAModule1' ||
              m.type === 'NAModule2' ||
              m.type === 'NAModule3'
            );
          }
          return true;
        });

        const locationParts = [station.place?.city, station.place?.country].filter(Boolean);
        const locationText =
          locationParts.length > 0
            ? locationParts.join(', ')
            : station.place?.location
              ? 'Weathermap'
              : null;
        const weathermapUrl = getWeathermapUrl(station);

        return (
          <section key={station.id} className="station-section">
            <div className="station-header-banner">
              <div className="station-title-block">
                <h2>{station.homeName}</h2>
                <div className="station-sub">
                  <span>{station.stationName}</span>
                  {locationText && (
                    <>
                      <span className="station-sub-sep">•</span>
                      <button
                        type="button"
                        className="station-location-btn"
                        onClick={() => window.winatmo.openExternal(weathermapUrl)}
                        title={`Open ${locationText} on Netatmo Weathermap`}
                      >
                        <MapPin size={12} className="location-pin-icon" />
                        <span>{locationText}</span>
                        <ExternalLink size={10} className="location-ext-icon" />
                      </button>
                    </>
                  )}
                  {station.place?.altitude !== undefined
                    ? ` • ${t('altitude', { alt: station.place.altitude })}`
                    : ''}
                </div>
              </div>
              <div className="station-meta-badges">
                {station.place?.timezone && (
                  <button
                    type="button"
                    className="meta-badge clickable"
                    onClick={() => window.winatmo.openExternal(weathermapUrl)}
                    title={`${t('open_weathermap')} (${station.place.timezone})`}
                  >
                    <MapPin size={12} /> {station.place.timezone}
                  </button>
                )}
                <span className="meta-badge">
                  {t('station_setup', {
                    date: formatDate(station.dateSetup * 1000),
                  })}
                </span>
                <span
                  className={`meta-badge ${station.reachable ? 'online' : 'offline'}`}
                >
                  {station.reachable ? `● ${t('online')}` : `○ ${t('offline')}`}
                </span>
              </div>
            </div>

            {filterMode === 'diagnostics' ? (
              <div className="diagnostics-table-card">
                <table className="diagnostics-table">
                  <thead>
                    <tr>
                      <th>{t('diag_module_name')}</th>
                      <th>{t('diag_product_type')}</th>
                      <th>{t('diag_mac')}</th>
                      <th>{t('diag_status')}</th>
                      <th>{t('diag_signal')}</th>
                      <th>{t('diag_battery')}</th>
                      <th>{t('diag_firmware')}</th>
                      <th>{t('diag_last_update')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {station.modules.map((mod) => {
                      const wifi = getWifiQualityLabel(mod.wifiStatus);
                      const rf = getRfQualityLabel(mod.rfStatus);
                      return (
                        <tr key={mod.id}>
                          <td>
                            <strong>{mod.moduleName}</strong>
                          </td>
                          <td>
                            <span className="code-badge">{mod.type}</span>{' '}
                            {getModuleTypeLabel(mod.type)}
                          </td>
                          <td>
                            <code className="mac-code">{mod.id}</code>
                          </td>
                          <td>
                            <span
                              className={`status-dot-pill ${mod.reachable ? 'ok' : 'err'}`}
                            >
                              {mod.reachable ? t('diag_reachable') : t('diag_unreachable')}
                            </span>
                          </td>
                          <td>
                            {mod.wifiStatus !== undefined ? (
                              <span style={{ color: wifi.color }}>
                                <Wifi size={13} /> {t('wifi_signal')}: {wifi.label}
                              </span>
                            ) : (
                              <span style={{ color: rf.color }}>
                                <Radio size={13} /> {t('rf_signal')}: {rf.label}
                              </span>
                            )}
                          </td>
                          <td>
                            {mod.batteryPercent !== undefined ||
                            mod.batteryVp !== undefined ? (
                              <span className="battery-cell">
                                <BatteryCharging size={14} />
                                {mod.batteryPercent !== undefined
                                  ? `${mod.batteryPercent}%`
                                  : ''}{' '}
                                {mod.batteryVp !== undefined
                                  ? `(${mod.batteryVp} mV • ${mod.batteryState || 'ok'})`
                                  : ''}
                              </span>
                            ) : (
                              <span className="muted-text">
                                {t('usb_powered')}
                              </span>
                            )}
                          </td>
                          <td>v{mod.firmware ?? '--'}</td>
                          <td>
                            {mod.lastSeen
                              ? formatTime(mod.lastSeen * 1000)
                              : '--'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="modules-cards-grid">
                {filteredModules.map((mod) => {
                  const d = mod.dashboard;
                  const co2Badge =
                    d?.CO2 !== undefined ? getCo2QualityBadge(d.CO2) : null;

                  return (
                    <div key={mod.id} className="module-card">
                      <div className="module-card-header">
                        <div>
                          <div className="module-title-row">
                            <h3>{mod.moduleName}</h3>
                            {co2Badge && (
                              <span
                                className="co2-quality-pill"
                                style={{
                                  color: co2Badge.color,
                                  backgroundColor: co2Badge.bg,
                                }}
                              >
                                {co2Badge.label}
                              </span>
                            )}
                          </div>
                          <span className="module-subtitle">
                            {getModuleTypeLabel(mod.type)}
                          </span>
                        </div>

                        <div className="module-hw-icons">
                          {mod.wifiStatus !== undefined && (
                            <span
                              className="hw-pill"
                              title={`Wi-Fi Signal: ${getWifiQualityLabel(mod.wifiStatus).label}`}
                            >
                              <Wifi size={13} />
                            </span>
                          )}
                          {mod.rfStatus !== undefined && (
                            <span
                              className="hw-pill"
                              title={`Radio RF: ${getRfQualityLabel(mod.rfStatus).label}`}
                            >
                              <Radio size={13} />
                            </span>
                          )}
                          {mod.batteryPercent !== undefined && (
                            <span
                              className="hw-pill"
                              title={`Battery: ${mod.batteryPercent}% (${mod.batteryVp || '--'} mV)`}
                            >
                              <BatteryCharging size={13} />
                              {mod.batteryPercent}%
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Primary Hero Metric + Secondary Metrics */}
                      <div className="module-metrics-list">
                        {mod.availableMetrics.map((metric) => {
                          const liveVal = extractLiveMetricValue(d, metric);
                          const pinned = isPinned(station.id, mod.id, metric);

                          return (
                            <div key={metric} className="metric-row-item">
                              <div className="metric-row-left">
                                <span
                                  className="metric-icon-box"
                                  style={{
                                    color:
                                      METRIC_METADATA[metric]?.defaultColor,
                                    backgroundColor: `${METRIC_METADATA[metric]?.defaultColor}18`,
                                  }}
                                >
                                  {renderMetricIcon(metric)}
                                </span>
                                <div>
                                  <div className="metric-row-label">
                                    {METRIC_METADATA[metric]?.label || metric}
                                  </div>
                                  {metric === 'temperature' && d && (
                                    <div className="metric-row-sub">
                                      {d.min_temp !== undefined &&
                                        `Min ${formatMetricValue(d.min_temp, 'temperature', settings)}`}{' '}
                                      {d.max_temp !== undefined &&
                                        `• Max ${formatMetricValue(d.max_temp, 'temperature', settings)}`}
                                    </div>
                                  )}
                                  {metric === 'rain' && d && (
                                    <div className="metric-row-sub">
                                      1h:{' '}
                                      {formatMetricValue(
                                        d.sum_rain_1,
                                        'rain',
                                        settings
                                      )}{' '}
                                      • 24h:{' '}
                                      {formatMetricValue(
                                        d.sum_rain_24,
                                        'rain',
                                        settings
                                      )}
                                    </div>
                                  )}
                                  {metric === 'windangle' && d && (
                                    <div className="metric-row-sub">
                                      Compass:{' '}
                                      <strong>
                                        {getCompassDirection(d.WindAngle)}
                                      </strong>
                                    </div>
                                  )}
                                  {metric === 'guststrength' &&
                                    d?.max_wind_str !== undefined && (
                                      <div className="metric-row-sub">
                                        Max Gust Today:{' '}
                                        {formatMetricValue(
                                          d.max_wind_str,
                                          'guststrength',
                                          settings
                                        )}
                                      </div>
                                    )}
                                </div>
                              </div>

                              <div className="metric-row-right">
                                <div className="metric-val-col">
                                  <span className="metric-primary-val">
                                    {formatMetricValue(
                                      liveVal,
                                      metric,
                                      settings
                                    )}
                                  </span>
                                  {metric === 'temperature' &&
                                    renderTrendIcon(d?.temp_trend)}
                                  {metric === 'pressure' &&
                                    renderTrendIcon(d?.pressure_trend)}
                                </div>

                                <div className="metric-row-actions">
                                  <button
                                    className={`icon-action-btn ${pinned ? 'pinned' : ''}`}
                                    onClick={() =>
                                      togglePinSensor(station, mod, metric)
                                    }
                                    title={
                                      pinned
                                        ? t('unpin_from_widget')
                                        : t('pin_to_widget')
                                    }
                                  >
                                    <Pin size={13} />
                                  </button>
                                  <button
                                    className="icon-action-btn"
                                    onClick={() =>
                                      onOpenInChart(mod.id, metric)
                                    }
                                    title={t('open_in_charts')}
                                  >
                                    <LineChart size={13} />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="module-card-footer">
                        <span>
                          ID: <code>{mod.id.slice(-8)}</code> • FW v
                          {mod.firmware ?? '--'}
                        </span>
                        <span>
                          Measured:{' '}
                          {d?.time_utc
                            ? new Date(d.time_utc * 1000).toLocaleTimeString(
                                [],
                                {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                }
                              )
                            : '--'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      <footer className="dashboard-version-footer">
        <span>
          winAtmo <strong>v{versionInfo.version}</strong> (build #
          {versionInfo.build} • {versionInfo.date} • {versionInfo.commit})
        </span>
        <span className="footer-sep">•</span>
        <a
          href="https://github.com/guidooswald/winAtmo"
          onClick={(e) => {
            e.preventDefault();
            window.winatmo.openExternal('https://github.com/guidooswald/winAtmo');
          }}
        >
          github.com/guidooswald/winAtmo <ExternalLink size={10} />
        </a>
        <span className="footer-sep">•</span>
        <a
          href="https://guido.swiss"
          onClick={(e) => {
            e.preventDefault();
            window.winatmo.openExternal('https://guido.swiss');
          }}
        >
          guido.swiss <ExternalLink size={10} />
        </a>
      </footer>
    </div>
  );
};

function renderMetricIcon(metric: MetricType) {
  switch (metric) {
    case 'temperature':
      return <Thermometer size={15} />;
    case 'humidity':
      return <Droplets size={15} />;
    case 'co2':
      return <Activity size={15} />;
    case 'pressure':
      return <Gauge size={15} />;
    case 'noise':
      return <Volume2 size={15} />;
    case 'rain':
    case 'sum_rain':
      return <CloudRain size={15} />;
    case 'windstrength':
    case 'guststrength':
      return <Wind size={15} />;
    case 'windangle':
    case 'gustangle':
      return <Compass size={15} />;
    default:
      return <Cpu size={15} />;
  }
}
