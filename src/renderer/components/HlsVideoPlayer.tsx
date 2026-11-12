import React, { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertTriangle, Film, RefreshCw } from 'lucide-react';

interface HlsVideoPlayerProps {
  hlsUrl?: string;
  fallbackUrls?: string[];
  posterUrl?: string;
  isDemo?: boolean;
  onRetryResolve?: () => void;
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
    let networkRecoveries = 0;
    let mediaRecoveries = 0;

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: false,
        startLevel: -1,
        fragLoadingTimeOut: 30000,
        manifestLoadingTimeOut: 25000,
        levelLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 3,
        fragLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 3,
        manifestLoadingMaxRetry: 2,
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (cancelled) return;
        setBuffering(false);
        videoEl.play().catch(() => {
          // Autoplay may be deferred; user still has native controls
        });
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (!cancelled) {
          setBuffering(false);
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (cancelled || !data.fatal) return;

        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          networkRecoveries < 1
        ) {
          networkRecoveries++;
          hls?.startLoad();
          return;
        }

        if (
          data.type === Hls.ErrorTypes.MEDIA_ERROR &&
          mediaRecoveries < 1
        ) {
          mediaRecoveries++;
          hls?.recoverMediaError();
          return;
        }

        if (candidateIndex + 1 < candidateList.length) {
          hls?.destroy();
          setCandidateIndex((prev) => prev + 1);
          return;
        }

        setBuffering(false);
        const parts: string[] = [String(data.details || 'playbackError')];
        if (data.response?.code) parts.push(`HTTP ${data.response.code}`);
        if (data.reason) parts.push(data.reason);
        setPlayerError(`Stream error (${parts.join(' • ')})`);
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
        if (candidateIndex + 1 < candidateList.length) {
          setCandidateIndex((prev) => prev + 1);
          return;
        }
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
