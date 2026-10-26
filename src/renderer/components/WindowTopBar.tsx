import React, { useEffect, useState } from 'react';
import { CloudSun, Minus, Square, Copy, X } from 'lucide-react';

interface WindowTopBarProps {
  title?: string;
  subtitle?: string;
  activeStationName?: string;
}

export const WindowTopBar: React.FC<WindowTopBarProps> = ({
  title = 'winAtmo',
  subtitle = 'Netatmo Weather & Air Quality Studio',
  activeStationName,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const platform = window.winatmo?.platform || 'win32';
  const isWindows = platform === 'win32';

  useEffect(() => {
    if (!window.winatmo?.isMaximized) return;
    window.winatmo.isMaximized().then(setIsMaximized).catch(() => {});
  }, []);

  const handleMinimize = () => {
    window.winatmo?.minimizeWindow();
  };

  const handleMaximize = () => {
    window.winatmo?.maximizeWindow();
    setIsMaximized((prev) => !prev);
  };

  const handleClose = () => {
    window.winatmo?.closeWindow();
  };

  return (
    <div
      className={`window-topbar ${
        isWindows ? 'is-windows' : 'is-custom-controls'
      }`}
    >
      <div className="window-topbar-drag">
        <div className="window-topbar-left">
          <div className="window-topbar-brand">
            <CloudSun size={14} className="window-topbar-icon" />
            <span className="window-topbar-app-name">{title}</span>
          </div>
          {subtitle && (
            <>
              <span className="window-topbar-separator">—</span>
              <span className="window-topbar-subtitle">{subtitle}</span>
            </>
          )}
        </div>

        {activeStationName && (
          <div className="window-topbar-center">
            <span className="window-topbar-station-badge">
              <span className="topbar-station-dot" />
              <span>{activeStationName}</span>
            </span>
          </div>
        )}

        {/* On non-Windows platforms or web fallback, render HTML window control buttons */}
        {!isWindows && (
          <div className="window-topbar-controls">
            <button
              className="window-control-btn min"
              onClick={handleMinimize}
              title="Minimize"
              type="button"
            >
              <Minus size={13} />
            </button>
            <button
              className="window-control-btn max"
              onClick={handleMaximize}
              title={isMaximized ? 'Restore Down' : 'Maximize'}
              type="button"
            >
              {isMaximized ? <Copy size={11} /> : <Square size={11} />}
            </button>
            <button
              className="window-control-btn close"
              onClick={handleClose}
              title="Close"
              type="button"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
