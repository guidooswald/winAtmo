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
  RadarFrame,
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

type BaseMapMode = 'auto' | 'dark' | 'light' | 'osm-dark' | 'osm' | 'topo';

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
  labelsUrl?: string;
  attribution: string;
  maxZoom: number;
  darkOsmFilter?: boolean;
} {
  const isLightTheme = getThemeDefinition(themeId).mode === 'light';
  const resolvedMode =
    mode === 'auto' ? (isLightTheme ? 'light' : 'dark') : mode;

  if (resolvedMode === 'osm' || resolvedMode === 'osm-dark') {
    return {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      darkOsmFilter: resolvedMode === 'osm-dark',
    };
  }

  if (resolvedMode === 'topo') {
    return {
      url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors &copy; OpenTopoMap (CC-BY-SA)',
      maxZoom: 17,
    };
  }

  if (resolvedMode === 'dark') {
    return {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      labelsUrl:
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
      maxZoom: 16,
    };
  }

  return {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    labelsUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    maxZoom: 16,
  };
}

const DWD_PREFETCH_STEPS = 6;
const DWD_LATLNG_BOUNDS = L.latLngBounds(
  [DWD_BOUNDS.minLat, DWD_BOUNDS.minLon],
  [DWD_BOUNDS.maxLat, DWD_BOUNDS.maxLon]
);

function getRadarFrameKey(provider: RadarProvider, frame: RadarFrame): string {
  return `${provider}:${frame.isoTime}`;
}

function toProxyTileUrl(rawUrl: string, cacheProxyUrl?: string): string {
  if (!cacheProxyUrl) return rawUrl;
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return `${cacheProxyUrl}/tile?u=${encodeURIComponent(rawUrl)}`;
  }
  return rawUrl;
}

let activeCacheProxyUrl: string | undefined;

const ProxiedTileLayer = L.TileLayer.extend({
  getTileUrl(coords: L.Coords): string {
    const raw = L.TileLayer.prototype.getTileUrl.call(this, coords);
    return toProxyTileUrl(raw, activeCacheProxyUrl);
  },
});

const ProxiedWmsTileLayer = L.TileLayer.WMS.extend({
  getTileUrl(coords: L.Coords): string {
    const raw = L.TileLayer.WMS.prototype.getTileUrl.call(this, coords);
    return toProxyTileUrl(raw, activeCacheProxyUrl);
  },
});

function createProxiedTileLayer(
  urlTemplate: string,
  options: L.TileLayerOptions
): L.TileLayer {
  return new (ProxiedTileLayer as any)(urlTemplate, options);
}

function createProxiedWmsLayer(
  baseUrl: string,
  options: L.WMSOptions & Record<string, unknown>
): L.TileLayer.WMS {
  return new (ProxiedWmsTileLayer as any)(baseUrl, options);
}

function getVisibleTileCoords(
  map: L.Map,
  maxNativeZoom: number,
  tileSize = 256,
  restrictBounds?: L.LatLngBounds
): L.Coords[] {
  const size = map.getSize();
  if (!size || size.x <= 0 || size.y <= 0) return [];
  const bounds = map.getPixelBounds();
  if (!bounds?.min || !bounds?.max) return [];

  const tileZoom = Math.max(0, Math.min(Math.round(map.getZoom()), maxNativeZoom));
  const scale = Math.pow(2, tileZoom - map.getZoom());
  const minX = Math.floor((bounds.min.x * scale) / tileSize);
  const maxX = Math.ceil((bounds.max.x * scale) / tileSize) - 1;
  const minY = Math.floor((bounds.min.y * scale) / tileSize);
  const maxY = Math.ceil((bounds.max.y * scale) / tileSize) - 1;
  const maxIndex = Math.max(1, Math.floor((256 * Math.pow(2, tileZoom)) / tileSize));

  const coords: L.Coords[] = [];
  for (let y = minY; y <= maxY; y++) {
    if (y < 0 || y >= maxIndex) continue;
    for (let x = minX; x <= maxX; x++) {
      const wrappedX = ((x % maxIndex) + maxIndex) % maxIndex;
      if (restrictBounds) {
        const nw = map.unproject(L.point(x * tileSize, y * tileSize), tileZoom);
        const se = map.unproject(
          L.point((x + 1) * tileSize, (y + 1) * tileSize),
          tileZoom
        );
        if (!restrictBounds.overlaps(L.latLngBounds(se, nw))) {
          continue;
        }
      }
      const c = new L.Point(wrappedX, y) as L.Coords;
      c.z = tileZoom;
      coords.push(c);
    }
  }
  return coords;
}

function getRawFrameTileUrls(
  map: L.Map,
  meta: RadarMetadataPayload,
  frame: RadarFrame
): string[] {
  const maxNative = meta.maxNativeZoom || (meta.provider === 'dwd' ? 12 : 7);
  const tileSizePx = meta.provider === 'dwd' ? 512 : 256;
  const restrictBounds = meta.provider === 'dwd' ? DWD_LATLNG_BOUNDS : undefined;
  const coords = getVisibleTileCoords(map, maxNative, tileSizePx, restrictBounds);
  if (coords.length === 0) return [];

  const layerName = frame.wmsLayer || meta.wmsLayer;
  if (meta.provider === 'dwd' && meta.wmsUrl && layerName) {
    const crs = map.options.crs || L.CRS.EPSG3857;
    const tileSize = L.point(tileSizePx, tileSizePx);
    const scratchWms = L.tileLayer.wms(meta.wmsUrl, {
      layers: layerName,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      tileSize: tileSizePx,
      TIME: frame.isoTime,
    } as L.WMSOptions & { TIME: string });
    const wmsParams: Record<string, unknown> = {
      ...(scratchWms as any).wmsParams,
      crs: crs.code,
    };
    const paramStr = L.Util.getParamString(wmsParams, meta.wmsUrl, false);

    return coords.map((c) => {
      const nwPoint = c.scaleBy(tileSize);
      const sePoint = nwPoint.add(tileSize);
      const nw = map.unproject(nwPoint, c.z);
      const se = map.unproject(sePoint, c.z);
      const bounds = L.bounds(crs.project(nw), crs.project(se));
      const min = bounds.min!;
      const max = bounds.max!;
      const bbox = (
        crs === L.CRS.EPSG4326
          ? [min.y, min.x, max.y, max.x]
          : [min.x, min.y, max.x, max.y]
      ).join(',');
      return `${meta.wmsUrl}${paramStr}&bbox=${bbox}`;
    });
  }

  if (meta.provider === 'rainviewer' && meta.host && frame.tilePath) {
    return coords.map(
      (c) =>
        `${meta.host}${frame.tilePath}/256/${c.z}/${c.x}/${c.y}/2/1_1.png`
    );
  }

  return [];
}

function buildSurroundingIndices(
  total: number,
  centerIndex: number,
  maxSteps: number
): number[] {
  if (total <= 0) return [];
  const seen = new Set<number>([centerIndex]);
  const order: number[] = [];
  for (let step = 1; step <= maxSteps; step++) {
    const forward = centerIndex + step;
    if (forward >= 0 && forward < total && !seen.has(forward)) {
      seen.add(forward);
      order.push(forward);
    }
    const past = centerIndex - step;
    if (past >= 0 && past < total && !seen.has(past)) {
      seen.add(past);
      order.push(past);
    }
  }
  return order;
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

  const [provider, setProvider] = useState<RadarProvider>(() => {
    try {
      const saved = localStorage.getItem('winatmo_radar_provider_v2');
      if (saved === 'dwd' || saved === 'rainviewer') {
        return saved;
      }
    } catch {}
    return 'rainviewer';
  });
  const [baseMapMode, setBaseMapMode] = useState<BaseMapMode>(() => {
    try {
      const saved = localStorage.getItem('winatmo_radar_basemap_v2');
      if (
        saved === 'auto' ||
        saved === 'dark' ||
        saved === 'light' ||
        saved === 'osm-dark' ||
        saved === 'osm' ||
        saved === 'topo'
      ) {
        return saved;
      }
    } catch {}
    return 'topo';
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
  const [downloadedKeys, setDownloadedKeys] = useState<Record<string, true>>({});
  const [prefetchingKey, setPrefetchingKey] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const refLabelsLayerRef = useRef<L.TileLayer | null>(null);
  const radarLayerRef = useRef<L.TileLayer | L.TileLayer.WMS | null>(null);
  const radarLayerKeyRef = useRef<string>('');
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const cacheProxyUrlRef = useRef<string | undefined>(undefined);
  const metadataRef = useRef<RadarMetadataPayload | null>(null);
  const abortPrefetchRef = useRef<AbortController | null>(null);
  const prefetchDoneKeyRef = useRef<string>('');

  const refreshDownloadedStatus = useCallback(
    async (meta: RadarMetadataPayload | null) => {
      const map = mapRef.current;
      if (
        !map ||
        !meta ||
        meta.frames.length === 0 ||
        typeof window.winatmo?.checkCachedRadarUrls !== 'function'
      ) {
        return;
      }
      const frameUrlPairs = meta.frames.map((frame) => ({
        key: getRadarFrameKey(meta.provider, frame),
        urls: getRawFrameTileUrls(map, meta, frame),
      }));
      const uniqueUrls = Array.from(
        new Set(frameUrlPairs.flatMap((pair) => pair.urls))
      );
      if (uniqueUrls.length === 0) return;

      try {
        const cachedList = await window.winatmo.checkCachedRadarUrls(uniqueUrls);
        const cachedSet = new Set(cachedList);
        setDownloadedKeys((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const pair of frameUrlPairs) {
            if (pair.urls.length > 0 && pair.urls.every((u) => cachedSet.has(u))) {
              if (!next[pair.key]) {
                next[pair.key] = true;
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      } catch {
        // Ignore transient cache check failures
      }
    },
    []
  );

  const loadSeqRef = useRef<number>(0);

  const loadMetadata = useCallback(
    async (targetProvider: RadarProvider, force = false) => {
      if (typeof window.winatmo?.getRadarMetadata !== 'function') {
        setErrorMsg(
          'Restart Electron (npm run dev) to enable the Rain Radar map backend.'
        );
        setLoading(false);
        return;
      }
      const seq = ++loadSeqRef.current;
      abortPrefetchRef.current?.abort();
      prefetchDoneKeyRef.current = '';
      setPrefetchingKey(null);
      setLoading(true);
      setErrorMsg(null);
      setMetadata((prev) =>
        prev && prev.provider !== targetProvider
          ? {
              ...prev,
              provider: targetProvider,
              frames: [],
              defaultFrameIndex: 0,
              coverageNote:
                targetProvider === 'dwd'
                  ? 'Loading DWD radar composite & forecast timestamps...'
                  : 'Loading RainViewer Europe radar timestamps...',
              error: undefined,
            }
          : prev
      );
      try {
        const res = await window.winatmo.getRadarMetadata({
          provider: targetProvider,
          force,
        });
        if (seq !== loadSeqRef.current) return;
        activeCacheProxyUrl = res.cacheProxyUrl;
        cacheProxyUrlRef.current = res.cacheProxyUrl;
        metadataRef.current = res;
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
        void refreshDownloadedStatus(res);
      } catch (err: any) {
        if (seq !== loadSeqRef.current) return;
        setErrorMsg(err?.message || 'Failed to load radar frames.');
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [refreshDownloadedStatus]
  );

  useEffect(() => {
    setIsPlaying(false);
    void loadMetadata(provider, false);
    try {
      localStorage.setItem('winatmo_radar_provider_v2', provider);
    } catch {}
  }, [provider, loadMetadata]);

  useEffect(() => {
    try {
      localStorage.setItem('winatmo_radar_basemap_v2', baseMapMode);
    } catch {}
  }, [baseMapMode]);

  useEffect(() => {
    try {
      localStorage.setItem('winatmo_radar_opacity', String(opacity));
    } catch {}
  }, [opacity]);

  const isPlayingRef = useRef<boolean>(isPlaying);
  isPlayingRef.current = isPlaying;

  const opacityRef = useRef<number>(opacity);
  opacityRef.current = opacity;

  const prefetchFramesForMeta = useCallback(
    async (
      meta: RadarMetadataPayload,
      indices: number[],
      signal: AbortSignal
    ) => {
      const map = mapRef.current;
      const proxyBase = meta.cacheProxyUrl || cacheProxyUrlRef.current;
      if (!map || !proxyBase || indices.length === 0) return;

      for (const idx of indices) {
        if (signal.aborted) return;
        const frame = meta.frames[idx];
        if (!frame) continue;
        const key = getRadarFrameKey(meta.provider, frame);
        const rawUrls = getRawFrameTileUrls(map, meta, frame);
        if (rawUrls.length === 0) continue;

        let missingUrls = rawUrls;
        if (typeof window.winatmo?.checkCachedRadarUrls === 'function') {
          try {
            const already = await window.winatmo.checkCachedRadarUrls(rawUrls);
            const alreadySet = new Set(already);
            if (rawUrls.every((u) => alreadySet.has(u))) {
              setDownloadedKeys((prev) =>
                prev[key] ? prev : { ...prev, [key]: true }
              );
              continue;
            }
            missingUrls = rawUrls.filter((u) => !alreadySet.has(u));
          } catch {
            // Proceed to fetch via local proxy cache
          }
        }

        if (signal.aborted) return;
        if (meta.provider === metadataRef.current?.provider) {
          setPrefetchingKey(key);
        }

        let nextCursor = 0;
        let allSucceeded = true;
        const workerCount =
          meta.provider === 'dwd'
            ? Math.min(4, missingUrls.length)
            : Math.min(2, missingUrls.length);
        const workers = Array.from({ length: workerCount }, async () => {
          while (!signal.aborted) {
            const i = nextCursor++;
            if (i >= missingUrls.length) break;
            const url = missingUrls[i];
            try {
              const resp = await fetch(toProxyTileUrl(url, proxyBase), { signal });
              if (!resp.ok) {
                allSucceeded = false;
              }
            } catch {
              allSucceeded = false;
            }
          }
        });

        await Promise.all(workers);

        if (signal.aborted) return;
        if (allSucceeded) {
          setDownloadedKeys((prev) =>
            prev[key] ? prev : { ...prev, [key]: true }
          );
        }
      }
    },
    []
  );

  const handleActiveFrameLoaded = useCallback(
    async (
      meta: RadarMetadataPayload,
      loadedFrame: RadarFrame,
      loadedIdx: number
    ) => {
      const map = mapRef.current;
      if (!map) return;

      const loadedKey = getRadarFrameKey(meta.provider, loadedFrame);
      setDownloadedKeys((prev) =>
        prev[loadedKey] ? prev : { ...prev, [loadedKey]: true }
      );
      void refreshDownloadedStatus(meta);

      if (isPlayingRef.current) return;

      const center = map.getCenter();
      const queueKey = `${meta.provider}:${meta.fetchedAt}:${loadedIdx}:${Math.round(
        map.getZoom()
      )}:${center.lat.toFixed(2)},${center.lng.toFixed(2)}`;
      if (prefetchDoneKeyRef.current === queueKey) return;

      abortPrefetchRef.current?.abort();
      const controller = new AbortController();
      abortPrefetchRef.current = controller;
      prefetchDoneKeyRef.current = queueKey;

      let surrounding: number[];
      if (meta.provider === 'dwd') {
        // Load fast RADOLAN-RY past steps first (~250ms each), then forward forecast steps
        const pastSteps: number[] = [];
        const forwardSteps: number[] = [];
        for (let step = 1; step <= DWD_PREFETCH_STEPS; step++) {
          if (loadedIdx - step >= 0) pastSteps.push(loadedIdx - step);
          if (loadedIdx + step < meta.frames.length) forwardSteps.push(loadedIdx + step);
        }
        surrounding =
          loadedIdx <= meta.defaultFrameIndex
            ? [...pastSteps, ...forwardSteps]
            : buildSurroundingIndices(
                meta.frames.length,
                loadedIdx,
                DWD_PREFETCH_STEPS
              );
      } else {
        surrounding = buildSurroundingIndices(
          meta.frames.length,
          loadedIdx,
          meta.frames.length
        );
      }

      try {
        await prefetchFramesForMeta(meta, surrounding, controller.signal);
      } finally {
        if (abortPrefetchRef.current === controller) {
          setPrefetchingKey(null);
        }
      }
    },
    [prefetchFramesForMeta, refreshDownloadedStatus]
  );

  // Initialize Leaflet Map instance once on mount
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el || mapRef.current) return;

    let isDisposed = false;
    const initialCenter: [number, number] = primaryCoords || [50.1109, 8.6821];
    const initialZoom = primaryCoords ? 9 : 7;

    const map = L.map(el, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 16,
    });

    const markersGroup = L.layerGroup().addTo(map);
    const radarPane = map.createPane('radarPane');
    radarPane.style.zIndex = '350';
    radarPane.style.pointerEvents = 'none';
    const labelsPane = map.createPane('labelsOverlayPane');
    labelsPane.style.zIndex = '375';
    labelsPane.style.pointerEvents = 'none';
    mapRef.current = map;
    markersLayerRef.current = markersGroup;

    map.on('movestart zoomstart', () => {
      if (isDisposed) return;
      abortPrefetchRef.current?.abort();
      prefetchDoneKeyRef.current = '';
      setPrefetchingKey(null);
    });

    map.on('moveend', () => {
      if (isDisposed || !mapRef.current) return;
      const c = map.getCenter();
      setMapCenter([c.lat, c.lng]);
      prefetchDoneKeyRef.current = '';
      void refreshDownloadedStatus(metadataRef.current);
    });

    const ro = new ResizeObserver(() => {
      if (isDisposed || !mapRef.current) return;
      try {
        map.invalidateSize({ animate: false });
      } catch {}
    });
    ro.observe(el);

    return () => {
      isDisposed = true;
      abortPrefetchRef.current?.abort();
      ro.disconnect();
      try {
        map.remove();
      } catch {}
      mapRef.current = null;
      baseLayerRef.current = null;
      refLabelsLayerRef.current = null;
      radarLayerRef.current = null;
      radarLayerKeyRef.current = '';
      markersLayerRef.current = null;
    };
  }, [refreshDownloadedStatus]);

  const baseTileConfig = useMemo(
    () => getBaseTileConfig(baseMapMode, settings?.theme || 'fluent-dark'),
    [baseMapMode, settings?.theme]
  );

  const cacheProxyUrl = metadata?.cacheProxyUrl;

  // Sync Base Map Layer with app theme or explicit user selection (routed via 24h proxy cache)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!cacheProxyUrl && loading) return;

    try {
      if (baseLayerRef.current) {
        if (map.hasLayer(baseLayerRef.current)) {
          map.removeLayer(baseLayerRef.current);
        }
        baseLayerRef.current = null;
      }
      if (refLabelsLayerRef.current) {
        if (map.hasLayer(refLabelsLayerRef.current)) {
          map.removeLayer(refLabelsLayerRef.current);
        }
        refLabelsLayerRef.current = null;
      }

      const layer = createProxiedTileLayer(baseTileConfig.url, {
        attribution: baseTileConfig.attribution,
        maxZoom: 19,
        maxNativeZoom: baseTileConfig.maxZoom,
        zIndex: 1,
        keepBuffer: 0,
        updateWhenIdle: true,
        updateWhenZooming: false,
      });
      layer.addTo(map);
      baseLayerRef.current = layer;

      if (baseTileConfig.labelsUrl) {
        const labels = createProxiedTileLayer(baseTileConfig.labelsUrl, {
          pane: 'labelsOverlayPane',
          maxZoom: 19,
          maxNativeZoom: baseTileConfig.maxZoom,
          keepBuffer: 0,
          updateWhenIdle: true,
          updateWhenZooming: false,
        });
        labels.addTo(map);
        refLabelsLayerRef.current = labels;
      }
    } catch (err: any) {
      console.warn('[RadarMapView] Failed to switch base map layer:', err);
      setErrorMsg(err?.message || 'Failed to switch map theme.');
    }
  }, [baseTileConfig, cacheProxyUrl, loading]);

  // Update Radar Overlay Layer cleanly when metadata or frameIndex changes
  const clampedFrameIndex =
    metadata && metadata.frames.length > 0
      ? Math.min(frameIndex, metadata.frames.length - 1)
      : 0;
  const activeFrame =
    metadata && metadata.frames.length > 0
      ? metadata.frames[clampedFrameIndex]
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

    let cancelled = false;
    let activeLayer: L.TileLayer | L.TileLayer.WMS | null = null;
    const onTilesLoaded = () => {
      if (cancelled) return;
      void handleActiveFrameLoaded(metadata, activeFrame, clampedFrameIndex);
    };

    const activeWmsLayer = activeFrame.wmsLayer || metadata.wmsLayer;
    if (metadata.provider === 'dwd' && metadata.wmsUrl && activeWmsLayer) {
      const key = `dwd:${metadata.wmsUrl}`;
      if (radarLayerRef.current && radarLayerKeyRef.current === key) {
        const wms = radarLayerRef.current as L.TileLayer.WMS;
        activeLayer = wms;
        wms.on('load', onTilesLoaded);
        wms.setOpacity(opacityRef.current);
        wms.setParams(
          { layers: activeWmsLayer, TIME: activeFrame.isoTime } as any,
          false
        );
      } else {
        if (radarLayerRef.current) {
          map.removeLayer(radarLayerRef.current);
        }
        const wms = createProxiedWmsLayer(metadata.wmsUrl, {
          layers: activeWmsLayer,
          format: 'image/png',
          transparent: true,
          version: '1.3.0',
          tileSize: 512,
          keepBuffer: 0,
          updateWhenIdle: true,
          updateWhenZooming: false,
          bounds: DWD_LATLNG_BOUNDS,
          pane: 'radarPane',
          opacity: opacityRef.current,
          zIndex: 10,
          attribution: metadata.attribution,
          TIME: activeFrame.isoTime,
        });
        activeLayer = wms;
        wms.on('load', onTilesLoaded);
        wms.addTo(map);
        radarLayerRef.current = wms;
        radarLayerKeyRef.current = key;
      }
    } else if (
      metadata.provider === 'rainviewer' &&
      metadata.host &&
      activeFrame.tilePath
    ) {
      const tileUrl = `${metadata.host}${activeFrame.tilePath}/256/{z}/{x}/{y}/2/1_1.png`;
      const key = `rainviewer:${metadata.host}`;
      if (radarLayerRef.current && radarLayerKeyRef.current === key) {
        const tl = radarLayerRef.current as L.TileLayer;
        activeLayer = tl;
        tl.on('load', onTilesLoaded);
        tl.setOpacity(opacityRef.current);
        tl.setUrl(tileUrl, false);
      } else {
        if (radarLayerRef.current) {
          map.removeLayer(radarLayerRef.current);
        }
        const tl = createProxiedTileLayer(tileUrl, {
          tileSize: 256,
          maxNativeZoom: metadata.maxNativeZoom || 7,
          maxZoom: 16,
          keepBuffer: 0,
          updateWhenIdle: true,
          updateWhenZooming: false,
          pane: 'radarPane',
          opacity: opacityRef.current,
          zIndex: 10,
          attribution: metadata.attribution,
        });
        activeLayer = tl;
        tl.on('load', onTilesLoaded);
        tl.addTo(map);
        radarLayerRef.current = tl;
        radarLayerKeyRef.current = key;
      }
    }

    if (activeLayer && !(activeLayer as any)._loading) {
      onTilesLoaded();
    }

    return () => {
      cancelled = true;
      if (activeLayer) {
        activeLayer.off('load', onTilesLoaded);
      }
    };
  }, [metadata, activeFrame, clampedFrameIndex, handleActiveFrameLoaded]);

  useEffect(() => {
    if (radarLayerRef.current) {
      radarLayerRef.current.setOpacity(opacity);
    }
  }, [opacity]);

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
      map.setView(primaryCoords, 9, { animate: true });
    } else {
      map.setView([50.1109, 8.6821], 7, { animate: true });
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
  const cachedFrameCount = frames.reduce((acc, frame) => {
    const key = metadata ? getRadarFrameKey(metadata.provider, frame) : '';
    return acc + (key && downloadedKeys[key] ? 1 : 0);
  }, 0);
  const isPrefetchingCurrentProvider = Boolean(
    prefetchingKey &&
      metadata &&
      prefetchingKey.startsWith(`${metadata.provider}:`)
  );

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
              className={`pill-btn ${provider === 'rainviewer' ? 'active' : ''}`}
              onClick={() => setProvider('rainviewer')}
              title="RainViewer Public API (All of Europe, Past 2h, max native zoom 7)"
            >
              RainViewer Europe (2h Past)
            </button>
            <button
              type="button"
              className={`pill-btn ${provider === 'dwd' ? 'active' : ''}`}
              onClick={() => setProvider('dwd')}
              title="Deutscher Wetterdienst 1km Radar + 2h Future Forecast (Germany & Central Europe)"
            >
              DWD 1km + 2h Nowcast
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
              <option value="dark">Map: Dark Gray</option>
              <option value="light">Map: Light Gray</option>
              <option value="osm-dark">Map: OSM Dark</option>
              <option value="osm">Map: OpenStreetMap</option>
              <option value="topo">Map: OpenTopoMap</option>
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
        <div
          ref={mapContainerRef}
          className={`radar-leaflet-container ${
            baseTileConfig.darkOsmFilter ? 'is-osm-dark' : ''
          }`}
        />

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
          <div className="radar-timeline-slider-column">
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
                value={clampedFrameIndex}
                onChange={(e) => {
                  setIsPlaying(false);
                  setFrameIndex(Number(e.target.value));
                }}
                disabled={frames.length <= 1}
                className="radar-timeline-slider"
              />
            </div>

            {frames.length > 1 && metadata && (
              <div
                className="radar-timeline-ticks"
                aria-label="Downloaded radar frames on timeline"
              >
                {frames.map((frame, idx) => {
                  const key = getRadarFrameKey(metadata.provider, frame);
                  const isCached = Boolean(downloadedKeys[key]);
                  const isPrefetching = prefetchingKey === key;
                  const isActive = idx === clampedFrameIndex;
                  const isNow = idx === metadata.defaultFrameIndex;
                  const timeText = new Date(
                    frame.timestampSec * 1000
                  ).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  });
                  const statusLabel = isCached
                    ? 'Cached (24h)'
                    : isPrefetching
                    ? 'Downloading...'
                    : 'Not cached yet';
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`radar-timeline-tick ${
                        isCached ? 'is-cached' : ''
                      } ${isPrefetching ? 'is-prefetching' : ''} ${
                        frame.kind === 'forecast' ? 'is-forecast' : ''
                      } ${isNow ? 'is-now' : ''} ${
                        isActive ? 'is-active' : ''
                      }`}
                      onClick={() => {
                        setIsPlaying(false);
                        setFrameIndex(idx);
                      }}
                      title={`${timeText} (${frame.kind === 'forecast' ? 'Forecast' : 'Past'}) — ${statusLabel}`}
                    />
                  );
                })}
              </div>
            )}
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
              <span
                className={`radar-cache-pill ${
                  isPrefetchingCurrentProvider ? 'is-downloading' : ''
                }`}
                title="Radar and map tiles are cached locally for up to 24 hours. Highlighted timeline bars show frames ready for instant playback."
              >
                {cachedFrameCount}/{frames.length} cached
                {isPrefetchingCurrentProvider ? ' •' : ''}
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
