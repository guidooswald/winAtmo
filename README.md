# winAtmo

Native Windows desktop application for **Netatmo Personal Weather Stations** (`NAMain`, `NAModule1` Outdoor, `NAModule2` Wind Anemometer, `NAModule3` Rain Gauge, `NAModule4` Indoor Module, and `NHC` Healthy Home Coach / Smart Indoor Air Quality Monitor), built with Electron, React, TypeScript, and native SQLite (`node:sqlite`).

---

## Screenshots

### Live Sensors & Air Quality Dashboard
![Sensors & Dashboard](docs/screenshots/dashboard.png)

### Flexible Multi-Curve Chart Studio
![Flexible Charts](docs/screenshots/charts.png)

### Floating Windows Taskbar Widget (with 24h Mini-Sparkline Flyout)
![Windows Taskbar Widget](docs/screenshots/widget.png)

### Settings, Local SQLite Time-Series Database & 12 Color Themes
![Settings & SQLite](docs/screenshots/settings.png)

---

## Architecture Overview

![winAtmo Architecture Diagram](docs/screenshots/architecture.png)

winAtmo employs a secure, high-performance multi-process architecture:
- **Netatmo Cloud Layer**: Weather Stations, Modules, and Air Quality sensors synced via REST API and OAuth 2.0 / Web Login.
- **Electron Main Process (Node.js)**: Local high-throughput time-series storage using native `node:sqlite` in WAL mode (`WITHOUT ROWID`), DPAPI credential encryption at rest (`safeStorage`), and background poller.
- **Windows OS Integration**: Native translucent floating Taskbar Widget, System Tray background residency, and dynamic DWM title bar theme synchronization.
- **React 19 & TypeScript Studio**: Real-time sensor cards, custom zero-dependency SVG multi-curve charting studio (up to 10 curves with dual Y-axes), and 12 curated dark/light themes.

---

## Key Features

### 1. Web Login, OAuth 2.0 & DPAPI Security
- **One-Click Netatmo Web Login (`auth.netatmo.com` / `home.netatmo.com`)**: Opens an embedded Netatmo sign-in window, automatically intercepts the authenticated session token (`netatmocomaccess_token` / `Bearer` token), and supports silent background session renewal.
- **Official Netatmo Connect OAuth 2.0 (`api.netatmo.com/oauth2`)**: Full Authorization Code Grant flow with local loopback callback and automatic `refresh_token` rotation (`read_station read_homecoach`).
- **Windows DPAPI Encryption at Rest**: Encrypts stored tokens, session cookies, and OAuth secrets on disk using Electron's `safeStorage` (Windows DPAPI).
- **Personal Access Token & Built-in Demo Mode**: Paste developer tokens directly from [dev.netatmo.com](https://dev.netatmo.com/apidocumentation/weather) or explore the full UI offline using the built-in Demo Station.

### 2. Fast, Lightweight Local SQLite Time-Series Storage
- Powered by Node's native `node:sqlite` (`DatabaseSync`) in WAL (`Write-Ahead Logging`) mode—zero external database servers.
- Uses a clustered **`WITHOUT ROWID`** primary key `(module_id, metric, scale, ts)` for compact storage and sub-millisecond range queries across millions of data points.
- **Incremental Delta Sync**: Automatically tracks downloaded time spans per module and scale (`sync_log`), fetching only missing historical windows or new measurements since the last sync.
- **Configurable History Window**:
  - **Default**: **14 days** of historical sync (`historyDays: 14`).
  - **Configurable up to Netatmo's Maximum**: Presets and slider up to **Maximum Allowed (All History Since Station `date_setup`)** mode that paginates `/api/getmeasure` in 1,024-point chunks back to your station's initial setup date.

### 3. Flexible Multi-Curve Chart Studio
- **Multi-Sensor Comparison**: Plot up to **10 sensor curves** from any station or room simultaneously.
- **Sensor-Aware Quick Presets**: Dynamically generates presets tailored to your connected hardware (*All Temperatures*, *Indoor Temps*, *CO₂ All Rooms*, *Humidity All Rooms*, *Outdoor & Pressure*, *Noise All Rooms*, plus *Wind & Gusts* and *Rain* when present).
- **Overlay (Dual Y-Axis) & Stacked Sub-Charts**: Compare different physical units (e.g., Outdoor Temp `°C` on Left Axis vs. Barometric Pressure `mbar` on Right Axis) or view synchronized stacked panels.
- **Flexible Time Ranges & Resolutions**: Defaults to `7d` view with quick presets (`24h`, `3d`, `7d`, `14d`, `30d`, `90d`, `1Y`, `Max`) and custom date pickers, across `Auto`, `max` (~5 min), `30min`, `1hour`, `3hours`, and `1day` resolutions.
- **Visual Customization & Analysis**:
  - Area, Line, Bar, or Step-Line series styles.
  - Moving Average smoothing, Avg dashed lines, Min/Max pins, drag-to-zoom on the canvas, interactive crosshair inspector, summary statistics cards (`Latest`, `Min`, `Average`, `Max`, `Delta`, `Points`), and one-click **CSV Export**.

### 4. Floating Windows Taskbar Widget & 12 Themes
- **Live Taskbar & System Tray Sensor Reading**: Shows a live single sensor reading (e.g., outside temperature `14°` with semantic status colors) directly in your Windows taskbar tray instead of the static app icon. Fully customizable in settings to outside temp (default), indoor temp, CO₂, humidity, pressure, or any discovered station sensor.
- **Floating Single-Line Taskbar Bar**: Always-on-top, frameless rounded widget that auto-sizes to fit your pinned sensors on a single line, is freely resizable, and includes a **25%–100% Opacity slider**.
- **Smart Upward / Downward 24h Flyout**: Expands upwards when docked near the bottom taskbar and downwards when placed near the top of the screen, restoring its exact position on collapse.
- **12 Popular Dark & Light Color Themes**: Includes *Midnight Slate*, *Catppuccin Mocha*, *Tokyo Night*, *Dracula*, *Nord Polar Night*, *OLED Pitch Black*, *Alpine Daylight*, *Catppuccin Latte*, *Solarized Light*, *Nord Snow Storm*, *Rosé Pine Dawn*, and *GitHub Light* with native Windows dark/light title bar sync.

---

## Netatmo API Reference Implemented

| Endpoint | Usage in winAtmo |
| :--- | :--- |
| `GET /api/getstationsdata` | Loads Weather Station topology (`NAMain`, `NAModule1..4`), live `dashboard_data`, `date_setup`, `last_status_store`, `wifi_status`, `rf_status`, and `battery_vp` / `battery_percent`. |
| `GET /api/gethomecoachsdata` | Loads Healthy Home Coach (`NHC`) indoor air quality devices and live metrics. |
| `GET /api/getmeasure` | Fetches historical time-series (`scale`: `max`, `30min`, `1hour`, `3hours`, `1day`; `limit=1024`; `optimize=false`; `real_time=true`) with automatic pagination across arbitrary time ranges. |
| `GET/POST /oauth2/*` | Official Netatmo Connect OAuth 2.0 Authorization Code & Refresh Token grant flows. |

---

## Getting Started

### Prerequisites
- Windows 10 or Windows 11
- Node.js 22+

### Installation & Build
```powershell
npm install
npm run build
npm start
```
Or double-click **`run.bat`** to build (if needed) and launch the native Windows app.

### Development Mode (Hot Reload)
```powershell
npm run dev
```

---

## License

Released under the [MIT License](LICENSE) • Copyright © 2026 [Guido Oswald](https://guido.swiss)
