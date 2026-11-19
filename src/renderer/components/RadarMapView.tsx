import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  CloudRain,
  Compass,
  Layers,
  LocateFixed,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import {
  MetricType,
  RadarMetadataPayload,
  RadarProvider,
  UserSettings,
  WeatherStation,
} from '../types';
import { formatMetricValue } from '../utils/metrics';
import { getThemeDefinition } from '../utils/themes';

interface RadarMapViewProps {
  stations: WeatherStation[];
  settings: UserSettings;
  onOpenInChart?: (moduleId: string, metric: MetricType) => void;
}

type BaseMapMode = 'auto' | 'dark' | 'light' | 'osm';

// DWD Radar_rv_product_1x1km_ger footprint (Germany & Central European border regions)
const DWD_BOUNDS = {
  minLat: 45.65,
  maxLat: 56.25,
  minLon: 1.45,
  maxLon: 18.75,
};

function isInsideDwdBounds(lat: number, lon: number): boolean {
  return (
    lat >= DWD_BOUNDS.minLat &&
    lat <= DWD_BOUNDS.maxLat &&
    lon >= DWD_BOUNDS.minLon &&
    lon <= DWD_BOUNDS.maxLon
  );
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getStationCoordinates(station?: WeatherStation): [number, number] | null {
  const loc = station?.place?.location;
  if (!Array.isArray(loc) || loc.length < 2) return null;
  const lon = Number(loc[0]);
  const lat = Number(loc[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

function formatFrameOffset(timestampSec: number): {
  label: string;
  tone: 'past' | 'now' | 'forecast';
} {
  const diffMin = Math.round((timestampSec - Date.now() / 1000) / 60);
  if (Math.abs(diffMin) <= 3) {
    return { label: 'NOW', tone: 'now' };
  }
  const absMin = Math.abs(diffMin);
  const h = Math.floor(absMin / 60);
  const m = absMin % 60;
  const duration = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
  if (diffMin > 0) {
    return { label: `+${duration} Forecast`, tone: 'forecast' };
  }
  return { label: `-${duration}`, tone: 'past' };
}

function getBaseTileConfig(mode: BaseMapMode, themeId: string): {
  url: string;
  attribution: string;
  subdomains?: string;
} {
  const effectiveDark =
    mode === 'dark'
      ? true
      : mode === 'light'
        ? false
        : mode === 'osm'
          ? false
          : getThemeDefinition(themeId).mode !== 'light';

  if (mode === 'osm') {
    return {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors',
    };
  }
  if (effectiveDark) {
    return {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    };
  }
  return {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  };
}

export const RadarMapView: React.FC<RadarMapViewProps> = ({
  stations,
  settings,
  onOpenInChart,
}) => {
  const primaryStation = stations[0];
  const primaryCoords = useMemo(
    () => getStationCoordinates(primaryStation),
    [primaryStation]
  );

  const defaultProvider: RadarProvider = useMemo(() => {
    try {
      const saved = localStorage.getItem('winatmo_radar_provider');
      if (saved === 'dwd' || saved === 'rainviewer') {
        return saved;
      }
    } catch {}
    if (primaryCoords) {
      return isInsideDwdBounds(primaryCoords[0], primaryCoords[1])
        ? 'dwd'
        : 'rainviewer';
    }
    return 'dwd';
  }, [primaryCoords]);

  const [provider, setProvider] = useState<RadarProvider>(defaultProvider);
  const [baseMapMode, setBaseMapMode] = useState<BaseMapMode>(() => {
    try {
      const saved = localStorage.getItem('winatmo_radar_basemap');
      if (
        saved === 'auto' ||
        saved === 'dark' ||
        saved === 'light' ||
        saved === 'osm'
      ) {
        return saved;
      }
    } catch {}
    return 'auto';
  });
  const [opacity, setOpacity] = useState<number>(() => {
    try {
      const raw = Number(localStorage.getItem('winatmo_radar_opacity'));
      if (Number.isFinite(raw) && raw >= 0.2 && raw <= 1) return raw;
    } catch {}
    return 0.72;
  });

  const [metadata, setMetadata] = useState<RadarMetadataPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [frameIndex, setFrameIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [mapCenter, setMapCenter] = useState<[number, number]>(
    primaryCoords || [50.1109, 8.6821]
  );

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const radarLayerRef = useRef<L.TileLayer | L.TileLayer.WMS | null>(null);
  const radarLayerKeyRef = useRef<string>('');
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  const loadMetadata = useCallback(
    async (targetProvider: RadarProvider, force = false) => {
      if (typeof window.winatmo?.getRadarMetadata !== 'function') {
        setErrorMsg(
          'Restart Electron (npm run dev) to enable the Rain Radar map backend.'
        );
        setLoading(false);
        return;
      }
      setLoading(true);
      setErrorMsg(null);
      try {
        const res = await window.winatmo.getRadarMetadata({
          provider: targetProvider,
          force,
        });
        setMetadata(res);
        if (res.error) {
          setErrorMsg(res.error);
        }
        if (res.frames.length > 0) {
          setFrameIndex(
            Math.max(0, Math.min(res.frames.length - 1, res.defaultFrameIndex))
          );
        } else {
          setFrameIndex(0);
        }
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to load radar frames.');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    setIsPlaying(false);
    void loadMetadata(provider, false);
    try {
      localStorage.setItem('winatmo_radar_provider', provider);
    } catch {}
  }, [provider, loadMetadata]);

  useEffect(() => {
    try {
      localStorage.setItem('winatmo_radar_basemap', baseMapMode);
    } catch {}
  }, [baseMapMode]);

  useEffect(() => {
    try {
      localStorage.setItem('winatmo_radar_opacity', String(opacity));
    } catch {}
  }, [opacity]);

  // Initialize Leaflet Map instance once on mount
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el || mapRef.current) return;

    const initialCenter: [number, number] = primaryCoords || [50.1109, 8.6821];
    const initialZoom = primaryCoords ? 8 : 6;

    const map = L.map(el, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 16,
    });

    const markersGroup = L.layerGroup().addTo(map);
    mapRef.current = map;
    markersLayerRef.current = markersGroup;

    map.on('moveend', () => {
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
    });

    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
      radarLayerRef.current = null;
      radarLayerKeyRef.current = '';
      markersLayerRef.current = null;
    };
  }, []);

  // Sync Base Map Layer with app theme or explicit user selection
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const cfg = getBaseTileConfig(baseMapMode, settings.theme);
    if (baseLayerRef.current) {
      map.removeLayer(baseLayerRef.current);
      baseLayerRef.current = null;
    }

    const layer = L.tileLayer(cfg.url, {
      ...(cfg.subdomains ? { subdomains: cfg.subdomains } : {}),
      attribution: cfg.attribution,
      maxZoom: 19,
      zIndex: 1,
    });
    layer.addTo(map);
    baseLayerRef.current = layer;
  }, [baseMapMode, settings.theme]);

  // Update Radar Overlay Layer cleanly when metadata, frameIndex, or opacity changes
  const activeFrame =
    metadata && metadata.frames.length > 0
      ? metadata.frames[Math.min(frameIndex, metadata.frames.length - 1)]
      : null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !metadata || !activeFrame) {
      if (map && radarLayerRef.current) {
        map.removeLayer(radarLayerRef.current);
        radarLayerRef.current = null;
        radarLayerKeyRef.current = '';
      }
      return;
    }

    if (metadata.provider === 'dwd' && metadata.wmsUrl && metadata.wmsLayer) {
      const key = `dwd:${metadata.wmsUrl}:${metadata.wmsLayer}`;
      if (radarLayerRef.current && radarLayerKeyRef.current === key) {
        const wms = radarLayerRef.current as L.TileLayer.WMS;
        wms.setOpacity(opacity);
        wms.setParams({ TIME: activeFrame.isoTime } as any, false);
      } else {
        if (radarLayerRef.current) {
          map.removeLayer(radarLayerRef.current);
        }
        const wms = L.tileLayer.wms(metadata.wmsUrl, {
          layers: metadata.wmsLayer,
          format: 'image/png',
          transparent: true,
          version: '1.3.0',
          opacity,
          zIndex: 10,
          attribution: metadata.attribution,
          TIME: activeFrame.isoTime,
        } as L.WMSOptions & { TIME: string });
        wms.addTo(map);
        radarLayerRef.current = wms;
        radarLayerKeyRef.current = key;
      }
      return;
    }

    if (
      metadata.provider === 'rainviewer' &&
      metadata.host &&
      activeFrame.tilePath
    ) {
      const tileUrl = `${metadata.host}${activeFrame.tilePath}/256/{z}/{x}/{y}/2/1_1.png`;
      const key = `rainviewer:${metadata.host}`;
      if (radarLayerRef.current && radarLayerKeyRef.current === key) {
        const tl = radarLayerRef.current as L.TileLayer;
        tl.setOpacity(opacity);
        tl.setUrl(tileUrl, false);
      } else {
        if (radarLayerRef.current) {
          map.removeLayer(radarLayerRef.current);
        }
        const tl = L.tileLayer(tileUrl, {
          tileSize: 256,
          maxNativeZoom: metadata.maxNativeZoom || 7,
          maxZoom: 16,
          opacity,
          zIndex: 10,
          attribution: metadata.attribution,
        });
        tl.addTo(map);
        radarLayerRef.current = tl;
        radarLayerKeyRef.current = key;
      }
    }
  }, [metadata, activeFrame, opacity]);

  // Plot Weather Station Pins with live readings
  useEffect(() => {
    const group = markersLayerRef.current;
    if (!group) return;
    group.clearLayers();

    for (const st of stations) {
      const coords = getStationCoordinates(st);
      if (!coords) continue;

      const outdoor =
        st.modules.find((m) => m.type === 'NAModule1') ||
        st.modules.find((m) => m.type === 'NAMain') ||
        st.modules[0];
      const mainMod = st.modules.find((m) => m.type === 'NAMain') || st.modules[0];
      const rainMod = st.modules.find((m) => m.type === 'NAModule3');
      const windMod = st.modules.find((m) => m.type === 'NAModule2');

      const tempRaw = outdoor?.dashboard?.Temperature ?? mainMod?.dashboard?.Temperature;
      const tempLabel =
        tempRaw !== undefined
          ? formatMetricValue(tempRaw, 'temperature', settings)
          : '--';
      const rainNow = rainMod?.dashboard?.Rain;
      const isRaining = rainNow !== undefined && rainNow > 0;
      const rainLabel =
        rainNow !== undefined ? formatMetricValue(rainNow, 'rain', settings) : null;

      const badgeHtml = `
        <div class="radar-station-badge ${isRaining ? 'is-raining' : ''}">
          <span class="radar-pin-dot"></span>
          <span class="radar-pin-name">${escapeHtml(st.stationName)}</span>
          <span class="radar-pin-temp">${escapeHtml(tempLabel)}</span>
          ${
            isRaining && rainLabel
              ? `<span class="radar-pin-rain">${escapeHtml(rainLabel)}</span>`
              : ''
          }
        </div>
      `;

      const icon = L.divIcon({
        className: 'radar-station-divicon',
        html: badgeHtml,
        iconSize: undefined,
        iconAnchor: [16, 16],
      });

      const popupLines: string[] = [];
      popupLines.push(
        `<div class="radar-popup-title">${escapeHtml(st.stationName)}${
          st.place?.city ? ` <span>• ${escapeHtml(st.place.city)}</span>` : ''
        }</div>`
      );
      if (tempRaw !== undefined) {
        popupLines.push(
          `<div class="radar-popup-row"><span>Temperature</span><strong>${escapeHtml(
            formatMetricValue(tempRaw, 'temperature', settings)
          )}</strong></div>`
        );
      }
      const hum = outdoor?.dashboard?.Humidity ?? mainMod?.dashboard?.Humidity;
      if (hum !== undefined) {
        popupLines.push(
          `<div class="radar-popup-row"><span>Humidity</span><strong>${escapeHtml(
            formatMetricValue(hum, 'humidity', settings)
          )}</strong></div>`
        );
      }
      if (rainMod?.dashboard) {
        if (rainMod.dashboard.Rain !== undefined) {
          popupLines.push(
            `<div class="radar-popup-row"><span>Rain Intensity</span><strong>${escapeHtml(
              formatMetricValue(rainMod.dashboard.Rain, 'rain', settings)
            )}</strong></div>`
          );
        }
        if (rainMod.dashboard.sum_rain_24 !== undefined) {
          popupLines.push(
            `<div class="radar-popup-row"><span>Rain 24h</span><strong>${escapeHtml(
              formatMetricValue(rainMod.dashboard.sum_rain_24, 'sum_rain', settings)
            )}</strong></div>`
          );
        }
      }
      if (windMod?.dashboard?.WindStrength !== undefined) {
        popupLines.push(
          `<div class="radar-popup-row"><span>Wind</span><strong>${escapeHtml(
            formatMetricValue(windMod.dashboard.WindStrength, 'windstrength', settings)
          )}</strong></div>`
        );
      }
      if (mainMod?.dashboard?.Pressure !== undefined) {
        popupLines.push(
          `<div class="radar-popup-row"><span>Pressure</span><strong>${escapeHtml(
            formatMetricValue(mainMod.dashboard.Pressure, 'pressure', settings)
          )}</strong></div>`
        );
      }

      const marker = L.marker(coords, { icon });
      marker.bindPopup(`<div class="radar-popup-card">${popupLines.join('')}</div>`, {
        className: 'radar-leaflet-popup',
      });
      if (onOpenInChart && (rainMod || outdoor || mainMod)) {
        marker.on('dblclick', () => {
          const targetMod = rainMod || outdoor || mainMod;
          if (targetMod) {
            onOpenInChart(
              targetMod.id,
              rainMod ? 'rain' : 'temperature'
            );
          }
        });
      }
      marker.addTo(group);
    }
  }, [stations, settings, onOpenInChart]);

  // Frame animation playback loop
  useEffect(() => {
    if (!isPlaying || !metadata || metadata.frames.length <= 1) return;
    const timer = window.setInterval(() => {
      setFrameIndex((prev) =>
        metadata.frames.length > 0 ? (prev + 1) % metadata.frames.length : 0
      );
    }, 750);
    return () => window.clearInterval(timer);
  }, [isPlaying, metadata]);

  const handleCenterOnStation = () => {
    const map = mapRef.current;
    if (!map) return;
    if (primaryCoords) {
      map.setView(primaryCoords, provider === 'dwd' ? 8 : 7, { animate: true });
    } else {
      map.setView([50.1109, 8.6821], 6, { animate: true });
    }
  };

  const handleJumpToNow = () => {
    if (!metadata || metadata.frames.length === 0) return;
    setIsPlaying(false);
    setFrameIndex(metadata.defaultFrameIndex);
  };

  const frames = metadata?.frames || [];
  const isOutsideDwd =
    provider === 'dwd' && !isInsideDwdBounds(mapCenter[0], mapCenter[1]);
  const offsetInfo = activeFrame
    ? formatFrameOffset(activeFrame.timestampSec)
    : null;
  const nowMarkerPct =
    frames.length > 1 && metadata
      ? (metadata.defaultFrameIndex / (frames.length - 1)) * 100
      : 0;

  return (
    <div className="radar-map-view">
      {/* Top Toolbar */}
      <div className="radar-toolbar">
        <div className="radar-toolbar-left">
          <div className="radar-title-group">
            <CloudRain size={17} className="accent-icon" />
            <div>
              <h2>European Rain Radar Map</h2>
              <span className="radar-subtitle">
                {metadata?.coverageNote ||
                  'Loading live radar composite timestamps...'}
              </span>
            </div>
          </div>

          <div className="radar-provider-pills" role="group" aria-label="Radar Source">
            <button
              type="button"
              className={`pill-btn ${provider === 'dwd' ? 'active' : ''}`}
              onClick={() => setProvider('dwd')}
              title="Deutscher Wetterdienst 1km Radar + 2h Future Forecast (Germany & Central Europe)"
            >
              DWD 1km + 2h Nowcast
            </button>
            <button
              type="button"
              className={`pill-btn ${provider === 'rainviewer' ? 'active' : ''}`}
              onClick={() => setProvider('rainviewer')}
              title="RainViewer Public API (All of Europe, Past 2h, max native zoom 7)"
            >
              RainViewer Europe (2h Past)
            </button>
          </div>
        </div>

        <div className="radar-toolbar-right">
          <div className="radar-basemap-group" title="Base map style">
            <Layers size={13} />
            <select
              className="select-input radar-basemap-select"
              value={baseMapMode}
              onChange={(e) => setBaseMapMode(e.target.value as BaseMapMode)}
            >
              <option value="auto">Map: Auto (Theme)</option>
              <option value="dark">Map: Dark</option>
              <option value="light">Map: Light</option>
              <option value="osm">Map: OpenStreetMap</option>
            </select>
          </div>

          <button
            type="button"
            className="action-btn"
            onClick={handleCenterOnStation}
            title={
              primaryCoords
                ? `Center map on ${primaryStation?.stationName || 'Station'}`
                : 'Center map on Central Europe'
            }
          >
            <LocateFixed size={14} />
            <span>{primaryCoords ? 'My Station' : 'Europe'}</span>
          </button>

          <button
            type="button"
            className="action-btn primary"
            onClick={() => loadMetadata(provider, true)}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            <span>{loading ? 'Updating...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="radar-error-banner">
          <span>{errorMsg}</span>
          {provider === 'rainviewer' && (
            <button
              type="button"
              className="pill-btn"
              onClick={() => setProvider('dwd')}
            >
              Try DWD Radar
            </button>
          )}
        </div>
      )}

      {/* Map Viewport */}
      <div className="radar-map-stage">
        <div ref={mapContainerRef} className="radar-leaflet-container" />

        {isOutsideDwd && (
          <div className="radar-coverage-hint">
            <Compass size={14} />
            <span>Outside DWD Central Europe radar bounds.</span>
            <button
              type="button"
              className="pill-btn active"
              onClick={() => setProvider('rainviewer')}
            >
              Switch to RainViewer (All Europe)
            </button>
          </div>
        )}

        {/* Rain Intensity Legend */}
        <div className="radar-legend-card">
          <span className="radar-legend-title">Rain Intensity</span>
          <div className="radar-legend-bar" />
          <div className="radar-legend-labels">
            <span>Light</span>
            <span>Moderate</span>
            <span>Heavy</span>
            <span>Intense</span>
          </div>
        </div>
      </div>

      {/* Bottom Timeline & Playback Controls */}
      <div className="radar-playback-bar">
        <div className="radar-playback-buttons">
          <button
            type="button"
            className="action-btn radar-icon-btn"
            onClick={() => {
              setIsPlaying(false);
              setFrameIndex((i) =>
                frames.length > 0 ? (i - 1 + frames.length) % frames.length : 0
              );
            }}
            disabled={frames.length === 0}
            title="Previous frame"
          >
            <SkipBack size={14} />
          </button>

          <button
            type="button"
            className="action-btn primary radar-play-btn"
            onClick={() => setIsPlaying((p) => !p)}
            disabled={frames.length <= 1}
            title={isPlaying ? 'Pause radar animation' : 'Play radar animation'}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            <span>{isPlaying ? 'Pause' : 'Play'}</span>
          </button>

          <button
            type="button"
            className="action-btn radar-icon-btn"
            onClick={() => {
              setIsPlaying(false);
              setFrameIndex((i) =>
                frames.length > 0 ? (i + 1) % frames.length : 0
              );
            }}
            disabled={frames.length === 0}
            title="Next frame"
          >
            <SkipForward size={14} />
          </button>

          <button
            type="button"
            className="pill-btn"
            onClick={handleJumpToNow}
            disabled={frames.length === 0}
            title="Jump to current live radar frame"
          >
            Now
          </button>
        </div>

        <div className="radar-timeline-track-wrap">
          <div className="radar-timeline-slider-box">
            {frames.length > 1 && metadata && metadata.defaultFrameIndex > 0 && (
              <div
                className="radar-now-tick"
                style={{ left: `${nowMarkerPct}%` }}
                title="Current time"
              />
            )}
            <input
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              step={1}
              value={Math.min(frameIndex, Math.max(0, frames.length - 1))}
              onChange={(e) => {
                setIsPlaying(false);
                setFrameIndex(Number(e.target.value));
              }}
              disabled={frames.length <= 1}
              className="radar-timeline-slider"
            />
          </div>
          {activeFrame && offsetInfo && (
            <div className="radar-frame-status">
              <span className="radar-frame-time">
                {new Date(activeFrame.timestampSec * 1000).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span className={`radar-offset-pill ${offsetInfo.tone}`}>
                {offsetInfo.label}
              </span>
              <span className="radar-frame-counter">
                {frameIndex + 1}/{frames.length}
              </span>
            </div>
          )}
        </div>

        <div className="radar-opacity-control" title="Radar layer opacity">
          <span>Opacity</span>
          <input
            type="range"
            min={0.25}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
          <span>{Math.round(opacity * 100)}%</span>
        </div>
      </div>
    </div>
  );
};
