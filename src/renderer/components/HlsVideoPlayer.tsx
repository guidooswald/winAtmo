import React, { useEffect, useMemo, useRef, useState } from 'react';
import Hls, {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from 'hls.js';
import { AlertTriangle, Film, RefreshCw } from 'lucide-react';

interface HlsVideoPlayerProps {
  hlsUrl?: string;
  fallbackUrls?: string[];
  posterUrl?: string;
  isDemo?: boolean;
  onRetryResolve?: () => void;
}

function createEmptyStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

/**
 * Custom hls.js loader that fetches manifests and media segments through Electron main IPC
 * so Netatmo VPN / LAN camera streams avoid browser CORS and mixed-content restrictions.
 */
class IpcHlsLoader implements Loader<LoaderContext> {
  public context: LoaderContext | null = null;
  public stats: LoaderStats = createEmptyStats();
  private aborted = false;
  private lastContentType: string | null = null;

  public abort(): void {
    this.aborted = true;
    this.stats.aborted = true;
  }

  public destroy(): void {
    this.abort();
    this.context = null;
  }

  public getCacheAge(): number | null {
    return null;
  }

  public getResponseHeader(name: string): string | null {
    if (name.toLowerCase() === 'content-type') {
      return this.lastContentType;
    }
    return null;
  }

  public load(
    context: LoaderContext,
    _config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>
  ): void {
    this.context = context;
    this.aborted = false;
    const now = performance.now();
    this.stats = createEmptyStats();
    this.stats.loading.start = now;

    const wantBinary = context.responseType === 'arraybuffer';

    window.winatmo
      .fetchSecurityMedia({
        url: context.url,
        responseType: wantBinary ? 'arraybuffer' : 'text',
        headers: context.headers,
        rangeStart: context.rangeStart,
        rangeEnd: context.rangeEnd,
      })
      .then((res) => {
        if (this.aborted) {
          callbacks.onAbort?.(this.stats, context, null);
          return;
        }

        const doneAt = performance.now();
        this.stats.loading.first = doneAt;
        this.stats.loading.end = doneAt;
        this.lastContentType = res.contentType || null;

        if (!res.ok) {
          callbacks.onError(
            {
              code: res.status || 500,
              text: res.error || res.statusText || 'Failed to load stream',
            },
            context,
            null,
            this.stats
          );
          return;
        }

        let payload: string | ArrayBuffer;
        let byteLen = 0;

        if (wantBinary) {
          const view = res.dataBuffer
            ? new Uint8Array(res.dataBuffer)
            : new Uint8Array(0);
          byteLen = view.byteLength;
          payload = view.buffer.slice(
            view.byteOffset,
            view.byteOffset + view.byteLength
          );
        } else {
          const text = res.dataText ?? '';
          byteLen = text.length;
          payload = text;
        }

        this.stats.loaded = byteLen;
        this.stats.total = byteLen;
        this.stats.chunkCount = 1;

        callbacks.onSuccess(
          {
            url: res.finalUrl || context.url,
            data: payload,
            code: res.status,
            text: res.statusText,
          },
          this.stats,
          context,
          null
        );
      })
      .catch((err: any) => {
        if (this.aborted) return;
        callbacks.onError(
          {
            code: 0,
            text: err?.message || String(err),
          },
          context,
          null,
          this.stats
        );
      });
  }
}

export const HlsVideoPlayer: React.FC<HlsVideoPlayerProps> = ({
  hlsUrl,
  fallbackUrls = [],
  posterUrl,
  isDemo,
  onRetryResolve,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const candidateList = useMemo(() => {
    const out: string[] = [];
    for (const u of [hlsUrl, ...fallbackUrls]) {
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  }, [hlsUrl, fallbackUrls]);

  const [candidateIndex, setCandidateIndex] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
    setPlayerError(null);
  }, [hlsUrl, fallbackUrls]);

  const activeUrl = candidateList[candidateIndex];

  useEffect(() => {
    if (isDemo || !activeUrl || !videoRef.current) return;

    const videoEl = videoRef.current;
    setBuffering(true);
    setPlayerError(null);

    let hls: Hls | null = null;
    let cancelled = false;

    if (Hls.isSupported()) {
      hls = new Hls({
        loader: IpcHlsLoader as unknown as typeof Hls.DefaultConfig.loader,
        enableWorker: false,
        startLevel: -1,
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (cancelled) return;
        setBuffering(false);
        videoEl.play().catch(() => {
          // Autoplay may be deferred; user still has native controls
        });
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (cancelled || !data.fatal) return;
        if (candidateIndex + 1 < candidateList.length) {
          hls?.destroy();
          setCandidateIndex((prev) => prev + 1);
          return;
        }
        setBuffering(false);
        setPlayerError(
          data.details
            ? `Stream error (${data.details})`
            : 'Unable to decode or stream this Netatmo video clip.'
        );
      });

      hls.loadSource(activeUrl);
      hls.attachMedia(videoEl);
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = activeUrl;
      videoEl.onloadedmetadata = () => {
        if (cancelled) return;
        setBuffering(false);
        videoEl.play().catch(() => {});
      };
      videoEl.onerror = () => {
        if (cancelled) return;
        setBuffering(false);
        setPlayerError('Video stream could not be played in this runtime.');
      };
    } else {
      setBuffering(false);
      setPlayerError('HLS playback is not supported in this browser runtime.');
    }

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [activeUrl, candidateIndex, candidateList.length, isDemo, reloadNonce]);

  if (isDemo) {
    return (
      <div className="security-video-demo-box">
        <Film size={32} />
        <strong>Demo Recorded Clip Preview</strong>
        <p>
          In live Netatmo mode, recorded camera events stream directly from the
          camera&apos;s HLS VOD endpoint (
          <code>{'{vpn_url}/vod/{video_id}/index.m3u8'}</code>).
        </p>
      </div>
    );
  }

  return (
    <div className="security-video-player-wrap">
      <video
        ref={videoRef}
        className="security-video-element"
        controls
        playsInline
        poster={posterUrl}
      />

      {buffering && !playerError && (
        <div className="security-video-overlay-state">
          <RefreshCw size={22} className="spin" />
          <span>Loading Netatmo video stream...</span>
        </div>
      )}

      {playerError && (
        <div className="security-video-overlay-state error">
          <AlertTriangle size={22} />
          <span>{playerError}</span>
          <button
            type="button"
            className="action-btn subtle"
            onClick={() => {
              if (onRetryResolve) {
                onRetryResolve();
              } else {
                setCandidateIndex(0);
                setReloadNonce((n) => n + 1);
              }
            }}
          >
            <RefreshCw size={13} /> Retry Video
          </button>
        </div>
      )}
    </div>
  );
};
