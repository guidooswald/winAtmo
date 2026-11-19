import { debugLogger } from './debugLogger';
import {
  RadarFrame,
  RadarMetadataPayload,
  RadarProvider,
} from '../renderer/types';

const DWD_WMS_URL = 'https://maps.dwd.de/geoserver/dwd/wms';
const DWD_LAYER = 'Radar_rv_product_1x1km_ger';
const RAINVIEWER_API_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const METADATA_CACHE_TTL_MS = 4 * 60 * 1000;

const cachedByProvider = new Map<RadarProvider, RadarMetadataPayload>();
const inFlightByProvider = new Map<RadarProvider, Promise<RadarMetadataPayload>>();

function roundToFiveMinutesSec(sec: number): number {
  return Math.floor(sec / 300) * 300;
}

function buildDwdFrames(startSec: number, endSec: number): RadarFrame[] {
  const nowBucketSec = roundToFiveMinutesSec(Math.floor(Date.now() / 1000));
  const twoHoursAgo = nowBucketSec - 2 * 3600;
  const effectiveStart = roundToFiveMinutesSec(Math.max(startSec, twoHoursAgo));
  const effectiveEnd = roundToFiveMinutesSec(endSec);

  const frames: RadarFrame[] = [];
  for (let ts = effectiveStart; ts <= effectiveEnd; ts += 300) {
    const kind: RadarFrame['kind'] =
      ts === nowBucketSec ? 'now' : ts > nowBucketSec ? 'forecast' : 'past';
    frames.push({
      timestampSec: ts,
      isoTime: new Date(ts * 1000).toISOString(),
      kind,
    });
  }
  return frames;
}

function findNowFrameIndex(frames: RadarFrame[]): number {
  if (frames.length === 0) return 0;
  const nowIdx = frames.findIndex((f) => f.kind === 'now');
  if (nowIdx >= 0) return nowIdx;
  const nowSec = Math.floor(Date.now() / 1000);
  let bestIdx = frames.length - 1;
  let bestDiff = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const diff = Math.abs(frames[i].timestampSec - nowSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function fetchDwdMetadata(): Promise<RadarMetadataPayload> {
  const capUrl = `${DWD_WMS_URL}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`;
  const reqStart = performance.now();
  const nowBucketSec = roundToFiveMinutesSec(Math.floor(Date.now() / 1000));

  try {
    const res = await fetch(capUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(14000),
    });
    const xml = await res.text();
    const durationMs = Math.max(1, Math.round(performance.now() - reqStart));

    debugLogger.recordApiRequest({
      method: 'GET',
      endpoint: 'dwd/GetCapabilities',
      baseHost: 'maps.dwd.de',
      url: capUrl,
      source: 'weather',
      status: res.status,
      ok: res.ok,
      durationMs,
      bytesReceived: Buffer.byteLength(xml, 'utf8'),
      error: res.ok ? undefined : `HTTP ${res.status}`,
      note: `Radar metadata (${DWD_LAYER})`,
    });

    if (!res.ok) {
      throw new Error(`DWD GeoServer returned HTTP ${res.status}`);
    }

    const layerIdx = xml.indexOf(`<Name>${DWD_LAYER}</Name>`);
    if (layerIdx >= 0) {
      const slice = xml.slice(layerIdx, layerIdx + 5000);
      const dimMatch = slice.match(
        /<Dimension[^>]*name="time"[^>]*>([^<]+)<\/Dimension>/i
      );
      if (dimMatch?.[1]) {
        const parts = dimMatch[1].trim().split('/');
        if (parts.length >= 2) {
          const parsedStart = Math.floor(Date.parse(parts[0]) / 1000);
          const parsedEnd = Math.floor(Date.parse(parts[1]) / 1000);
          if (!Number.isNaN(parsedStart) && !Number.isNaN(parsedEnd) && parsedEnd >= parsedStart) {
            const frames = buildDwdFrames(parsedStart, parsedEnd);
            return {
              provider: 'dwd',
              fetchedAt: Date.now(),
              wmsUrl: DWD_WMS_URL,
              wmsLayer: DWD_LAYER,
              maxNativeZoom: 12,
              frames,
              defaultFrameIndex: findNowFrameIndex(frames),
              attribution: 'Deutscher Wetterdienst (DWD • GeoNutzV)',
              coverageNote:
                'Germany & Central Europe • 1 km resolution • Past 2h + 2h Nowcast (5-min steps)',
            };
          }
        }
      }
    }

    throw new Error('Could not parse DWD radar time dimension');
  } catch (err: any) {
    const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
    debugLogger.recordApiRequest({
      method: 'GET',
      endpoint: 'dwd/GetCapabilities',
      baseHost: 'maps.dwd.de',
      url: capUrl,
      source: 'weather',
      status: null,
      ok: false,
      durationMs,
      bytesReceived: 0,
      error: err?.message || String(err),
      note: 'DWD radar fallback time grid',
    });

    const frames = buildDwdFrames(
      nowBucketSec - 2 * 3600,
      nowBucketSec + 115 * 60
    );
    return {
      provider: 'dwd',
      fetchedAt: Date.now(),
      wmsUrl: DWD_WMS_URL,
      wmsLayer: DWD_LAYER,
      maxNativeZoom: 12,
      frames,
      defaultFrameIndex: findNowFrameIndex(frames),
      attribution: 'Deutscher Wetterdienst (DWD • GeoNutzV)',
      coverageNote:
        'Germany & Central Europe • 1 km resolution • Estimated 5-min schedule (fallback)',
      fallbackUsed: true,
    };
  }
}

async function fetchRainViewerMetadata(): Promise<RadarMetadataPayload> {
  const reqStart = performance.now();
  try {
    const res = await fetch(RAINVIEWER_API_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    const rawText = await res.text();
    const durationMs = Math.max(1, Math.round(performance.now() - reqStart));

    debugLogger.recordApiRequest({
      method: 'GET',
      endpoint: 'rainviewer/weather-maps.json',
      baseHost: 'api.rainviewer.com',
      url: RAINVIEWER_API_URL,
      source: 'weather',
      status: res.status,
      ok: res.ok,
      durationMs,
      bytesReceived: Buffer.byteLength(rawText, 'utf8'),
      rawBody: rawText,
      error: res.ok ? undefined : `HTTP ${res.status}`,
      note: 'RainViewer European/Global radar frames',
    });

    if (!res.ok) {
      throw new Error(`RainViewer API returned HTTP ${res.status}`);
    }

    const json = JSON.parse(rawText);
    const host = String(json?.host || 'https://tilecache.rainviewer.com').replace(
      /\/+$/,
      ''
    );
    const pastRaw: any[] = Array.isArray(json?.radar?.past) ? json.radar.past : [];
    const nowcastRaw: any[] = Array.isArray(json?.radar?.nowcast)
      ? json.radar.nowcast
      : [];

    const frames: RadarFrame[] = [];
    for (let i = 0; i < pastRaw.length; i++) {
      const item = pastRaw[i];
      if (!item?.time || !item?.path) continue;
      frames.push({
        timestampSec: Number(item.time),
        isoTime: new Date(Number(item.time) * 1000).toISOString(),
        kind: i === pastRaw.length - 1 && nowcastRaw.length === 0 ? 'now' : 'past',
        tilePath: String(item.path),
      });
    }
    for (const item of nowcastRaw) {
      if (!item?.time || !item?.path) continue;
      frames.push({
        timestampSec: Number(item.time),
        isoTime: new Date(Number(item.time) * 1000).toISOString(),
        kind: 'forecast',
        tilePath: String(item.path),
      });
    }

    return {
      provider: 'rainviewer',
      fetchedAt: Date.now(),
      host,
      maxNativeZoom: 7,
      frames,
      defaultFrameIndex: Math.max(0, pastRaw.length - 1),
      attribution: 'RainViewer Public API (Personal / Non-Commercial)',
      coverageNote:
        nowcastRaw.length > 0
          ? 'All Europe & Global • Past + Forecast • Max native zoom 7'
          : 'All Europe & Global • Past 2h (10-min steps) • Max native zoom 7',
    };
  } catch (err: any) {
    const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
    debugLogger.recordApiRequest({
      method: 'GET',
      endpoint: 'rainviewer/weather-maps.json',
      baseHost: 'api.rainviewer.com',
      url: RAINVIEWER_API_URL,
      source: 'weather',
      status: null,
      ok: false,
      durationMs,
      bytesReceived: 0,
      error: err?.message || String(err),
      note: 'RainViewer radar frame discovery failed',
    });

    return {
      provider: 'rainviewer',
      fetchedAt: Date.now(),
      maxNativeZoom: 7,
      frames: [],
      defaultFrameIndex: 0,
      attribution: 'RainViewer Public API',
      coverageNote: 'All Europe & Global',
      error: err?.message || 'Failed to load RainViewer radar frames.',
    };
  }
}

/**
 * Fetches and caches live radar timestamps/layers for DWD GeoServer WMS or RainViewer.
 */
export async function getRadarMetadata(
  provider: RadarProvider,
  force = false
): Promise<RadarMetadataPayload> {
  if (!force) {
    const cached = cachedByProvider.get(provider);
    if (
      cached &&
      !cached.error &&
      Date.now() - cached.fetchedAt < METADATA_CACHE_TTL_MS
    ) {
      return cached;
    }
  }

  const existing = inFlightByProvider.get(provider);
  if (existing) {
    return existing;
  }

  const req = (
    provider === 'rainviewer' ? fetchRainViewerMetadata() : fetchDwdMetadata()
  )
    .then((payload) => {
      if (!payload.error) {
        cachedByProvider.set(provider, payload);
      }
      return payload;
    })
    .finally(() => {
      inFlightByProvider.delete(provider);
    });

  inFlightByProvider.set(provider, req);
  return req;
}
