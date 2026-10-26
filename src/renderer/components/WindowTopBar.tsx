import React, { useEffect, useState } from 'react';
import { CloudSun, Palette } from 'lucide-react';
import { ThemeId } from '../types';
import { THEMES } from '../utils/themes';

interface WindowTopBarProps {
  title?: string;
  subtitle?: string;
  activeStationName?: string;
  currentTheme?: ThemeId;
  onThemeChange?: (theme: ThemeId) => void;
}

const MinimizeIcon: React.FC = () => (
  <svg width="11" height="1.5" viewBox="0 0 11 1.5" fill="currentColor">
    <rect width="11" height="1.5" rx="0.75" />
  </svg>
);

const MaximizeIcon: React.FC = () => (
  <svg
    width="10"
    height="10"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
  >
    <rect x="1.5" y="1.5" width="11" height="11" rx="1" />
  </svg>
);

const RestoreIcon: React.FC = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
  >
    <rect x="1.5" y="4.5" width="10" height="10" rx="1" />
    <path d="M4.5 4.5V2.5C4.5 1.95 4.95 1.5 5.5 1.5H13.5C14.05 1.5 14.5 1.95 14.5 2.5V10.5C14.5 11.05 14.05 11.5 13.5 11.5H11.5" />
  </svg>
);

const CloseIcon: React.FC = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <path d="M1.5 1.5L12.5 12.5M1.5 12.5L12.5 1.5" />
  </svg>
);

export const WindowTopBar: React.FC<WindowTopBarProps> = ({
  title = 'winAtmo',
  subtitle = 'Netatmo Weather & Air Quality Studio',
  activeStationName,
  currentTheme,
  onThemeChange,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (window.winatmo?.isMaximized) {
      window.winatmo.isMaximized().then(setIsMaximized).catch(() => {});
    }
    if (window.winatmo?.onMaximizedChange) {
      const unsub = window.winatmo.onMaximizedChange((max) => {
        setIsMaximized(max);
      });
      return unsub;
    }
  }, []);

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.winatmo?.minimizeWindow();
  };

  const handleMaximize = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.winatmo?.maximizeWindow();
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.winatmo?.closeWindow();
  };

  const handleDoubleClick = () => {
    window.winatmo?.maximizeWindow();
  };

  const darkThemes = THEMES.filter((t) => t.mode === 'dark');
  const lightThemes = THEMES.filter((t) => t.mode === 'light');

  return (
    <div className="window-topbar" onDoubleClick={handleDoubleClick}>
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

        <div className="window-topbar-right">
          {currentTheme && onThemeChange && (
            <div className="window-topbar-theme-group">
              <Palette size={12} className="topbar-theme-palette-icon" />
              <select
                className="topbar-theme-select"
                value={currentTheme}
                onChange={(e) => onThemeChange(e.target.value as ThemeId)}
                title="Switch complete visual theme & density"
              >
                <optgroup label="Dark Themes">
                  {darkThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      🌙 {t.familyTitle}: {t.name} (
                      {t.styleLabel.split('•')[0].trim()})
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Light Themes">
                  {lightThemes.map((t) => (
                    <option key={t.id} value={t.id}>
                      ☀️ {t.familyTitle}: {t.name} (
                      {t.styleLabel.split('•')[0].trim()})
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
          )}

          <div className="window-topbar-controls">
            <button
              className="window-control-btn min"
              onClick={handleMinimize}
              title="Minimize"
              type="button"
              tabIndex={-1}
            >
              <MinimizeIcon />
            </button>
            <button
              className="window-control-btn max"
              onClick={handleMaximize}
              title={isMaximized ? 'Restore Down' : 'Maximize'}
              type="button"
              tabIndex={-1}
            >
              {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
            <button
              className="window-control-btn close"
              onClick={handleClose}
              title="Close"
              type="button"
              tabIndex={-1}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
