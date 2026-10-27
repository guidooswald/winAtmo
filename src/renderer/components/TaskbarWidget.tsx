import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GripVertical,
  RefreshCw,
} from 'lucide-react';
import {
  DashboardReadings,
  MeasureSeries,
  MetricType,
  PinnedSensorItem,
  UserSettings,
  WeatherStation,
} from '../types';
import {
  convertMetricValue,
  extractLiveMetricValue,
  formatMetricValue,
  getCo2QualityBadge,
  METRIC_METADATA,
  SERIES_PALETTE,
} from '../utils/metrics';
import { applyThemeToDocument } from '../utils/themes';

export const TaskbarWidget: React.FC = () => {
  const [stations, setStations] = useState<WeatherStation[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [expandDirection, setExpandDirection] = useState<'up' | 'down'>('up');
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({});
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const sensorsStripRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useRef<boolean>(false);
  expandedRef.current = expanded;
  const prevThemeRef = useRef<string | undefined>(undefined);
  const lastThemeChangeTimeRef = useRef<number>(0);
  const measureTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resizeRef = useRef<{
    resizing: boolean;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  }>({
    resizing: false,
    startX: 0,
    startY: 0,
    startW: 0,
    startH: 0,
  });

  useEffect(() => {
    const init = async () => {
      const [cached, s, dir] = await Promise.all([
        window.winatmo.getCachedStations(),
        window.winatmo.getSettings(),
        window.winatmo.getWidgetExpandDirection().catch(() => 'up' as const),
      ]);
      setStations(cached.stations || []);
      setSettings(s);
      setExpandDirection(dir);
    };
    init();

    const unsubStations = window.winatmo.onStationsUpdated((next) => {
      setStations(next);
    });
    const unsubSettings = window.winatmo.onSettingsUpdated((next) => {
      setSettings(next);
    });
    const unsubDirection = window.winatmo.onWidgetDirectionUpdated((dir) => {
      setExpandDirection(dir);
    });

    return () => {
      unsubStations();
      unsubSettings();
      unsubDirection();
    };
  }, []);

  // Resolve effective pinned items
  const activePins: PinnedSensorItem[] = React.useMemo(() => {
    if (!settings) return [];
    if (settings.pinnedSensors.length > 0) {
      return settings.pinnedSensors;
    }
    // Fallback to first 3 available sensors
    const fallback: PinnedSensorItem[] = [];
    for (const st of stations) {
      for (const mod of st.modules) {
        if (mod.availableMetrics.includes('temperature')) {
          fallback.push({
            id: `${st.id}::${mod.id}::temperature`,
            stationId: st.id,
            moduleId: mod.id,
            moduleName: mod.moduleName,
            stationName: st.stationName,
            metric: 'temperature',
            color: SERIES_PALETTE[fallback.length % SERIES_PALETTE.length],
          });
        }
        if (fallback.length >= 3) break;
      }
    }
    return fallback;
  }, [settings, stations]);

  if (settings && prevThemeRef.current !== undefined && prevThemeRef.current !== settings.theme) {
    lastThemeChangeTimeRef.current = Date.now();
  }
  if (settings) {
    prevThemeRef.current = settings.theme;
  }

  // Measure exact single-line width of all pinned sensor pills to fit the window seamlessly
  const pinnedIdsKey = activePins.map((p) => p.id).join('|');

  const measureAndResize = () => {
    if (!settings || resizeRef.current.resizing || expandedRef.current) return;
    const stripEl = sensorsStripRef.current;
    if (!stripEl) return;

    const children = Array.from(stripEl.children) as HTMLElement[];
    if (children.length === 0) return;

    let contentWidth = 0;
    for (const child of children) {
      contentWidth += Math.ceil(child.getBoundingClientRect().width);
    }

    const computedGap = parseFloat(window.getComputedStyle(stripEl).gap) || 6;
    if (children.length > 1) {
      contentWidth += (children.length - 1) * computedGap;
    }

    const isCompact = settings.theme?.startsWith('compact');
    const stripContainer = stripEl.parentElement;
    const dragHandle = stripContainer?.querySelector('.widget-drag-handle') as HTMLElement | null;
    const controls = stripContainer?.querySelector('.widget-strip-controls') as HTMLElement | null;
    const dragHandleWidth = dragHandle ? Math.ceil(dragHandle.getBoundingClientRect().width) : (isCompact ? 16 : 18);
    const controlsWidth = controls ? Math.ceil(controls.getBoundingClientRect().width) : (isCompact ? 22 : 24);

    const parentStyle = stripContainer ? window.getComputedStyle(stripContainer) : null;
    const padLeft = parentStyle ? parseFloat(parentStyle.paddingLeft) || 0 : (isCompact ? 6 : 8);
    const padRight = parentStyle ? parseFloat(parentStyle.paddingRight) || 0 : (isCompact ? 6 : 10);
    const borderLeft = parentStyle ? parseFloat(parentStyle.borderLeftWidth) || 0 : 1;
    const borderRight = parentStyle ? parseFloat(parentStyle.borderRightWidth) || 0 : 1;
    const parentGap = parentStyle ? parseFloat(parentStyle.gap) || 0 : 6;

    // Minimum precise width to cleanly frame all sensor pills, drag grip, controls, and theme padding with 1px buffer
    const minContentWidth = Math.max(
      120,
      Math.ceil(
        padLeft +
        borderLeft +
        dragHandleWidth +
        parentGap +
        contentWidth +
        parentGap +
        controlsWidth +
        borderRight +
        padRight +
        1
      )
    );

    const defaultCollapsedHeight = isCompact ? 34 : 42;
    const isRecentThemeChange = Date.now() - lastThemeChangeTimeRef.current < 1200;

    // When changing themes or on initial measurement, snap strictly to minimal possible size
    const targetWidth = (isRecentThemeChange || !settings.widgetSize?.width)
      ? minContentWidth
      : Math.max(settings.widgetSize.width, minContentWidth);

    const targetHeight = expandedRef.current
      ? 215
      : ((isRecentThemeChange || !settings.widgetSize?.height)
          ? defaultCollapsedHeight
          : Math.max(settings.widgetSize.height, defaultCollapsedHeight));

    window.winatmo.resizeWidget(targetWidth, targetHeight);
  };

  useEffect(() => {
    if (!settings || resizeRef.current.resizing) return;

    // Apply active theme to document root
    applyThemeToDocument(settings.theme);

    // Initial immediate measurement frame
    const rafId = requestAnimationFrame(() => {
      measureAndResize();
    });

    // Font ready measurement
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        measureAndResize();
      });
    }

    // Follow-up timers to ensure CSS variables and font reflow are fully rendered
    if (measureTimerRef.current) {
      clearTimeout(measureTimerRef.current);
    }
    measureTimerRef.current = setTimeout(() => {
      measureAndResize();
    }, 60);

    const timer2 = setTimeout(() => {
      measureAndResize();
    }, 150);

    return () => {
      cancelAnimationFrame(rafId);
      if (measureTimerRef.current) {
        clearTimeout(measureTimerRef.current);
      }
      clearTimeout(timer2);
    };
  }, [
    settings?.theme,
    pinnedIdsKey,
    activePins.length,
    stations,
    settings?.temperatureUnit,
    settings?.pressureUnit,
    settings?.windUnit,
    settings?.rainUnit,
  ]);

  // Load 24h mini-sparklines when expanded
  useEffect(() => {
    if (!expanded || activePins.length === 0 || !settings) return;
    const now = Math.floor(Date.now() / 1000);
    window.winatmo
      .queryMeasureSeries({
        items: activePins.map((p) => ({
          stationId: p.stationId,
          moduleId: p.moduleId,
          moduleName: p.moduleName,
          stationName: p.stationName,
          metric: p.metric,
        })),
        scale: '30min',
        dateBegin: now - 86400,
        dateEnd: now,
      })
      .then((res: MeasureSeries[]) => {
        const nextMap: Record<string, number[]> = {};
        for (const s of res) {
          const key = `${s.stationId}::${s.moduleId}::${s.metric}`;
          nextMap[key] = s.points.map((pt) =>
            convertMetricValue(pt.value, s.metric, settings)
          );
        }
        setSparklines(nextMap);
      })
      .catch(() => {});
  }, [expanded, activePins, stations, settings]);

  const toggleExpand = async () => {
    const next = !expanded;
    try {
      const dir = await window.winatmo.setWidgetExpanded(next);
      setExpandDirection(dir);
      setExpanded(next);
    } catch {
      setExpanded(next);
    }
  };

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRefreshing(true);
    try {
      await window.winatmo.refreshStations();
    } finally {
      setRefreshing(false);
    }
  };

  const onMouseDownResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = {
      resizing: true,
      startX: e.screenX,
      startY: e.screenY,
      startW: window.innerWidth,
      startH: window.innerHeight,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current.resizing) return;
      const nextW = Math.max(
        200,
        resizeRef.current.startW + (e.screenX - resizeRef.current.startX)
      );
      const nextH = Math.max(
        44,
        resizeRef.current.startH + (e.screenY - resizeRef.current.startY)
      );
      window.winatmo.resizeWidget(nextW, nextH);
    };
    const onUp = () => {
      resizeRef.current.resizing = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!settings) return null;

  const themeDef = applyThemeToDocument(settings.theme);
  const bgAlpha = Math.max(0.25, Math.min(1, settings.widgetOpacity ?? 0.94));
  const stripBg = `rgba(${themeDef.widgetBgRgb}, ${bgAlpha})`;
  const dragClass = settings.widgetLocked ? '' : 'widget-os-drag';

  return (
    <div
      className={`taskbar-widget-shell ${expanded ? 'is-expanded' : ''} ${
        expandDirection === 'down' ? 'expand-down' : 'expand-up'
      }`}
    >
      {/* Expanded Flyout Panel (24h Mini Sparklines & Details) */}
      {expanded && (
        <div
          className="widget-flyout-panel"
          style={{ backgroundColor: stripBg }}
        >
          <div className={`widget-flyout-header ${dragClass}`}>
            <span className="flyout-brand">winAtmo Live Sensors (24h)</span>
            <div className="flyout-actions widget-no-drag">
              <button
                className="widget-icon-btn"
                onClick={handleRefresh}
                title="Refresh live readings"
              >
                <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
              </button>
              <button
                className="widget-icon-btn"
                onClick={() => window.winatmo.openMainWindow()}
                title="Open winAtmo Studio"
              >
                <ExternalLink size={12} />
              </button>
            </div>
          </div>

          <div className="widget-flyout-grid widget-no-drag">
            {activePins.map((pin) => {
              const st = stations.find((s) => s.id === pin.stationId);
              const mod = st?.modules.find((m) => m.id === pin.moduleId);
              const d = mod?.dashboard;
              const val = extractLiveMetricValue(d, pin.metric);
              const spark = sparklines[pin.id] || [];
              const color =
                pin.color ||
                METRIC_METADATA[pin.metric]?.defaultColor ||
                '#38bdf8';

              return (
                <div
                  key={pin.id}
                  className="flyout-sensor-card"
                  onClick={() =>
                    window.winatmo.openMainWindow(pin.moduleId, pin.metric)
                  }
                >
                  <div className="flyout-card-top">
                    <span className="flyout-mod-name">{pin.moduleName}</span>
                    <span className="flyout-metric-tag">
                      {METRIC_METADATA[pin.metric]?.shortLabel}
                    </span>
                  </div>
                  <div className="flyout-val-row">
                    <strong style={{ color }}>
                      {formatMetricValue(val, pin.metric, settings)}
                    </strong>
                  </div>
                  {spark.length > 2 && (
                    <svg viewBox="0 0 110 28" className="mini-sparkline-svg">
                      <path
                        d={buildMiniSparkPath(spark, 110, 28)}
                        fill="none"
                        stroke={color}
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Compact Taskbar Bar */}
      <div
        className={`taskbar-strip ${dragClass}`}
        style={{ backgroundColor: stripBg }}
      >
        <div
          className="widget-drag-handle"
          title={
            settings.widgetLocked
              ? 'Taskbar Widget Locked'
              : 'Drag to reposition widget'
          }
        >
          <GripVertical size={13} />
        </div>

        <div className="widget-sensors-strip" ref={sensorsStripRef}>
          {activePins.length === 0 ? (
            <div
              className="widget-empty-item widget-no-drag"
              onClick={() => window.winatmo.openMainWindow()}
            >
              <span>winAtmo • Click to connect sensors</span>
            </div>
          ) : (
            activePins.map((pin) => {
              const st = stations.find((s) => s.id === pin.stationId);
              const mod = st?.modules.find((m) => m.id === pin.moduleId);
              const d = mod?.dashboard;
              const liveVal = extractLiveMetricValue(d, pin.metric);
              const sparkKey = `${pin.stationId}::${pin.moduleId}::${pin.metric}`;
              const spark = sparklines[sparkKey];
              const color =
                pin.color ||
                METRIC_METADATA[pin.metric]?.defaultColor ||
                '#38bdf8';

              const co2DotColor =
                pin.metric === 'co2' && d?.CO2 !== undefined
                  ? getCo2QualityBadge(d.CO2).color
                  : color;

              return (
                <div
                  key={pin.id}
                  className="widget-sensor-pill widget-no-drag"
                  onClick={() =>
                    window.winatmo.openMainWindow(pin.moduleId, pin.metric)
                  }
                  title={`${pin.moduleName} (${METRIC_METADATA[pin.metric]?.label}) — Click to open chart`}
                >
                  {renderWidgetTrendArrow(pin.metric, d, spark, co2DotColor)}
                  <span className="widget-mod-short">
                    {pin.customLabel || truncateLabel(pin.moduleName, 10)}
                  </span>
                  <strong className="widget-val-text">
                    {formatMetricValue(liveVal, pin.metric, settings)}
                  </strong>
                </div>
              );
            })
          )}
        </div>

        <div className="widget-strip-controls widget-no-drag">
          <button
            className="widget-toggle-btn"
            onClick={toggleExpand}
            title={expanded ? 'Collapse flyout' : 'Expand 24h mini charts'}
          >
            {expandDirection === 'down' ? (
              expanded ? (
                <ChevronUp size={13} />
              ) : (
                <ChevronDown size={13} />
              )
            ) : expanded ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronUp size={13} />
            )}
          </button>
        </div>

        {/* Corner Resize Grip */}
        <div
          className="widget-resize-grip widget-no-drag"
          onMouseDown={onMouseDownResize}
          title="Drag corner to resize widget"
        />
      </div>
    </div>
  );
};

function truncateLabel(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function buildMiniSparkPath(vals: number[], w: number, h: number): string {
  if (vals.length === 0) return '';
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(0.01, max - min);
  return vals
    .map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * (w - 4) + 2;
      const y = h - 3 - ((v - min) / span) * (h - 6);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function resolveSensorTrend(
  metric: MetricType,
  d?: DashboardReadings,
  spark?: number[]
): 'up' | 'down' | 'stable' {
  if (metric === 'temperature' && d?.temp_trend) {
    return d.temp_trend;
  }
  if (metric === 'pressure' && d?.pressure_trend) {
    return d.pressure_trend;
  }
  if (spark && spark.length >= 2) {
    const first = spark[0];
    const last = spark[spark.length - 1];
    const diff = last - first;
    const threshold = Math.max(0.01, Math.abs(first) * 0.02);
    if (diff > threshold) return 'up';
    if (diff < -threshold) return 'down';
    return 'stable';
  }
  return 'stable';
}

function renderWidgetTrendArrow(
  metric: MetricType,
  d?: DashboardReadings,
  spark?: number[],
  color?: string
) {
  const trend = resolveSensorTrend(metric, d, spark);
  const trendLabel =
    trend === 'up' ? 'Rising' : trend === 'down' ? 'Falling' : 'Stable';

  return (
    <span
      className={`widget-trend-wrapper ${trend}`}
      style={{ color }}
      title={`Trend: ${trendLabel}`}
    >
      {trend === 'up' && <ArrowUpRight size={12} strokeWidth={2.2} />}
      {trend === 'down' && <ArrowDownRight size={12} strokeWidth={2.2} />}
      {trend === 'stable' && <ArrowRight size={12} strokeWidth={2.2} />}
    </span>
  );
}
