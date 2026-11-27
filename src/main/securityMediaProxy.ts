/**
 * @module main/securityMediaProxy
 * Authenticated `127.0.0.1` loopback HTTP proxy for Netatmo camera HLS manifests,
 * video segments, and decryption keys with strict origin allowlisting and byte caps.
 */
import http from 'http';
import crypto from 'crypto';
import { session, net } from 'electron';
import { debugLogger } from './debugLogger';

const NETATMO_PARTITION = 'persist:netatmo';
const MAX_MEDIA_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 3;

/** Rejects localhost, wildcard, and link-local IPv4/IPv6 targets to block SSRF. */
function isDisallowedLoopbackOrLinkLocal(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (h.startsWith('127.') || h.startsWith('169.254.')) return true;
  if (h.startsWith('fe80:') || h.startsWith('::ffff:127.')) return true;
  return false;
}

function isValidLocalCorsOrigin(origin?: string): boolean {
  if (!origin) return false;
  if (origin === 'null') return true; // Electron file:// renderer
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function safeTokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Streams a bounded upstream response body, aborting early if `maxBytes` is exceeded. */
async function readResponseBufferLimited(
  resp: Response,
  maxBytes: number
): Promise<Buffer> {
  const clHeader = resp.headers.get('content-length');
  if (clHeader) {
    const cl = Number(clHeader);
    if (Number.isFinite(cl) && cl > maxBytes) {
      throw new Error(`Upstream media response exceeds ${maxBytes} byte cap`);
    }
  }
  const reader = resp.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Upstream media response exceeds ${maxBytes} byte cap`);
    }
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`Upstream media response exceeds ${maxBytes} byte cap`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Resolves relative and absolute URIs inside an HLS `.m3u8` playlist against `baseUrl`
 * and rewrites allowed media/playlist/key URIs to go through the local loopback proxy.
 */
function rewriteM3u8Manifest(
  text: string,
  baseUrl: string,
  isAllowed: (absUrl: string) => boolean,
  makeProxyUrl: (absUrl: string) => string
): string {
  const resolveAndWrap = (rawUri: string): string => {
    const trimmed = rawUri.trim();
    if (!trimmed) return rawUri;
    try {
      const resolved = new URL(trimmed, baseUrl).toString();
      if (!isAllowed(resolved)) {
        return '#EXT-X-DISALLOWED-URI';
      }
      return makeProxyUrl(resolved);
    } catch {
      return rawUri;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        // Rewrite URI="..." attributes inside tags like #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          return `URI="${resolveAndWrap(uri)}"`;
        });
      }
      return resolveAndWrap(trimmed);
    })
    .join('\n');
}

/**
 * Localhost HTTP proxy used by `hls.js` inside the Electron renderer so Netatmo camera
 * HLS playlists, `.ts`/`.m4s` segments, and decryption keys stream cleanly without CORS,
 * mixed-content blocks, or Node/undici embedded-HTTP-server parser errors.
 */
export class SecurityMediaProxy {
  private server: http.Server | null = null;
  private port: number | null = null;
  private readonly secret: string = crypto.randomBytes(18).toString('hex');
  private readonly allowedOrigins = new Set<string>();
  private startPromise: Promise<string> | null = null;

  /** Registers a camera origin obtained from Netatmo API responses if not loopback/link-local. */
  public allowUrlOrigin(targetUrl: string): void {
    try {
      const u = new URL(targetUrl);
      if (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        !isDisallowedLoopbackOrLinkLocal(u.hostname)
      ) {
        this.allowedOrigins.add(u.origin);
      }
    } catch {}
  }

  /** Checks whether `targetUrl` matches an explicitly registered origin or trusted Netatmo host. */
  private isAllowedTarget(targetUrl: string): boolean {
    try {
      const u = new URL(targetUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      if (isDisallowedLoopbackOrLinkLocal(host)) return false;
      if (this.allowedOrigins.has(u.origin)) return true;
      if (
        host === 'api.netatmo.com' ||
        host === 'netatmo.com' ||
        host.endsWith('.netatmo.com') ||
        host === 'netatmo.net' ||
        host.endsWith('.netatmo.net')
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Starts (or reuses) the ephemeral-port `127.0.0.1` proxy HTTP server. */
  public async ensureStarted(): Promise<string> {
    if (this.server && this.port) {
      return `http://127.0.0.1:${this.port}`;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<string>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      srv.on('error', (err) => {
        this.startPromise = null;
        reject(err);
      });

      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          this.startPromise = null;
          reject(new Error('Failed to bind local HLS media proxy port.'));
          return;
        }
        this.server = srv;
        this.port = addr.port;
        this.startPromise = null;
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    return this.startPromise;
  }

  /** Allowlists `targetUrl`'s origin and returns a tokenized `127.0.0.1` proxy URL for renderer playback. */
  public async toProxyUrl(targetUrl: string): Promise<string> {
    this.allowUrlOrigin(targetUrl);
    const base = await this.ensureStarted();
    return `${base}/proxy?token=${this.secret}&url=${encodeURIComponent(
      targetUrl
    )}`;
  }

  private buildProxyUrl(targetUrl: string): string {
    return `http://127.0.0.1:${this.port}/proxy?token=${this.secret}&url=${encodeURIComponent(
      targetUrl
    )}`;
  }

  private setCorsHeaders(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const reqOrigin =
      typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (isValidLocalCorsOrigin(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin!);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range, Accept-Ranges'
      );
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    this.setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }

    let targetUrl = '';
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const suppliedToken = reqUrl.searchParams.get('token') || '';
      if (
        reqUrl.pathname !== '/proxy' ||
        !safeTokenEquals(suppliedToken, this.secret)
      ) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      targetUrl = reqUrl.searchParams.get('url') || '';
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }

    if (!targetUrl || !this.isAllowedTarget(targetUrl)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Disallowed media target');
      return;
    }

    const forwardHeaders: Record<string, string> = {};
    if (typeof req.headers.range === 'string' && req.headers.range) {
      forwardHeaders['Range'] = req.headers.range;
    }

    const targetHost = (() => {
      try {
        return new URL(targetUrl).host;
      } catch {
        return 'camera';
      }
    })();
    const isHlsPlaylistTarget = /\.m3u8(\?|$)/i.test(targetUrl);
    const reqStart = performance.now();

    try {
      const netatmoSes = session.fromPartition(NETATMO_PARTITION);
      const fetcher =
        netatmoSes && typeof netatmoSes.fetch === 'function'
          ? (input: string, init: RequestInit) => netatmoSes.fetch(input, init)
          : (input: string, init: RequestInit) => net.fetch(input, init);

      let currentUrl = targetUrl;
      let upstream: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        if (!this.isAllowedTarget(currentUrl)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Disallowed redirect target');
          return;
        }
        const candidateRes = await fetcher(currentUrl, {
          method: req.method,
          headers: forwardHeaders,
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
        });
        if (
          candidateRes.status >= 300 &&
          candidateRes.status < 400 &&
          hop < MAX_REDIRECT_HOPS
        ) {
          const loc = candidateRes.headers.get('location');
          if (!loc) {
            upstream = candidateRes;
            break;
          }
          currentUrl = new URL(loc, currentUrl).toString();
          continue;
        }
        upstream = candidateRes;
        break;
      }

      if (!upstream) {
        throw new Error('Too many upstream redirects');
      }

      const finalUrl = currentUrl;
      const contentType = upstream.headers.get('content-type') || '';
      const isPlaylistUrl = /\.m3u8(\?|$)/i.test(finalUrl) || isHlsPlaylistTarget;
      const isPlaylistMime =
        contentType.toLowerCase().includes('mpegurl') ||
        contentType.toLowerCase().includes('x-mpegurl');

      if (!upstream.ok) {
        let snippet = '';
        try {
          snippet = (await upstream.text()).slice(0, 500);
        } catch {}
        const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
        debugLogger.recordApiRequest({
          method: req.method || 'GET',
          endpoint: isPlaylistUrl ? 'hls/manifest' : 'hls/segment',
          baseHost: targetHost,
          url: targetUrl,
          source: 'security',
          status: upstream.status,
          ok: false,
          durationMs,
          bytesReceived: Buffer.byteLength(snippet, 'utf8'),
          rawBody: snippet || undefined,
          error: `HTTP ${upstream.status} ${upstream.statusText || ''}`.trim(),
          note: 'Security HLS video proxy',
        });
        debugLogger.log(
          'warn',
          'SecurityVideo',
          `HLS proxy HTTP ${upstream.status} for ${targetUrl}${
            snippet ? `: ${snippet}` : ''
          }`,
          undefined,
          'security'
        );
        res.writeHead(upstream.status, {
          'Content-Type': contentType || 'text/plain',
        });
        res.end(snippet || upstream.statusText);
        return;
      }

      if (req.method === 'HEAD') {
        const len = upstream.headers.get('content-length');
        res.writeHead(upstream.status, {
          ...(contentType ? { 'Content-Type': contentType } : {}),
          ...(len ? { 'Content-Length': len } : {}),
        });
        res.end();
        return;
      }

      const rawBuf = await readResponseBufferLimited(
        upstream,
        MAX_MEDIA_RESPONSE_BYTES
      );
      const durationMs = Math.max(1, Math.round(performance.now() - reqStart));

      // Detect playlist even if server sends application/octet-stream or text/plain
      const headAscii = rawBuf.subarray(0, 64).toString('utf8').trimStart();
      if (isPlaylistUrl || isPlaylistMime || headAscii.startsWith('#EXTM3U')) {
        const rawText = rawBuf.toString('utf8');
        debugLogger.recordApiRequest({
          method: req.method || 'GET',
          endpoint: 'hls/manifest',
          baseHost: targetHost,
          url: targetUrl,
          source: 'security',
          status: upstream.status,
          ok: true,
          durationMs,
          bytesReceived: rawBuf.byteLength,
          rawBody: JSON.stringify(
            {
              lines: rawText.split(/\r?\n/).length,
              bytes: rawBuf.byteLength,
            },
            null,
            2
          ),
          note: 'Security HLS manifest (.m3u8)',
        });
        const rewritten = rewriteM3u8Manifest(
          rawText,
          finalUrl,
          (abs) => this.isAllowedTarget(abs),
          (abs) => this.buildProxyUrl(abs)
        );
        const outBuf = Buffer.from(rewritten, 'utf8');
        res.writeHead(upstream.status, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Content-Length': String(outBuf.byteLength),
          'Cache-Control': 'no-store',
        });
        res.end(outBuf);
        return;
      }

      debugLogger.recordApiRequest({
        method: req.method || 'GET',
        endpoint: 'hls/segment',
        baseHost: targetHost,
        url: targetUrl,
        source: 'security',
        status: upstream.status,
        ok: true,
        durationMs,
        bytesReceived: rawBuf.byteLength,
        rawBody: JSON.stringify(
          {
            contentType: contentType || 'video/mp2t',
            bytes: rawBuf.byteLength,
            finalUrl,
          },
          null,
          2
        ),
        note: 'Security HLS video segment',
      });

      const outHeaders: Record<string, string> = {
        'Content-Type': contentType || 'video/mp2t',
        'Content-Length': String(rawBuf.byteLength),
      };
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) outHeaders['Content-Range'] = contentRange;
      const acceptRanges = upstream.headers.get('accept-ranges');
      if (acceptRanges) outHeaders['Accept-Ranges'] = acceptRanges;

      res.writeHead(upstream.status, outHeaders);
      res.end(rawBuf);
    } catch (err: any) {
      const msg = err?.message || String(err);
      const durationMs = Math.max(1, Math.round(performance.now() - reqStart));
      debugLogger.recordApiRequest({
        method: req.method || 'GET',
        endpoint: isHlsPlaylistTarget ? 'hls/manifest' : 'hls/segment',
        baseHost: targetHost,
        url: targetUrl,
        source: 'security',
        status: null,
        ok: false,
        durationMs,
        bytesReceived: 0,
        error: msg,
        note: 'Security HLS video proxy',
      });
      debugLogger.log(
        'error',
        'SecurityVideo',
        `HLS proxy error for ${targetUrl}: ${msg}`,
        undefined,
        'security'
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(msg);
    }
  }

  /** Stops the local HLS media proxy server. */
  public stop(): void {
    try {
      this.server?.close();
    } catch {}
    this.server = null;
    this.port = null;
  }
}

/** Singleton HLS media proxy shared by live camera streams and recorded VOD playback. */
export const securityMediaProxy = new SecurityMediaProxy();
