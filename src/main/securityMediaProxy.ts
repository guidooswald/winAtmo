import http from 'http';
import crypto from 'crypto';
import { session, net } from 'electron';
import { debugLogger } from './debugLogger';

const NETATMO_PARTITION = 'persist:netatmo';

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m172 = /^172\.(\d+)\./.exec(h);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Resolves relative and absolute URIs inside an HLS `.m3u8` playlist against `baseUrl`
 * and rewrites every media/playlist/key URI to go through the local loopback proxy.
 */
function rewriteM3u8Manifest(
  text: string,
  baseUrl: string,
  makeProxyUrl: (absUrl: string) => string,
  allowUrl: (absUrl: string) => void
): string {
  const resolveAndWrap = (rawUri: string): string => {
    const trimmed = rawUri.trim();
    if (!trimmed) return rawUri;
    try {
      const resolved = new URL(trimmed, baseUrl).toString();
      allowUrl(resolved);
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

  public allowUrlOrigin(targetUrl: string): void {
    try {
      const u = new URL(targetUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        this.allowedOrigins.add(u.origin);
      }
    } catch {}
  }

  private isAllowedTarget(targetUrl: string): boolean {
    try {
      const u = new URL(targetUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (this.allowedOrigins.has(u.origin)) return true;
      const host = u.hostname.toLowerCase();
      if (
        host.endsWith('.netatmo.com') ||
        host.endsWith('.netatmo.net') ||
        host === 'api.netatmo.com' ||
        isPrivateOrLoopbackHost(host)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

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

  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    this.setCorsHeaders(res);

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
      if (
        reqUrl.pathname !== '/proxy' ||
        reqUrl.searchParams.get('token') !== this.secret
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

      const upstream = await fetcher(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });

      const finalUrl = upstream.url || targetUrl;
      this.allowUrlOrigin(finalUrl);

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

      const rawBuf = Buffer.from(await upstream.arrayBuffer());
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
          rawBody: rawText,
          note: 'Security HLS manifest (.m3u8)',
        });
        const rewritten = rewriteM3u8Manifest(
          rawText,
          finalUrl,
          (abs) => this.buildProxyUrl(abs),
          (abs) => this.allowUrlOrigin(abs)
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

  public stop(): void {
    try {
      this.server?.close();
    } catch {}
    this.server = null;
    this.port = null;
  }
}

export const securityMediaProxy = new SecurityMediaProxy();
