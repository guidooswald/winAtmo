import React, { useEffect, useState, useRef } from 'react';
import { RefreshCw, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { SyncProgress } from '../types';

interface SyncOverlayWindowProps {
  progress: SyncProgress;
  onDismiss?: () => void;
}

export const SyncOverlayWindow: React.FC<SyncOverlayWindowProps> = ({
  progress,
  onDismiss,
}) => {
  const [visible, setVisible] = useState<boolean>(false);
  const [dismissed, setDismissed] = useState<boolean>(false);
  const prevActiveRef = useRef<boolean>(progress.active);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (progress.active) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setDismissed(false);
      setVisible(true);
    } else if (prevActiveRef.current && !progress.active) {
      // Transitioned from active -> complete / error
      if (progress.phase === 'done' || progress.phase === 'error') {
        setVisible(true);
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
        }
        hideTimerRef.current = setTimeout(
          () => {
            setVisible(false);
          },
          progress.phase === 'error' ? 5000 : 2800
        );
      } else {
        setVisible(false);
      }
    }
    prevActiveRef.current = progress.active;
  }, [progress.active, progress.phase]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  if (!visible || dismissed) return null;

  const isDone =
    progress.phase === 'done' || (!progress.active && !progress.error);
  const isError = progress.phase === 'error' || !!progress.error;
  const isIndeterminate =
    progress.phase === 'stations' || progress.totalModules === 0;

  const percent =
    progress.totalModules > 0
      ? Math.min(
          100,
          Math.round((progress.completedModules / progress.totalModules) * 100)
        )
      : isDone
      ? 100
      : 15;

  const handleClose = () => {
    setDismissed(true);
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    onDismiss?.();
  };

  return (
    <aside
      className={`sync-overlay-window ${isDone ? 'is-done' : ''} ${
        isError ? 'is-error' : ''
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="sync-overlay-header">
        <div className="sync-overlay-title-group">
          <div
            className={`sync-overlay-icon-box ${
              isDone ? 'done' : isError ? 'error' : 'syncing'
            }`}
          >
            {isDone ? (
              <CheckCircle2 size={16} />
            ) : isError ? (
              <AlertCircle size={16} />
            ) : (
              <RefreshCw size={15} className="spin" />
            )}
          </div>
          <div>
            <h4 className="sync-overlay-title">
              {isDone
                ? 'Sync Complete'
                : isError
                ? 'Sync Failed'
                : progress.phase === 'stations'
                ? 'Refreshing Sensors...'
                : 'Downloading Data...'}
            </h4>
            <span className="sync-overlay-phase">
              {isDone
                ? 'Database updated'
                : isError
                ? 'Operation failed'
                : progress.phase === 'stations'
                ? 'Live telemetry'
                : `History (${percent}%)`}
            </span>
          </div>
        </div>
        <button
          className="sync-overlay-close-btn"
          onClick={handleClose}
          title="Dismiss sync overlay"
          aria-label="Close sync overlay"
        >
          <X size={14} />
        </button>
      </div>

      <p className="sync-overlay-message" title={progress.message}>
        {progress.message}
      </p>

      <div className="sync-overlay-progress-track">
        <div
          className={`sync-overlay-progress-bar ${
            isIndeterminate ? 'indeterminate' : ''
          } ${isDone ? 'done' : isError ? 'error' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="sync-overlay-footer">
        <span className="sync-footer-item">
          {progress.totalModules > 0 ? (
            <>
              <strong>{progress.completedModules}</strong>/
              {progress.totalModules} sensors
            </>
          ) : (
            'Preparing request...'
          )}
        </span>
        {progress.pointsStored > 0 && (
          <span className="sync-footer-item points">
            +{progress.pointsStored.toLocaleString()} points
          </span>
        )}
      </div>
    </aside>
  );
};
