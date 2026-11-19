import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';
import { debugLogger } from './debugLogger';
import {
  RadarFrame,
  RadarMetadataPayload,
  RadarProvider,
} from '../renderer/types';

const DWD_WMS_URL = 'https://maps.dwd.de/geoserver/dwd/wms';
const DWD_PAST_LAYER = 'RADOLAN-RY';
const DWD_FORECAST_LAYER = 'Radar_rv_product_1x1km_ger';
const RAINVIEWER_API_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const METADATA_CACHE_TTL_MS = 4 * 60 * 1000;
const TILE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours max
const TILE_CACHE_MAX_DISK_BYTES = 250 * 1024 * 1024;
const TILE_MEM_CACHE_MAX_ENTRIES = 320;

const cachedByProvider = new Map<RadarProvider, RadarMetadataPayload>();
const inFlightByProvider = new Map<RadarProvider, Promise<RadarMetadataPayload>>();

interface CachedTileEntry {
  data: Buffer;
  contentType: string;
  cachedAt: number;
}

const memTileCache = new Map<string, CachedTileEntry>();
const inFlightTileFetches = new Map<string, Promise<CachedTileEntry | null>>();

let cacheServer: http.Server | null = null;
let cacheServerPort: number | null = null;
let cacheServerStartPromise: Promise<string> | null = null;
let lastPruneAt = 0;

function getTileCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'radar-cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function hashUrl(targetUrl: string): string {
  return crypto.createHash('sha1').update(targetUrl).digest('hex');
}

function isAllowedRadarOrMapHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return (
      h === 'maps.dwd.de' ||
      h === 'api.rainviewer.com' ||
      h === 'tilecache.rainviewer.com' ||
      h.endsWith('.rainviewer.com') ||
      h === 'tile.openstreetmap.org' ||
      h.endsWith('.tile.openstreetmap.org') ||
      h === 'tile.opentopomap.org' ||
      h.endsWith('.tile.opentopomap.org') ||
      h === 'server.arcgisonline.com' ||
      h === 'services.arcgisonline.com'
    );
  } catch {
    return false;
  }
}

function putMemTile(hash: string, entry: CachedTileEntry): void {
  if (memTileCache.has(hash)) {
    memTileCache.delete(hash);
  }
  memTileCache.set(hash, entry);
  while (memTileCache.size > TILE_MEM_CACHE_MAX_ENTRIES) {
    const oldestKey = memTileCache.keys().next().value;
    if (!oldestKey) break;
    memTileCache.delete(oldestKey);
  }
}

function getFreshTileFromCache(targetUrl: string): CachedTileEntry | null {
  const now = Date.now();
  const hash = hashUrl(targetUrl);

  const memHit = memTileCache.get(hash);
  if (memHit) {
    if (now - memHit.cachedAt < TILE_CACHE_MAX_AGE_MS) {
      // Refresh LRU position
      putMemTile(hash, memHit);
      return memHit;
    }
    memTileCache.delete(hash);
  }

  try {
    const dir = getTileCacheDir();
    const metaPath = path.join(dir, `${hash}.json`);
    const binPath = path.join(dir, `${hash}.bin`);
    if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) {
      return null;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const cachedAt = Number(meta?.cachedAt || 0);
    if (!cachedAt || now - cachedAt >= TILE_CACHE_MAX_AGE_MS) {
      try {
        fs.unlinkSync(metaPath);
        fs.unlinkSync(binPath);
      } catch {}
      return null;
    }
    const data = fs.readFileSync(binPath);
    const entry: CachedTileEntry = {
      data,
      contentType: String(meta?.contentType || 'image/png'),
      cachedAt,
    };
    putMemTile(hash, entry);
    return entry;
  } catch {
    return null;
  }
}

function writeTileToCache(targetUrl: string, entry: CachedTileEntry): void {
  const hash = hashUrl(targetUrl);
  putMemTile(hash, entry);
  try {
    const dir = getTileCacheDir();
    fs.writeFileSync(path.join(dir, `${hash}.bin`), entry.data);
    fs.writeFileSync(
      path.join(dir, `${hash}.json`),
      JSON.stringify({
        contentType: entry.contentType,
        cachedAt: entry.cachedAt,
      })
    );
  } catch {}
  maybePruneDiskCache();
}

function maybePruneDiskCache(): void {
  const now = Date.now();
  if (now - lastPruneAt < 10 * 60 * 1000) return;
  lastPruneAt = now;

  setImmediate(() => {
    try {
      const dir = getTileCacheDir();
      const entries = fs.readdirSync(dir);
      const records: Array<{ hash: string; cachedAt: number; size: number }> = [];
      let totalSize = 0;

      for (const file of entries) {
        if (!file.endsWith('.json')) continue;
        const hash = file.slice(0, -5);
        const metaPath = path.join(dir, file);
        const binPath = path.join(dir, `${hash}.bin`);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          const cachedAt = Number(meta?.cachedAt || 0);
          if (!cachedAt || now - cachedAt >= TILE_CACHE_MAX_AGE_MS || !fs.existsSync(binPath)) {
            fs.unlinkSync(metaPath);
            if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
            continue;
          }
          const st = fs.statSync(binPath);
          totalSize += st.size;
          records.push({ hash, cachedAt, size: st.size });
        } catch {
          try {
            fs.unlinkSync(metaPath);
            if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
          } catch {}
        }
      }

      if (totalSize > TILE_CACHE_MAX_DISK_BYTES) {
        records.sort((a, b) => a.cachedAt - b.cachedAt);
        for (const rec of records) {
          if (totalSize <= TILE_CACHE_MAX_DISK_BYTES * 0.8) break;
          try {
            fs.unlinkSync(path.join(dir, `${rec.hash}.json`));
            fs.unlinkSync(path.join(dir, `${rec.hash}.bin`));
            memTileCache.delete(rec.hash);
            totalSize -= rec.size;
          } catch {}
        }
      }
    } catch {}
  });
}

async function fetchAndCacheTile(targetUrl: string): Promise<CachedTileEntry | null> {
  const cached = getFreshTileFromCache(targetUrl);
  if (cached) return cached;

  const existing = inFlightTileFetches.get(targetUrl);
  if (existing) return existing;

  const req = (async (): Promise<CachedTileEntry | null> => {
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'winAtmo/0.3.0 (Desktop Weather Studio)',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        return null;
      }
      const ct = (res.headers.get('content-type') || 'image/png').toLowerCase();
      if (!ct.startsWith('image/')) {
        return null;
      }
      const ab = await res.arrayBuffer();
      const data = Buffer.from(ab);
      if (data.byteLength === 0) return null;

      const entry: CachedTileEntry = {
        data,
        contentType: ct.split(';')[0].trim(),
        cachedAt: Date.now(),
      };
      writeTileToCache(targetUrl, entry);
      return entry;
    } catch {
      return null;
    } finally {
      inFlightTileFetches.delete(targetUrl);
    }
  })();

  inFlightTileFetches.set(targetUrl, req);
  return req;
}

export async function ensureRadarCacheServerStarted(): Promise<string> {
  if (cacheServer && cacheServerPort) {
    return `http://127.0.0.1:${cacheServerPort}`;
  }
  if (cacheServerStartPromise) {
    return cacheServerStartPromise;
  }

  cacheServerStartPromise = new Promise<string>((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      try {
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        if (parsed.pathname !== '/tile') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const targetUrl = parsed.searchParams.get('u');
        if (!targetUrl || !isAllowedRadarOrMapHost(targetUrl)) {
          res.writeHead(403);
          res.end('Forbidden tile host');
          return;
        }

        const cachedBefore = getFreshTileFromCache(targetUrl);
        const entry = cachedBefore || (await fetchAndCacheTile(targetUrl));
        if (!entry) {
          res.writeHead(404);
          res.end('Tile unavailable');
          return;
        }

        res.writeHead(200, {
          'Content-Type': entry.contentType,
          'Content-Length': entry.data.byteLength,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
          'X-WinAtmo-Cache': cachedBefore ? 'HIT' : 'MISS',
        });
        res.end(entry.data);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Proxy error');
        }
      }
    });

    srv.on('error', (err) => {
      cacheServerStartPromise = null;
      reject(err);
    });

    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        cacheServerStartPromise = null;
        reject(new Error('Failed to bind radar tile cache server'));
        return;
      }
      cacheServer = srv;
      cacheServerPort = addr.port;
      maybePruneDiskCache();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  return cacheServerStartPromise;
}

export function stopRadarCacheServer(): void {
  if (cacheServer) {
    try {
      cacheServer.close();
    } catch {}
    cacheServer = null;
    cacheServerPort = null;
    cacheServerStartPromise = null;
  }
}

/**
 * Checks which of the supplied raw tile URLs already have a fresh (<24h) cached entry.
 */
export function checkCachedRadarUrls(rawUrls: string[]): string[] {
  const hits: string[] = [];
  for (const url of rawUrls) {
    if (url && getFreshTileFromCache(url)) {
      hits.push(url);
    }
  }
  return hits;
}

function roundToFiveMinutesSec(sec: number): number {
  return Math.floor(sec / 300) * 300;
}

function buildDwdFrames(
  startSec: number,
  nowSec: number,
  endSec: number
): RadarFrame[] {
  const nowBucketSec = roundToFiveMinutesSec(nowSec);
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
      wmsLayer: kind === 'forecast' ? DWD_FORECAST_LAYER : DWD_PAST_LAYER,
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

async function fetchDwdMetadata(cacheProxyUrl: string): Promise<RadarMetadataPayload> {
  // Fast RADOLAN-RY layer GetCapabilities (~11 KB, <200ms) gives live observation time up to NOW;
  // past+now frames use fast RADOLAN-RY while future forecast steps use Radar_rv_product_1x1km_ger.
  const capUrl = `https://maps.dwd.de/geoserver/dwd/${DWD_PAST_LAYER}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`;
  const reqStart = performance.now();
  const fallbackNowSec = roundToFiveMinutesSec(Math.floor(Date.now() / 1000) - 300);

  try {
    const res = await fetch(capUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(12000),
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
      note: `Radar metadata (${DWD_PAST_LAYER})`,
    });

    if (!res.ok) {
      throw new Error(`DWD GeoServer returned HTTP ${res.status}`);
    }

    const layerIdx = xml.indexOf(`<Name>${DWD_PAST_LAYER}</Name>`);
    if (layerIdx >= 0) {
      const slice = xml.slice(layerIdx, layerIdx + 5000);
      const dimMatch = slice.match(
        /<Dimension[^>]*name="time"[^>]*>([^<]+)<\/Dimension>/i
      );
      if (dimMatch?.[1]) {
        const parts = dimMatch[1].trim().split('/');
        if (parts.length >= 2) {
          const parsedStart = Math.floor(Date.parse(parts[0]) / 1000);
          const parsedLatestObs = Math.floor(Date.parse(parts[1]) / 1000);
          if (
            !Number.isNaN(parsedStart) &&
            !Number.isNaN(parsedLatestObs) &&
            parsedLatestObs >= parsedStart
          ) {
            const frames = buildDwdFrames(
              parsedStart,
              parsedLatestObs,
              parsedLatestObs + 2 * 3600
            );
            return {
              provider: 'dwd',
              fetchedAt: Date.now(),
              cacheProxyUrl,
              wmsUrl: DWD_WMS_URL,
              wmsLayer: DWD_PAST_LAYER,
              maxNativeZoom: 12,
              frames,
              defaultFrameIndex: findNowFrameIndex(frames),
              attribution: 'Deutscher Wetterdienst (DWD • GeoNutzV)',
              coverageNote:
                'Germany & Central Europe • Fast RADOLAN Past 2h + 2h Nowcast (5-min steps • 24h cache)',
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
      fallbackNowSec - 2 * 3600,
      fallbackNowSec,
      fallbackNowSec + 115 * 60
    );
    return {
      provider: 'dwd',
      fetchedAt: Date.now(),
      cacheProxyUrl,
      wmsUrl: DWD_WMS_URL,
      wmsLayer: DWD_PAST_LAYER,
      maxNativeZoom: 12,
      frames,
      defaultFrameIndex: findNowFrameIndex(frames),
      attribution: 'Deutscher Wetterdienst (DWD • GeoNutzV)',
      coverageNote:
        'Germany & Central Europe • Fast RADOLAN • Estimated 5-min schedule (24h cache)',
      fallbackUsed: true,
    };
  }
}

async function fetchRainViewerMetadata(
  cacheProxyUrl: string
): Promise<RadarMetadataPayload> {
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
      cacheProxyUrl,
      host,
      maxNativeZoom: 7,
      frames,
      defaultFrameIndex: Math.max(0, pastRaw.length - 1),
      attribution: 'RainViewer Public API (Personal / Non-Commercial)',
      coverageNote:
        nowcastRaw.length > 0
          ? 'All Europe & Global • Past + Forecast • 24h image cache'
          : 'All Europe & Global • Past 2h (10-min steps) • Max native zoom 7 • 24h cache',
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
      cacheProxyUrl,
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
 * Fetches and caches live radar timestamps/layers for DWD GeoServer WMS or RainViewer,
 * ensuring the local 24h tile cache HTTP proxy is active and returned as `cacheProxyUrl`.
 */
export async function getRadarMetadata(
  provider: RadarProvider,
  force = false
): Promise<RadarMetadataPayload> {
  const cacheProxyUrl = await ensureRadarCacheServerStarted();

  if (!force) {
    const cached = cachedByProvider.get(provider);
    if (
      cached &&
      !cached.error &&
      Date.now() - cached.fetchedAt < METADATA_CACHE_TTL_MS
    ) {
      return { ...cached, cacheProxyUrl };
    }
  }

  const existing = inFlightByProvider.get(provider);
  if (existing) {
    return existing;
  }

  const req = (
    provider === 'rainviewer'
      ? fetchRainViewerMetadata(cacheProxyUrl)
      : fetchDwdMetadata(cacheProxyUrl)
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
