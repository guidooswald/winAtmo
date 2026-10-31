import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Calendar,
  Cloud,
  Database,
  Download,
  Layers,
  LineChart,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  Sliders,
  Sparkles,
  TrendingUp,
  X,
  ZoomOut,
} from 'lucide-react';
import {
  MeasurePoint,
  MeasureSeries,
  MetricType,
  NetatmoScale,
  UserSettings,
  WeatherStation,
} from '../types';
import {
  convertMetricValue,
  formatMetricValue,
  getMetricUnit,
  METRIC_METADATA,
  SERIES_PALETTE,
} from '../utils/metrics';

export interface SelectedCurve {
  id: string; // `${stationId}::${moduleId}::${metric}`
  stationId: string;
  stationName: string;
  moduleId: string;
  moduleName: string;
  metric: MetricType;
  color: string;
}

interface ChartStudioProps {
  stations: WeatherStation[];
  settings: UserSettings;
  initialFocus?: { moduleId: string; metric?: string } | null;
  onClearFocus?: () => void;
}

type ChartLayoutMode = 'overlay' | 'stacked';
type ChartCurveStyle = 'area' | 'line' | 'bar' | 'step';
type RangePreset = '24h' | '3d' | '7d' | '14d' | '30d' | '90d' | '1y' | 'max' | 'custom';

function getOptimalScale(
  preset: RangePreset,
  sDate?: string,
  eDate?: string
): NetatmoScale {
  if (preset === '24h') {
    return 'max';
  }
  if (preset === '3d' || preset === '7d' || preset === '14d') {
    return '30min';
  }
  if (preset === '30d') {
    return '1hour';
  }
  if (preset === '90d') {
    return '3hours';
  }
  if (preset === '1y' || preset === 'max') {
    return '1day';
  }
  if (preset === 'custom' && sDate && eDate) {
    const s = Math.floor(new Date(sDate + 'T00:00:00').getTime() / 1000);
    const e = Math.floor(new Date(eDate + 'T23:59:59').getTime() / 1000);
    if (!Number.isNaN(s) && !Number.isNaN(e) && s < e) {
      const spanDays = (e - s) / 86400;
      if (spanDays <= 1.2) return 'max';
      if (spanDays <= 21) return '30min';
      if (spanDays <= 60) return '1hour';
      if (spanDays <= 180) return '3hours';
      return '1day';
    }
  }
  return '30min';
}

export const ChartStudio: React.FC<ChartStudioProps> = ({
  stations,
  settings,
  initialFocus,
  onClearFocus,
}) => {
  const [selectedCurves, setSelectedCurves] = useState<SelectedCurve[]>([]);
  const [rangePreset, setRangePreset] = useState<RangePreset>('7d');
  const [currentScale, setCurrentScale] = useState<NetatmoScale>(() =>
    getOptimalScale('7d')
  );
  const [layoutMode, setLayoutMode] = useState<ChartLayoutMode>('overlay');
  const [curveStyle, setCurveStyle] = useState<ChartCurveStyle>('area');
  const [smoothMovingAvg, setSmoothMovingAvg] = useState<boolean>(false);
  const [showAvgLines, setShowAvgLines] = useState<boolean>(true);
  const [showExtremaMarkers, setShowExtremaMarkers] = useState<boolean>(true);

  const [customStartDate, setCustomStartDate] = useState<string>(() => {
    const d = new Date(Date.now() - 14 * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [customEndDate, setCustomEndDate] = useState<string>(() => {
    return new Date().toISOString().slice(0, 10);
  });

  const [seriesData, setSeriesData] = useState<MeasureSeries[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingElapsed, setLoadingElapsed] = useState<number>(0);
  const [querySource, setQuerySource] = useState<'local_database' | 'netatmo_api' | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const querySeqRef = useRef<number>(0);

  // Listen for real-time query source notifications from the backend
  useEffect(() => {
    const unsub = window.winatmo.onMeasureQueryStatus?.((status) => {
      setQuerySource(status.source);
    });
    return () => unsub?.();
  }, []);

  // Track elapsed loading time to provide smart feedback on long-running queries
  useEffect(() => {
    if (!loading) {
      setLoadingElapsed(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setLoadingElapsed(Date.now() - start);
    }, 100);
    return () => clearInterval(timer);
  }, [loading]);

  // Interactive zoom window [0..1, 0..1]
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);
  const [dragSelect, setDragSelect] = useState<{
    startX: number;
    currentX: number;
  } | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  // Dynamically build Quick Presets based on available sensors across all stations
  const availablePresets = useMemo(() => {
    const allItems: Array<{
      st: WeatherStation;
      mod: WeatherStation['modules'][number];
    }> = [];
    for (const st of stations) {
      for (const mod of st.modules) {
        allItems.push({ st, mod });
      }
    }

    const hasWind = allItems.some((x) =>
      x.mod.availableMetrics.includes('windstrength')
    );
    const hasRain = allItems.some((x) =>
      x.mod.availableMetrics.includes('rain')
    );
    const hasOutdoor = allItems.some((x) => x.mod.type === 'NAModule1');

    const indoorTempMods = allItems.filter(
      (x) =>
        x.mod.type !== 'NAModule1' &&
        x.mod.availableMetrics.includes('temperature')
    );
    const co2Mods = allItems.filter((x) =>
      x.mod.availableMetrics.includes('co2')
    );
    const humidityMods = allItems.filter((x) =>
      x.mod.availableMetrics.includes('humidity')
    );
    const noiseMods = allItems.filter((x) =>
      x.mod.availableMetrics.includes('noise')
    );
    const pressureMods = allItems.filter((x) =>
      x.mod.availableMetrics.includes('pressure')
    );

    const presets: Array<{
      id: string;
      label: string;
      title: string;
      layout: ChartLayoutMode;
      style: ChartCurveStyle;
      curves: Array<{ st: WeatherStation; modId: string; metric: MetricType }>;
    }> = [];

    // 1. All Temperatures (Indoor + Outdoor)
    const allTempCurves = allItems
      .filter((x) => x.mod.availableMetrics.includes('temperature'))
      .map((x) => ({
        st: x.st,
        modId: x.mod.id,
        metric: 'temperature' as MetricType,
      }));
    if (allTempCurves.length > 0) {
      presets.push({
        id: 'all-temps',
        label: 'All Temperatures',
        title: 'Compare temperature across all indoor and outdoor sensors',
        layout: 'overlay',
        style: 'area',
        curves: allTempCurves,
      });
    }

    // 2. Indoor Temperatures (only when both outdoor and multiple indoor sensors exist, so outdoor cold doesn't compress room comparisons)
    if (hasOutdoor && indoorTempMods.length >= 2) {
      presets.push({
        id: 'indoor-temps',
        label: 'Indoor Temps',
        title: 'Compare room temperatures without outdoor extremes compressing the scale',
        layout: 'overlay',
        style: 'line',
        curves: indoorTempMods.map((x) => ({
          st: x.st,
          modId: x.mod.id,
          metric: 'temperature' as MetricType,
        })),
      });
    }

    // 3. CO2 Across All Rooms
    if (co2Mods.length >= 2) {
      presets.push({
        id: 'co2-rooms',
        label: 'CO₂ All Rooms',
        title: 'Compare indoor CO₂ air quality levels across all rooms',
        layout: 'overlay',
        style: 'line',
        curves: co2Mods.map((x) => ({
          st: x.st,
          modId: x.mod.id,
          metric: 'co2' as MetricType,
        })),
      });
    }

    // 4. Humidity Across All Sensors
    if (humidityMods.length >= 2) {
      presets.push({
        id: 'humidity-all',
        label: 'Humidity All Rooms',
        title: 'Compare relative humidity across all sensors',
        layout: 'overlay',
        style: 'line',
        curves: humidityMods.map((x) => ({
          st: x.st,
          modId: x.mod.id,
          metric: 'humidity' as MetricType,
        })),
      });
    }

    // 5. Weather / Rain (only if Rain sensor is present; otherwise Outdoor Temp & Barometric Pressure if available)
    if (hasRain) {
      const outdoor = allItems.find((x) => x.mod.type === 'NAModule1');
      const mainMod = pressureMods[0];
      const rainMod = allItems.find((x) =>
        x.mod.availableMetrics.includes('rain')
      );
      const c: Array<{
        st: WeatherStation;
        modId: string;
        metric: MetricType;
      }> = [];
      if (outdoor)
        c.push({
          st: outdoor.st,
          modId: outdoor.mod.id,
          metric: 'temperature',
        });
      if (mainMod)
        c.push({
          st: mainMod.st,
          modId: mainMod.mod.id,
          metric: 'pressure',
        });
      if (rainMod)
        c.push({ st: rainMod.st, modId: rainMod.mod.id, metric: 'rain' });
      if (c.length > 0) {
        presets.push({
          id: 'weather-rain',
          label: 'Temp + Pressure + Rain',
          title: 'Outdoor temperature, barometric pressure, and rainfall',
          layout: 'stacked',
          style: 'area',
          curves: c,
        });
      }
    } else if (hasOutdoor && pressureMods.length > 0) {
      const outdoor = allItems.find((x) => x.mod.type === 'NAModule1')!;
      const baro = pressureMods[0];
      presets.push({
        id: 'outdoor-baro',
        label: 'Outdoor & Pressure',
        title: 'Outdoor temperature vs. barometric pressure (dual Y-axis)',
        layout: 'overlay',
        style: 'area',
        curves: [
          { st: outdoor.st, modId: outdoor.mod.id, metric: 'temperature' },
          { st: baro.st, modId: baro.mod.id, metric: 'pressure' },
        ],
      });
    }

    // 6. Wind & Gusts (only if Wind gauge is present; otherwise Acoustic Noise across rooms if multiple noise sensors exist)
    if (hasWind) {
      const windMod = allItems.find((x) =>
        x.mod.availableMetrics.includes('windstrength')
      )!;
      const c: Array<{
        st: WeatherStation;
        modId: string;
        metric: MetricType;
      }> = [
        { st: windMod.st, modId: windMod.mod.id, metric: 'windstrength' },
      ];
      if (windMod.mod.availableMetrics.includes('guststrength')) {
        c.push({
          st: windMod.st,
          modId: windMod.mod.id,
          metric: 'guststrength',
        });
      }
      presets.push({
        id: 'wind',
        label: 'Wind & Gusts',
        title: 'Wind speed and gust strength',
        layout: 'overlay',
        style: 'line',
        curves: c,
      });
    } else if (noiseMods.length >= 2) {
      presets.push({
        id: 'noise-rooms',
        label: 'Noise All Rooms',
        title: 'Compare acoustic noise levels (dB) across all rooms',
        layout: 'overlay',
        style: 'area',
        curves: noiseMods.map((x) => ({
          st: x.st,
          modId: x.mod.id,
          metric: 'noise' as MetricType,
        })),
      });
    }

    // 7. Single-room Indoor Air Quality overview (CO2 + Temp + Humidity for primary indoor station)
    const mainIndoor =
      allItems.find(
        (x) => x.mod.type === 'NAMain' || x.mod.type === 'NHC'
      ) || allItems[0];
    if (mainIndoor && mainIndoor.mod.availableMetrics.includes('co2')) {
      const c: Array<{
        st: WeatherStation;
        modId: string;
        metric: MetricType;
      }> = [
        { st: mainIndoor.st, modId: mainIndoor.mod.id, metric: 'co2' },
      ];
      if (mainIndoor.mod.availableMetrics.includes('temperature')) {
        c.push({
          st: mainIndoor.st,
          modId: mainIndoor.mod.id,
          metric: 'temperature',
        });
      }
      if (mainIndoor.mod.availableMetrics.includes('humidity')) {
        c.push({
          st: mainIndoor.st,
          modId: mainIndoor.mod.id,
          metric: 'humidity',
        });
      }
      presets.push({
        id: 'iaq-main',
        label: `${mainIndoor.mod.moduleName} IAQ`,
        title: `CO₂, Temperature & Humidity in ${mainIndoor.mod.moduleName}`,
        layout: 'stacked',
        style: 'area',
        curves: c,
      });
    }

    return presets;
  }, [stations]);

  // Populate initial default curves when stations load
  useEffect(() => {
    if (stations.length === 0) return;

    if (initialFocus) {
      for (const st of stations) {
        const mod = st.modules.find((m) => m.id === initialFocus.moduleId);
        if (mod) {
          const metric = (initialFocus.metric as MetricType) || mod.availableMetrics[0] || 'temperature';
          const id = `${st.id}::${mod.id}::${metric}`;
          setActivePreset(null);
          setSelectedCurves([
            {
              id,
              stationId: st.id,
              stationName: st.stationName,
              moduleId: mod.id,
              moduleName: mod.moduleName,
              metric,
              color: SERIES_PALETTE[0],
            },
          ]);
          onClearFocus?.();
          return;
        }
      }
    }

    if (selectedCurves.length === 0 && availablePresets.length > 0) {
      applyPresetComparison(availablePresets[0].id);
    }
  }, [stations, initialFocus, availablePresets]);

  const applyPresetComparison = (presetId: string) => {
    const preset = availablePresets.find((p) => p.id === presetId);
    if (!preset) return;

    const next: SelectedCurve[] = [];
    for (const item of preset.curves) {
      const mod = item.st.modules.find((m) => m.id === item.modId);
      if (!mod || !mod.availableMetrics.includes(item.metric)) continue;
      const id = `${item.st.id}::${mod.id}::${item.metric}`;
      if (next.some((c) => c.id === id)) continue;
      next.push({
        id,
        stationId: item.st.id,
        stationName: item.st.stationName,
        moduleId: mod.id,
        moduleName: mod.moduleName,
        metric: item.metric,
        color: SERIES_PALETTE[next.length % SERIES_PALETTE.length],
      });
    }

    setLayoutMode(preset.layout);
    setCurveStyle(preset.style);
    if (next.length > 0) {
      setActivePreset(preset.id);
      setSelectedCurves(next);
      setZoomRange(null);
    }
  };

  // Compute time window [dateBegin, dateEnd] and effective scale
  const { dateBegin, dateEnd, effectiveScale } = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    let begin = now - 14 * 86400;
    let end = now;

    if (rangePreset === '24h') begin = now - 86400;
    else if (rangePreset === '3d') begin = now - 3 * 86400;
    else if (rangePreset === '7d') begin = now - 7 * 86400;
    else if (rangePreset === '14d') begin = now - 14 * 86400;
    else if (rangePreset === '30d') begin = now - 30 * 86400;
    else if (rangePreset === '90d') begin = now - 90 * 86400;
    else if (rangePreset === '1y') begin = now - 365 * 86400;
    else if (rangePreset === 'max') {
      const earliestSetup = stations.reduce((min, s) => {
        return s.dateSetup && s.dateSetup < min ? s.dateSetup : min;
      }, now - 365 * 86400);
      begin = earliestSetup;
    } else if (rangePreset === 'custom') {
      const s = Math.floor(new Date(customStartDate + 'T00:00:00').getTime() / 1000);
      const e = Math.floor(new Date(customEndDate + 'T23:59:59').getTime() / 1000);
      if (!Number.isNaN(s) && !Number.isNaN(e) && s < e) {
        begin = s;
        end = Math.min(now, e);
      }
    }

    return {
      dateBegin: begin,
      dateEnd: end,
      effectiveScale: currentScale,
    };
  }, [rangePreset, customStartDate, customEndDate, currentScale, stations]);

  const handleRangePresetChange = (nextPreset: RangePreset) => {
    setRangePreset(nextPreset);
    setCurrentScale(getOptimalScale(nextPreset, customStartDate, customEndDate));
  };

  const handleCustomStartDateChange = (val: string) => {
    setCustomStartDate(val);
    setCurrentScale(getOptimalScale('custom', val, customEndDate));
  };

  const handleCustomEndDateChange = (val: string) => {
    setCustomEndDate(val);
    setCurrentScale(getOptimalScale('custom', customStartDate, val));
  };

  const formatScaleName = (scale: NetatmoScale): string => {
    switch (scale) {
      case 'max':
        return '5m (Max)';
      case '30min':
        return '30m';
      case '1hour':
        return '1h';
      case '3hours':
        return '3h';
      case '1day':
        return '1d';
      default:
        return scale;
    }
  };

  // Fetch series from SQLite / Netatmo whenever curves, range, or scale change
  const loadChartData = async (forceRemoteFetch = false) => {
    if (selectedCurves.length === 0) {
      setSeriesData([]);
      return;
    }
    const seq = ++querySeqRef.current;
    setLoading(true);
    setQuerySource(forceRemoteFetch ? 'netatmo_api' : null);
    const startTime = Date.now();
    try {
      const res = await window.winatmo.queryMeasureSeries({
        items: selectedCurves.map((c) => ({
          stationId: c.stationId,
          moduleId: c.moduleId,
          moduleName: c.moduleName,
          stationName: c.stationName,
          metric: c.metric,
        })),
        scale: effectiveScale,
        dateBegin,
        dateEnd,
        forceRemoteFetch,
      });
      if (seq === querySeqRef.current) {
        if (res.length > 0 && res[0].source) {
          setQuerySource(res[0].source);
        }
        // Ensure the loading dialog stays visible for a minimum of 550ms so user
        // can clearly see and read whether the query hit the local database or Netatmo API
        const elapsed = Date.now() - startTime;
        const minDisplayTime = 550;
        if (elapsed < minDisplayTime) {
          await new Promise((r) => setTimeout(r, minDisplayTime - elapsed));
        }
        if (seq === querySeqRef.current) {
          setSeriesData(res);
        }
      }
    } catch (err) {
      if (seq === querySeqRef.current) {
        console.error('[ChartStudio] Failed to load series:', err);
      }
    } finally {
      if (seq === querySeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    loadChartData(false);
    setZoomRange(null);
  }, [selectedCurves, dateBegin, dateEnd, effectiveScale]);

  const toggleCurveSelection = (
    st: WeatherStation,
    modId: string,
    modName: string,
    metric: MetricType
  ) => {
    setActivePreset(null);
    const id = `${st.id}::${modId}::${metric}`;
    const exists = selectedCurves.find((c) => c.id === id);
    if (exists) {
      setSelectedCurves(selectedCurves.filter((c) => c.id !== id));
    } else {
      if (selectedCurves.length >= 10) return; // Cap at 10 curves for readability
      const usedColors = new Set(selectedCurves.map((c) => c.color));
      const nextColor =
        SERIES_PALETTE.find((col) => !usedColors.has(col)) ||
        SERIES_PALETTE[selectedCurves.length % SERIES_PALETTE.length];
      setSelectedCurves([
        ...selectedCurves,
        {
          id,
          stationId: st.id,
          stationName: st.stationName,
          moduleId: modId,
          moduleName: modName,
          metric,
          color: nextColor,
        },
      ]);
    }
  };

  // Transform points with user unit conversions, zoom window, and optional moving-average smoothing
  const processedSeries = useMemo(() => {
    const span = dateEnd - dateBegin;
    const zStart = zoomRange
      ? dateBegin + span * zoomRange[0]
      : dateBegin;
    const zEnd = zoomRange ? dateBegin + span * zoomRange[1] : dateEnd;

    return selectedCurves.map((curve) => {
      const rawSeries = seriesData.find(
        (s) => s.moduleId === curve.moduleId && s.metric === curve.metric
      );
      const rawPoints = rawSeries?.points || [];
      const filtered = rawPoints
        .filter((p) => p.ts >= zStart && p.ts <= zEnd)
        .map((p) => ({
          ts: p.ts,
          value: convertMetricValue(p.value, curve.metric, settings),
        }));

      let displayPoints: MeasurePoint[] = filtered;
      if (smoothMovingAvg && filtered.length >= 5) {
        const windowSize = 5;
        displayPoints = filtered.map((pt, idx) => {
          const startIdx = Math.max(0, idx - Math.floor(windowSize / 2));
          const endIdx = Math.min(
            filtered.length - 1,
            idx + Math.floor(windowSize / 2)
          );
          let sum = 0;
          let count = 0;
          for (let k = startIdx; k <= endIdx; k++) {
            sum += filtered[k].value;
            count++;
          }
          return {
            ts: pt.ts,
            value: Number((sum / count).toFixed(2)),
          };
        });
      }

      // Compute stats in converted units
      let min = Infinity;
      let max = -Infinity;
      let minTs = 0;
      let maxTs = 0;
      let sum = 0;
      for (const p of displayPoints) {
        if (p.value < min) {
          min = p.value;
          minTs = p.ts;
        }
        if (p.value > max) {
          max = p.value;
          maxTs = p.ts;
        }
        sum += p.value;
      }
      const count = displayPoints.length;
      const first = count > 0 ? displayPoints[0].value : 0;
      const latest = count > 0 ? displayPoints[count - 1].value : 0;
      const avg = count > 0 ? Number((sum / count).toFixed(2)) : 0;

      return {
        curve,
        unit: getMetricUnit(curve.metric, settings),
        points: displayPoints,
        stats: {
          min: count > 0 ? min : 0,
          max: count > 0 ? max : 0,
          minTs,
          maxTs,
          avg,
          latest,
          delta: Number((latest - first).toFixed(2)),
          count,
        },
      };
    });
  }, [
    selectedCurves,
    seriesData,
    settings,
    dateBegin,
    dateEnd,
    zoomRange,
    smoothMovingAvg,
  ]);

  const handleExportCsv = async () => {
    const res = await window.winatmo.exportCsv(
      seriesData,
      `winAtmo-${rangePreset}-${effectiveScale}.csv`
    );
    if (res.success && res.filePath) {
      setExportStatus(`Saved CSV`);
      setTimeout(() => setExportStatus(null), 3500);
    }
  };

  // Determine visible timestamp bounds
  const visibleTimeBounds = useMemo(() => {
    const span = dateEnd - dateBegin;
    const minT = zoomRange ? dateBegin + span * zoomRange[0] : dateBegin;
    const maxT = zoomRange ? dateBegin + span * zoomRange[1] : dateEnd;
    return { minT, maxT: Math.max(minT + 60, maxT) };
  }, [dateBegin, dateEnd, zoomRange]);

  // Distinct metric units for Dual-Axis or Normalized Overlay
  const distinctMetrics = useMemo(() => {
    const arr: MetricType[] = [];
    for (const s of processedSeries) {
      if (!arr.includes(s.curve.metric)) {
        arr.push(s.curve.metric);
      }
    }
    return arr;
  }, [processedSeries]);

  // Compute axis domains per metric group
  const metricDomains = useMemo(() => {
    const map = new Map<MetricType, { min: number; max: number }>();
    for (const m of distinctMetrics) {
      let min = Infinity;
      let max = -Infinity;
      for (const s of processedSeries) {
        if (s.curve.metric !== m) continue;
        for (const p of s.points) {
          if (p.value < min) min = p.value;
          if (p.value > max) max = p.value;
        }
      }
      if (min === Infinity) {
        min = 0;
        max = 100;
      } else if (min === max) {
        min -= 1;
        max += 1;
      } else {
        const pad = (max - min) * 0.1;
        min = m === 'rain' || m === 'sum_rain' ? 0 : min - pad;
        max = max + pad;
      }
      map.set(m, { min, max });
    }
    return map;
  }, [distinctMetrics, processedSeries]);

  // SVG dimensions
  const svgWidth = 980;
  const svgHeight = layoutMode === 'stacked' ? Math.max(380, processedSeries.length * 165) : 410;
  const padLeft = 64;
  const padRight = distinctMetrics.length >= 2 && layoutMode === 'overlay' ? 68 : 28;
  const padTop = 24;
  const padBottom = 38;
  const plotWidth = svgWidth - padLeft - padRight;
  const plotHeight = svgHeight - padTop - padBottom;

  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * svgWidth;
    const clampedX = Math.max(padLeft, Math.min(padLeft + plotWidth, relX));
    const ratio = (clampedX - padLeft) / plotWidth;
    setHoverRatio(ratio);

    if (dragSelect) {
      setDragSelect({ ...dragSelect, currentX: ratio });
    }
  };

  const handleSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0 || hoverRatio === null) return;
    setDragSelect({ startX: hoverRatio, currentX: hoverRatio });
  };

  const handleSvgMouseUp = () => {
    if (dragSelect) {
      const r1 = Math.min(dragSelect.startX, dragSelect.currentX);
      const r2 = Math.max(dragSelect.startX, dragSelect.currentX);
      if (r2 - r1 > 0.02) {
        const curStart = zoomRange ? zoomRange[0] : 0;
        const curSpan = zoomRange ? zoomRange[1] - zoomRange[0] : 1;
        setZoomRange([curStart + curSpan * r1, curStart + curSpan * r2]);
      }
      setDragSelect(null);
    }
  };

  const hoveredTimestamp =
    hoverRatio !== null
      ? Math.round(
          visibleTimeBounds.minT +
            (visibleTimeBounds.maxT - visibleTimeBounds.minT) * hoverRatio
        )
      : null;

  const findNearestPoint = (
    points: MeasurePoint[],
    targetTs: number
  ): MeasurePoint | null => {
    if (points.length === 0) return null;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].ts < targetTs) lo = mid + 1;
      else hi = mid;
    }
    const candidate1 = points[lo];
    const candidate2 = lo > 0 ? points[lo - 1] : candidate1;
    return Math.abs(candidate1.ts - targetTs) <
      Math.abs(candidate2.ts - targetTs)
      ? candidate1
      : candidate2;
  };

  return (
    <div className="chart-studio-container">
      {/* Top Toolbar: Quick Comparisons, Time Ranges, Resolution, Layout */}
      <div className="chart-toolbar-card">
        <div className="chart-toolbar-row">
          <div className="toolbar-group">
            <span className="toolbar-label">
              <Sparkles size={13} /> Quick Presets
            </span>
            <div className="pill-group">
              {availablePresets.map((preset) => (
                <button
                  key={preset.id}
                  className={`pill-btn ${activePreset === preset.id ? 'active' : ''}`}
                  onClick={() => applyPresetComparison(preset.id)}
                  title={preset.title}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">
              <Calendar size={13} /> Time Range
            </span>
            <div className="pill-group">
              {(
                [
                  ['24h', '24h'],
                  ['3d', '3d'],
                  ['7d', '7d'],
                  ['14d', '14d'],
                  ['30d', '30d'],
                  ['90d', '90d'],
                  ['1y', '1Y'],
                  ['max', 'Max'],
                  ['custom', 'Custom'],
                ] as Array<[RangePreset, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`pill-btn ${rangePreset === key ? 'active' : ''}`}
                  onClick={() => handleRangePresetChange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {rangePreset === 'custom' && (
          <div className="custom-date-row">
            <label>
              From:
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => handleCustomStartDateChange(e.target.value)}
                className="date-input"
              />
            </label>
            <label>
              To:
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => handleCustomEndDateChange(e.target.value)}
                className="date-input"
              />
            </label>
          </div>
        )}

        <div className="chart-toolbar-row secondary">
          <div className="toolbar-group">
            <span className="toolbar-label">
              <Sliders size={13} /> Resolution
            </span>
            <div className="pill-group">
              {(
                [
                  ['max', '5m (Max)'],
                  ['30min', '30m'],
                  ['1hour', '1h'],
                  ['3hours', '3h'],
                  ['1day', '1d'],
                ] as Array<[NetatmoScale, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`pill-btn ${currentScale === key ? 'active' : ''}`}
                  onClick={() => {
                    if (currentScale === key) {
                      loadChartData(false);
                    } else {
                      setCurrentScale(key);
                    }
                  }}
                  title={`Switch to ${label} resolution`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">
              <Layers size={13} /> Mode
            </span>
            <div className="pill-group">
              <button
                className={`pill-btn ${layoutMode === 'overlay' ? 'active' : ''}`}
                onClick={() => setLayoutMode('overlay')}
              >
                Multi-Curve Overlay
              </button>
              <button
                className={`pill-btn ${layoutMode === 'stacked' ? 'active' : ''}`}
                onClick={() => setLayoutMode('stacked')}
              >
                Stacked Panels
              </button>
            </div>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Style</span>
            <div className="pill-group">
              {(
                [
                  ['area', 'Area'],
                  ['line', 'Line'],
                  ['bar', 'Bar'],
                  ['step', 'Step'],
                ] as Array<[ChartCurveStyle, string]>
              ).map(([stKey, stLabel]) => (
                <button
                  key={stKey}
                  className={`pill-btn ${curveStyle === stKey ? 'active' : ''}`}
                  onClick={() => setCurveStyle(stKey)}
                >
                  {stLabel}
                </button>
              ))}
            </div>
          </div>

          <div className="toolbar-group">
            <button
              className={`pill-btn ${smoothMovingAvg ? 'active' : ''}`}
              onClick={() => setSmoothMovingAvg(!smoothMovingAvg)}
              title="Apply 5-point moving average smoothing"
            >
              Smooth
            </button>
            <button
              className={`pill-btn ${showAvgLines ? 'active' : ''}`}
              onClick={() => setShowAvgLines(!showAvgLines)}
              title="Show average dashed line"
            >
              Avg Line
            </button>
            <button
              className={`pill-btn ${showExtremaMarkers ? 'active' : ''}`}
              onClick={() => setShowExtremaMarkers(!showExtremaMarkers)}
              title="Highlight Min & Max points on chart"
            >
              Min/Max Pins
            </button>
          </div>

          <div className="toolbar-actions">
            {zoomRange && (
              <button
                className="action-btn subtle"
                onClick={() => setZoomRange(null)}
              >
                <ZoomOut size={14} /> Reset Zoom
              </button>
            )}
            <button
              className="action-btn subtle"
              onClick={() => loadChartData(true)}
              disabled={loading}
              title="Force fetch range from Netatmo Cloud"
            >
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
              {loading ? 'Loading...' : 'Reload Cloud'}
            </button>
            <button
              className="action-btn primary"
              onClick={handleExportCsv}
              disabled={seriesData.length === 0}
            >
              <Download size={14} />
              {exportStatus || 'Export CSV'}
            </button>
          </div>
        </div>
      </div>

      <div className="chart-workspace-grid">
        {/* Left Sidebar: Sensor & Metric Curve Selector */}
        <div className="sensor-selector-panel">
          <div className="selector-header">
            <h4>Sensors & Curves ({selectedCurves.length}/10)</h4>
            <span>Click metrics to plot</span>
          </div>

          <div className="selector-station-list">
            {stations.map((st) => (
              <div key={st.id} className="selector-station-group">
                <div className="selector-station-title">{st.homeName}</div>
                {st.modules.map((mod) => (
                  <div key={mod.id} className="selector-module-item">
                    <div className="selector-module-name">
                      <span>{mod.moduleName}</span>
                      <span className="module-type-tag">
                        {mod.type === 'NAMain'
                          ? 'Indoor'
                          : mod.type === 'NAModule1'
                            ? 'Outdoor'
                            : mod.type === 'NAModule2'
                              ? 'Wind'
                              : mod.type === 'NAModule3'
                                ? 'Rain'
                                : mod.type === 'NAModule4'
                                  ? 'Room'
                                  : 'Coach'}
                      </span>
                    </div>
                    <div className="selector-metric-chips">
                      {mod.availableMetrics.map((metric) => {
                        const curveId = `${st.id}::${mod.id}::${metric}`;
                        const activeCurve = selectedCurves.find(
                          (c) => c.id === curveId
                        );
                        return (
                          <button
                            key={metric}
                            className={`metric-chip ${activeCurve ? 'selected' : ''}`}
                            style={
                              activeCurve
                                ? {
                                    borderColor: activeCurve.color,
                                    backgroundColor: `${activeCurve.color}22`,
                                    color: 'var(--text-primary)',
                                  }
                                : undefined
                            }
                            onClick={() =>
                              toggleCurveSelection(
                                st,
                                mod.id,
                                mod.moduleName,
                                metric
                              )
                            }
                          >
                            {activeCurve && (
                              <span
                                className="chip-dot"
                                style={{ backgroundColor: activeCurve.color }}
                              />
                            )}
                            {METRIC_METADATA[metric]?.shortLabel || metric}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Main Interactive SVG Chart Canvas + Stats */}
        <div className="chart-canvas-column">
          <div className="chart-canvas-card">
            {loading && <div className="chart-loading-bar" />}
            <div className="chart-canvas-header">
              <div className="active-curves-legend">
                {processedSeries.map((s) => (
                  <div
                    key={s.curve.id}
                    className="legend-pill"
                    style={{ borderColor: `${s.curve.color}66` }}
                  >
                    <span
                      className="legend-dot"
                      style={{ backgroundColor: s.curve.color }}
                    />
                    <span className="legend-name">
                      {s.curve.moduleName} •{' '}
                      {METRIC_METADATA[s.curve.metric]?.shortLabel}
                    </span>
                    <strong style={{ color: s.curve.color }}>
                      {s.stats.count > 0
                        ? `${s.stats.latest}${s.unit.startsWith('°') ? s.unit : ' ' + s.unit}`
                        : '--'}
                    </strong>
                    <button
                      className="legend-remove"
                      onClick={() =>
                        setSelectedCurves(
                          selectedCurves.filter((c) => c.id !== s.curve.id)
                        )
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="chart-hint">
                {loading ? (
                  <span className="chart-loading-hint-badge">
                    <RefreshCw size={11} className="spin" />
                    {querySource === 'netatmo_api' ? (
                      <span>
                        <Cloud size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        Netatmo API: Fetching {formatScaleName(effectiveScale)} data...
                      </span>
                    ) : querySource === 'local_database' ? (
                      <span>
                        <Database size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        Local Database: Reading {formatScaleName(effectiveScale)} data...
                      </span>
                    ) : (
                      <span>
                        Querying {formatScaleName(effectiveScale)} data...
                      </span>
                    )}
                    <span className="loading-elapsed">
                      {(loadingElapsed / 1000).toFixed(1)}s
                    </span>
                  </span>
                ) : (
                  'Drag across chart to zoom • Hover to inspect values'
                )}
              </div>
            </div>

            {/* Hover Inspector Readout Bar */}
            <div className="hover-inspector-bar">
              {loading ? (
                <span className="hover-placeholder chart-querying-indicator">
                  {querySource === 'netatmo_api' ? (
                    <>
                      <Cloud size={13} style={{ color: '#38bdf8' }} />
                      <span>
                        <strong>Netatmo API:</strong> Downloading{' '}
                        {rangePreset === 'custom'
                          ? 'custom date'
                          : rangePreset.toUpperCase()}{' '}
                        measurements at {formatScaleName(effectiveScale)} resolution from cloud...
                      </span>
                    </>
                  ) : querySource === 'local_database' ? (
                    <>
                      <Database size={13} style={{ color: '#4ade80' }} />
                      <span>
                        <strong>Local Database:</strong> Reading cached{' '}
                        {rangePreset === 'custom'
                          ? 'custom date'
                          : rangePreset.toUpperCase()}{' '}
                        measurements at {formatScaleName(effectiveScale)} resolution from SQLite...
                      </span>
                    </>
                  ) : (
                    <>
                      <RefreshCw size={12} className="spin" />
                      <span>
                        Querying{' '}
                        {rangePreset === 'custom'
                          ? 'custom date'
                          : rangePreset.toUpperCase()}{' '}
                        measurements ({formatScaleName(effectiveScale)} resolution)...
                      </span>
                    </>
                  )}
                </span>
              ) : hoveredTimestamp ? (
                <>
                  <span className="hover-time">
                    {new Date(hoveredTimestamp * 1000).toLocaleString([], {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <div className="hover-values">
                    {processedSeries.map((s) => {
                      const pt = findNearestPoint(s.points, hoveredTimestamp);
                      return (
                        <span key={s.curve.id} className="hover-val-item">
                          <span
                            className="legend-dot"
                            style={{ backgroundColor: s.curve.color }}
                          />
                          {s.curve.moduleName}:{' '}
                          <strong style={{ color: s.curve.color }}>
                            {pt
                              ? `${pt.value.toFixed(METRIC_METADATA[s.curve.metric]?.decimals ?? 1)}${s.unit.startsWith('°') ? s.unit : ' ' + s.unit}`
                              : '--'}
                          </strong>
                        </span>
                      );
                    })}
                  </div>
                </>
              ) : (
                <span className="hover-placeholder">
                  Showing{' '}
                  {new Date(visibleTimeBounds.minT * 1000).toLocaleDateString()}{' '}
                  –{' '}
                  {new Date(visibleTimeBounds.maxT * 1000).toLocaleDateString()}{' '}
                  ({effectiveScale} intervals)
                </span>
              )}
            </div>

            {/* Interactive SVG Chart */}
            <div className="svg-chart-wrapper">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                className={`interactive-chart-svg ${loading ? 'is-loading' : ''}`}
                onMouseMove={handleSvgMouseMove}
                onMouseLeave={() => {
                  setHoverRatio(null);
                  setDragSelect(null);
                }}
                onMouseDown={handleSvgMouseDown}
                onMouseUp={handleSvgMouseUp}
              >
                <defs>
                  {processedSeries.map((s, idx) => (
                    <linearGradient
                      key={s.curve.id}
                      id={`grad-${idx}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor={s.curve.color}
                        stopOpacity="0.32"
                      />
                      <stop
                        offset="95%"
                        stopColor={s.curve.color}
                        stopOpacity="0.01"
                      />
                    </linearGradient>
                  ))}
                </defs>

                {layoutMode === 'overlay'
                  ? renderOverlayChart({
                      processedSeries,
                      distinctMetrics,
                      metricDomains,
                      visibleTimeBounds,
                      padLeft,
                      padTop,
                      plotWidth,
                      plotHeight,
                      curveStyle,
                      showAvgLines,
                      showExtremaMarkers,
                      settings,
                    })
                  : renderStackedChart({
                      processedSeries,
                      visibleTimeBounds,
                      padLeft,
                      padTop,
                      plotWidth,
                      plotHeight,
                      curveStyle,
                      showAvgLines,
                      showExtremaMarkers,
                    })}

                {/* X-Axis Time Labels */}
                {renderTimeAxis({
                  visibleTimeBounds,
                  padLeft,
                  y: padTop + plotHeight,
                  plotWidth,
                })}

                {/* Drag-to-Zoom Selection Box */}
                {dragSelect && (
                  <rect
                    x={
                      padLeft +
                      Math.min(dragSelect.startX, dragSelect.currentX) *
                        plotWidth
                    }
                    y={padTop}
                    width={
                      Math.abs(dragSelect.currentX - dragSelect.startX) *
                      plotWidth
                    }
                    height={plotHeight}
                    fill="rgba(56, 189, 248, 0.16)"
                    stroke="#38bdf8"
                    strokeDasharray="4 2"
                  />
                )}

                {/* Crosshair Line & Active Dots */}
                {hoverRatio !== null && hoveredTimestamp !== null && (
                  <g className="crosshair-group">
                    <line
                      x1={padLeft + hoverRatio * plotWidth}
                      y1={padTop}
                      x2={padLeft + hoverRatio * plotWidth}
                      y2={padTop + plotHeight}
                      stroke="var(--chart-crosshair)"
                      strokeWidth="1"
                      strokeDasharray="4 4"
                    />
                  </g>
                )}
              </svg>

              {/* Chart Loading Overlay */}
              {loading && (
                <div className="chart-loading-overlay">
                  <div className="chart-loading-box">
                    <div className="chart-loading-source-pill">
                      {querySource === 'netatmo_api' ? (
                        <span className="source-badge api">
                          <Cloud size={13} />
                          <span>Netatmo Cloud API</span>
                        </span>
                      ) : querySource === 'local_database' ? (
                        <span className="source-badge db">
                          <Database size={13} />
                          <span>Local SQLite Database</span>
                        </span>
                      ) : (
                        <span className="source-badge pending">
                          <RefreshCw size={12} className="spin" />
                          <span>Resolving Source...</span>
                        </span>
                      )}
                    </div>

                    <div className="chart-loading-icon-group">
                      <div className="chart-loading-pulse-ring" />
                      <Loader2 size={36} className="chart-loading-spinner spin" />
                      {querySource === 'netatmo_api' ? (
                        <Cloud size={18} className="chart-loading-inner-icon cloud" />
                      ) : querySource === 'local_database' ? (
                        <Database size={17} className="chart-loading-inner-icon db" />
                      ) : (
                        <Activity size={16} className="chart-loading-inner-icon" />
                      )}
                    </div>

                    <div className="chart-loading-text">
                      <div className="chart-loading-title">
                        {querySource === 'netatmo_api'
                          ? 'Fetching from Netatmo API'
                          : querySource === 'local_database'
                            ? 'Reading Local Database'
                            : 'Querying Historical Data...'}
                      </div>
                      <div className="chart-loading-subtitle">
                        {querySource === 'netatmo_api' ? (
                          <>
                            Downloading {selectedCurves.length} curve{selectedCurves.length > 1 ? 's' : ''} at{' '}
                            <strong>{formatScaleName(effectiveScale)}</strong> resolution from Netatmo Cloud
                          </>
                        ) : querySource === 'local_database' ? (
                          <>
                            Reading {selectedCurves.length} curve{selectedCurves.length > 1 ? 's' : ''} at{' '}
                            <strong>{formatScaleName(effectiveScale)}</strong> resolution from local SQLite (0 API calls)
                          </>
                        ) : (
                          <>
                            Loading {selectedCurves.length} curve{selectedCurves.length > 1 ? 's' : ''} (
                            {formatScaleName(effectiveScale)} resolution)...
                          </>
                        )}
                      </div>
                      {loadingElapsed > 800 && (
                        <div className="chart-loading-timer">
                          Elapsed: {(loadingElapsed / 1000).toFixed(1)}s
                        </div>
                      )}
                    </div>

                    <div className="chart-loading-bars">
                      <span className="c-bar b1" />
                      <span className="c-bar b2" />
                      <span className="c-bar b3" />
                      <span className="c-bar b4" />
                      <span className="c-bar b5" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Series Statistics Cards */}
          <div className="series-stats-grid">
            {processedSeries.map((s) => (
              <div
                key={s.curve.id}
                className="series-stat-card"
                style={{ borderTop: `3px solid ${s.curve.color}` }}
              >
                <div className="stat-card-top">
                  <div>
                    <div className="stat-mod-name">{s.curve.moduleName}</div>
                    <div className="stat-metric-name">
                      {METRIC_METADATA[s.curve.metric]?.label} ({s.unit})
                    </div>
                  </div>
                  <div
                    className="stat-latest-badge"
                    style={{ color: s.curve.color }}
                  >
                    {s.stats.count > 0 ? s.stats.latest : '--'}
                    <small>{s.unit}</small>
                  </div>
                </div>
                <div className="stat-metrics-row">
                  <div className="stat-cell">
                    <span>Min</span>
                    <strong>{s.stats.count > 0 ? s.stats.min : '--'}</strong>
                  </div>
                  <div className="stat-cell">
                    <span>Average</span>
                    <strong>{s.stats.count > 0 ? s.stats.avg : '--'}</strong>
                  </div>
                  <div className="stat-cell">
                    <span>Max</span>
                    <strong>{s.stats.count > 0 ? s.stats.max : '--'}</strong>
                  </div>
                  <div className="stat-cell">
                    <span>Delta (Δ)</span>
                    <strong
                      className={
                        s.stats.delta > 0
                          ? 'pos-delta'
                          : s.stats.delta < 0
                            ? 'neg-delta'
                            : ''
                      }
                    >
                      {s.stats.count > 0
                        ? `${s.stats.delta > 0 ? '+' : ''}${s.stats.delta}`
                        : '--'}
                    </strong>
                  </div>
                  <div className="stat-cell">
                    <span>Points</span>
                    <strong>{s.stats.count.toLocaleString()}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

function renderOverlayChart(params: {
  processedSeries: Array<{
    curve: SelectedCurve;
    unit: string;
    points: MeasurePoint[];
    stats: {
      min: number;
      max: number;
      minTs: number;
      maxTs: number;
      avg: number;
      latest: number;
      delta: number;
      count: number;
    };
  }>;
  distinctMetrics: MetricType[];
  metricDomains: Map<MetricType, { min: number; max: number }>;
  visibleTimeBounds: { minT: number; maxT: number };
  padLeft: number;
  padTop: number;
  plotWidth: number;
  plotHeight: number;
  curveStyle: ChartCurveStyle;
  showAvgLines: boolean;
  showExtremaMarkers: boolean;
  settings: UserSettings;
}) {
  const {
    processedSeries,
    distinctMetrics,
    metricDomains,
    visibleTimeBounds,
    padLeft,
    padTop,
    plotWidth,
    plotHeight,
    curveStyle,
    showAvgLines,
    showExtremaMarkers,
    settings,
  } = params;

  const primaryMetric = distinctMetrics[0];
  const secondaryMetric = distinctMetrics[1];
  const primaryDomain = (primaryMetric &&
    metricDomains.get(primaryMetric)) || { min: 0, max: 100 };
  const secondaryDomain =
    secondaryMetric && metricDomains.get(secondaryMetric);

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const timeSpan = Math.max(1, visibleTimeBounds.maxT - visibleTimeBounds.minT);

  return (
    <g>
      {/* Horizontal Grid Lines & Left/Right Y-Axis Labels */}
      {ticks.map((t, idx) => {
        const y = padTop + plotHeight * (1 - t);
        const leftVal =
          primaryDomain.min + (primaryDomain.max - primaryDomain.min) * t;
        const rightVal = secondaryDomain
          ? secondaryDomain.min +
            (secondaryDomain.max - secondaryDomain.min) * t
          : null;

        return (
          <g key={idx}>
            <line
              x1={padLeft}
              y1={y}
              x2={padLeft + plotWidth}
              y2={y}
              stroke="var(--chart-grid)"
              strokeWidth="1"
            />
            {primaryMetric && (
              <text
                x={padLeft - 8}
                y={y + 4}
                textAnchor="end"
                fill="var(--chart-axis)"
                fontSize="11"
              >
                {leftVal.toFixed(
                  METRIC_METADATA[primaryMetric]?.decimals ?? 1
                )}
                {getMetricUnit(primaryMetric, settings)}
              </text>
            )}
            {secondaryMetric && rightVal !== null && (
              <text
                x={padLeft + plotWidth + 8}
                y={y + 4}
                textAnchor="start"
                fill="var(--chart-axis)"
                fontSize="11"
              >
                {rightVal.toFixed(
                  METRIC_METADATA[secondaryMetric]?.decimals ?? 1
                )}{' '}
                {getMetricUnit(secondaryMetric, settings)}
              </text>
            )}
          </g>
        );
      })}

      {/* Curves */}
      {processedSeries.map((s, sIdx) => {
        if (s.points.length === 0) return null;
        const dom = metricDomains.get(s.curve.metric) || { min: 0, max: 100 };
        const valSpan = Math.max(0.0001, dom.max - dom.min);

        const toX = (ts: number) =>
          padLeft + ((ts - visibleTimeBounds.minT) / timeSpan) * plotWidth;
        const toY = (val: number) =>
          padTop + (1 - (val - dom.min) / valSpan) * plotHeight;

        const coords = s.points.map((p) => ({
          x: toX(p.ts),
          y: toY(p.value),
          val: p.value,
          ts: p.ts,
        }));

        const avgY = toY(s.stats.avg);

        return (
          <g key={s.curve.id}>
            {showAvgLines && (
              <line
                x1={padLeft}
                y1={avgY}
                x2={padLeft + plotWidth}
                y2={avgY}
                stroke={s.curve.color}
                strokeOpacity="0.35"
                strokeWidth="1"
                strokeDasharray="5 5"
              />
            )}

            {curveStyle === 'bar' ? (
              coords.map((c, i) => {
                const barW = Math.max(
                  2,
                  Math.min(14, plotWidth / Math.max(20, coords.length) - 1)
                );
                return (
                  <rect
                    key={i}
                    x={c.x - barW / 2}
                    y={c.y}
                    width={barW}
                    height={Math.max(1, padTop + plotHeight - c.y)}
                    fill={s.curve.color}
                    fillOpacity="0.78"
                    rx="1.5"
                  />
                );
              })
            ) : (
              <>
                {curveStyle === 'area' && coords.length > 1 && (
                  <path
                    d={`${buildSvgPath(coords, false)} L ${coords[coords.length - 1].x.toFixed(1)} ${(padTop + plotHeight).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padTop + plotHeight).toFixed(1)} Z`}
                    fill={`url(#grad-${sIdx})`}
                  />
                )}
                <path
                  d={buildSvgPath(coords, curveStyle === 'step')}
                  fill="none"
                  stroke={s.curve.color}
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </>
            )}

            {/* Min / Max Extrema Markers */}
            {showExtremaMarkers && s.stats.count > 2 && (
              <>
                <circle
                  cx={toX(s.stats.maxTs)}
                  cy={toY(s.stats.max)}
                  r="4"
                  fill={s.curve.color}
                  stroke="var(--bg-base)"
                  strokeWidth="1.5"
                />
                <circle
                  cx={toX(s.stats.minTs)}
                  cy={toY(s.stats.min)}
                  r="4"
                  fill={s.curve.color}
                  stroke="var(--bg-base)"
                  strokeWidth="1.5"
                />
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}

function renderStackedChart(params: {
  processedSeries: Array<{
    curve: SelectedCurve;
    unit: string;
    points: MeasurePoint[];
    stats: {
      min: number;
      max: number;
      minTs: number;
      maxTs: number;
      avg: number;
      latest: number;
      delta: number;
      count: number;
    };
  }>;
  visibleTimeBounds: { minT: number; maxT: number };
  padLeft: number;
  padTop: number;
  plotWidth: number;
  plotHeight: number;
  curveStyle: ChartCurveStyle;
  showAvgLines: boolean;
  showExtremaMarkers: boolean;
}) {
  const {
    processedSeries,
    visibleTimeBounds,
    padLeft,
    padTop,
    plotWidth,
    plotHeight,
    curveStyle,
    showAvgLines,
  } = params;

  const count = Math.max(1, processedSeries.length);
  const gap = 18;
  const subHeight = (plotHeight - gap * (count - 1)) / count;
  const timeSpan = Math.max(1, visibleTimeBounds.maxT - visibleTimeBounds.minT);

  return (
    <g>
      {processedSeries.map((s, sIdx) => {
        const subTop = padTop + sIdx * (subHeight + gap);
        const subBottom = subTop + subHeight;

        let min = s.stats.min;
        let max = s.stats.max;
        if (min === max) {
          min -= 1;
          max += 1;
        } else {
          const pad = (max - min) * 0.12;
          min =
            s.curve.metric === 'rain' || s.curve.metric === 'sum_rain'
              ? 0
              : min - pad;
          max += pad;
        }
        const valSpan = Math.max(0.0001, max - min);

        const toX = (ts: number) =>
          padLeft + ((ts - visibleTimeBounds.minT) / timeSpan) * plotWidth;
        const toY = (val: number) =>
          subTop + (1 - (val - min) / valSpan) * subHeight;

        const coords = s.points.map((p) => ({
          x: toX(p.ts),
          y: toY(p.value),
        }));

        return (
          <g key={s.curve.id}>
            <rect
              x={padLeft}
              y={subTop}
              width={plotWidth}
              height={subHeight}
              fill="var(--bg-surface)"
              stroke="var(--chart-grid)"
              rx="6"
            />
            <text
              x={padLeft + 10}
              y={subTop + 16}
              fill={s.curve.color}
              fontSize="11.5"
              fontWeight="600"
            >
              {s.curve.moduleName} — {METRIC_METADATA[s.curve.metric]?.label} (
              {s.unit})
            </text>
            <text
              x={padLeft - 8}
              y={subTop + 12}
              textAnchor="end"
              fill="var(--chart-axis)"
              fontSize="10.5"
            >
              {max.toFixed(1)}
            </text>
            <text
              x={padLeft - 8}
              y={subBottom - 4}
              textAnchor="end"
              fill="var(--chart-axis)"
              fontSize="10.5"
            >
              {min.toFixed(1)}
            </text>

            {showAvgLines && s.points.length > 0 && (
              <line
                x1={padLeft}
                y1={toY(s.stats.avg)}
                x2={padLeft + plotWidth}
                y2={toY(s.stats.avg)}
                stroke={s.curve.color}
                strokeOpacity="0.35"
                strokeDasharray="4 4"
              />
            )}

            {coords.length > 1 && (
              <>
                {curveStyle === 'area' && (
                  <path
                    d={`${buildSvgPath(coords, false)} L ${coords[coords.length - 1].x.toFixed(1)} ${subBottom.toFixed(1)} L ${coords[0].x.toFixed(1)} ${subBottom.toFixed(1)} Z`}
                    fill={`url(#grad-${sIdx})`}
                  />
                )}
                <path
                  d={buildSvgPath(coords, curveStyle === 'step')}
                  fill="none"
                  stroke={s.curve.color}
                  strokeWidth="2"
                />
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}

function renderTimeAxis(params: {
  visibleTimeBounds: { minT: number; maxT: number };
  padLeft: number;
  y: number;
  plotWidth: number;
}) {
  const { visibleTimeBounds, padLeft, y, plotWidth } = params;
  const span = visibleTimeBounds.maxT - visibleTimeBounds.minT;
  const tickCount = 6;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => i / tickCount);

  return (
    <g>
      {ticks.map((ratio, idx) => {
        const x = padLeft + ratio * plotWidth;
        const ts = visibleTimeBounds.minT + ratio * span;
        const d = new Date(ts * 1000);
        const label =
          span <= 86400 * 2
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : span <= 86400 * 90
              ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
              : d.toLocaleDateString([], {
                  year: '2-digit',
                  month: 'short',
                  day: 'numeric',
                });

        return (
          <g key={idx}>
            <line
              x1={x}
              y1={y}
              x2={x}
              y2={y + 5}
              stroke="var(--chart-grid)"
            />
            <text
              x={x}
              y={y + 20}
              textAnchor="middle"
              fill="var(--chart-axis)"
              fontSize="11"
            >
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function buildSvgPath(
  coords: Array<{ x: number; y: number }>,
  step = false
): string {
  if (coords.length === 0) return '';
  let d = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    if (step) {
      d += ` H ${coords[i].x.toFixed(1)} V ${coords[i].y.toFixed(1)}`;
    } else {
      d += ` L ${coords[i].x.toFixed(1)} ${coords[i].y.toFixed(1)}`;
    }
  }
  return d;
}
