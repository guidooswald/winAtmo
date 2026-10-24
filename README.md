# winAtmo

Native Windows desktop application for **Netatmo Personal Weather Stations** (`NAMain`, `NAModule1` Outdoor, `NAModule2` Wind Anemometer, `NAModule3` Rain Gauge, `NAModule4` Indoor Module, and `NHC` Healthy Home Coach), inspired by **HomeAtmo for macOS** and built against the official [Netatmo Connect API Documentation](https://dev.netatmo.com/apidocumentation).

---

## Key Features

### 1. Web Login & Official Netatmo Connect API Support
- **One-Click Netatmo Web Login (`auth.netatmo.com` / `home.netatmo.com`)**: Opens an embedded Netatmo sign-in window, automatically intercepts the authenticated session token (`netatmocomaccess_token` / `Bearer` token), and supports silent background session renewal.
- **Official Netatmo Connect OAuth 2.0 (`api.netatmo.com/oauth2`)**: Full Authorization Code Grant flow with local loopback callback and automatic `refresh_token` rotation (`read_station read_homecoach`).
- **Personal Access Token & Built-in Demo Mode**: Paste developer tokens directly from [dev.netatmo.com](https://dev.netatmo.com/apidocumentation/weather) or explore the full UI and 30 days of realistic 5-minute weather data using the built-in Demo Station.

### 2. Fast, Lightweight Local SQLite Time-Series Storage
- Powered by Node's native `node:sqlite` (`DatabaseSync`) in WAL (`Write-Ahead Logging`) mode—zero heavy external database servers.
- Uses a clustered **`WITHOUT ROWID`** primary key `(module_id, metric, scale, ts)` for ultra-compact storage (~15–25 bytes per reading) and instant range queries.
- **Incremental Delta Sync**: Automatically tracks downloaded time spans per module and scale (`sync_log`), fetching only missing historical windows or new measurements since the last sync.
- **Configurable History Window**:
  - **Default**: **14 days** of historical data (`historyDays: 14`).
  - **Configurable up to Netatmo's Maximum**: Slider/presets up to 365 days, plus a **Maximum Allowed (All History Since Station `date_setup`)** mode that paginates `/api/getmeasure` in 1,024-point chunks back to the station's initial setup date.

### 3. Flexible Multi-Curve Chart Studio
- **Multi-Sensor Comparison**: Plot up to **6 sensor curves** from any station or module simultaneously.
- **Overlay (Dual Y-Axis) & Stacked Sub-Charts**: Compare different physical units (e.g., Outdoor Temp `°C` on Left Axis vs. Barometric Pressure `hPa` or Humidity `%` on Right Axis) or view synchronized stacked panels.
- **Flexible Time Ranges & Resolutions**: Quick presets (`24h`, `48h`, `7d`, `14d`, `30d`, `90d`, `1y`, `Max`) and custom start/end dates, with `Auto`, `max` (~5 min), `30min`, `1hour`, `3hours`, and `1day` resolutions.
- **Visual Customization & Analysis**:
  - Area, Line, Bar, or Step-Line series styles per curve.
  - Optional Moving Average smoothing (`3pt`, `5pt`, `11pt`), Min/Max extreme value pins, drag-to-zoom on the canvas, interactive crosshair tooltip, summary statistics cards (`Latest`, `Min`, `Max`, `Avg`, `Delta`), and one-click **CSV Export**.

### 4. Windows Taskbar Widget & Dynamic System Tray
- **Floating Taskbar Bar / Flyout Widget**: Always-on-top, frameless translucent widget docked right above the Windows taskbar (near the system tray).
- **Customizable Pinned Sensors**: Pin up to 8 sensor metrics from any module, click to expand the **24-hour mini-sparkline flyout**, or drag the widget anywhere on screen.
- **Dynamic Windows Tray Icon**: Renders a live temperature badge directly in the Windows notification area with multi-sensor hover tooltips and context menu controls.

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
