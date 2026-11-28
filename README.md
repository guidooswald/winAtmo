# winAtmo

<a href="https://apps.microsoft.com/detail/9P5LDB7WCKFG">
  <img src="https://get.microsoft.com/images/en-us%20dark.svg" alt="Download from Microsoft Store" width="220" />
</a>

Native Windows desktop application for **Netatmo Personal Weather Stations** (`NAMain`, `NAModule1` Outdoor, `NAModule2` Wind Anemometer, `NAModule3` Rain Gauge, `NAModule4` Indoor Module), **Healthy Home Coach** (`NHC` Smart Indoor Air Quality Monitor), and **Netatmo Security Cameras & Doorbells** (`NACamera` Welcome, `NOC`/`NOC2` Presence, `NDB` Smart Video Doorbell, `NPC` Indoor Camera Advance), built with Electron, React, TypeScript, and native SQLite (`node:sqlite`).

---

## Screenshots

### Live Sensors & Air Quality Dashboard
![Sensors & Dashboard](docs/screenshots/dashboard.png)

### Hardware & Signal Diagnostics
![Hardware & Signal Diagnostics](docs/screenshots/diagnostics.png)

### Flexible Multi-Curve Chart Studio
![Flexible Charts](docs/screenshots/charts.png)

### Interactive European Rain Radar Map (RainViewer & DWD Nowcast)
![European Rain Radar Map](docs/screenshots/radar.png)

### Netatmo Security, Cameras, Live Feeds & Events
![Netatmo Security & Cameras](docs/screenshots/security.png)

### Floating Windows Taskbar Widget (with 24h Mini-Sparkline Flyout)
![Windows Taskbar Widget](docs/screenshots/widget.png)

### Settings, Local SQLite Time-Series Database & Custom Themes
![Settings & SQLite](docs/screenshots/settings.png)

---

## Architecture Overview

![winAtmo Architecture Diagram](docs/screenshots/architecture.png)

winAtmo employs a secure, high-performance multi-process architecture:
- **Netatmo Cloud, Radar & Camera Layer**: Weather Stations, Modules, Air Quality sensors, and Security Cameras/Doorbells synced via REST API, local LAN endpoints, and OAuth 2.0 / Web Login, plus in-process loopback proxies on `127.0.0.1` for authenticated security media (`securityMediaProxy` for snapshots and `.m3u8`/`.ts` HLS streams) and 24-hour cached precipitation radar tiles (`radarService`).
- **Electron Main Process (Node.js)**: Local high-throughput storage using native `node:sqlite` in WAL mode (`WITHOUT ROWID` for weather time-series plus cached `security_events`, custom themes, and saved sensor layouts), DPAPI credential encryption at rest (`safeStorage`), API response caching with single-flight request deduplication, and background auto-refresh polling (default 10-minute cycle).
- **Windows OS Integration**: Native translucent floating Taskbar Widget, System Tray background residency, and dynamic DWM title bar theme synchronization.
- **React 19 & TypeScript Studio**: Real-time rearrangeable sensor cards, custom zero-dependency SVG multi-curve charting studio (up to 10 curves with dual Y-axes), interactive Rain Radar Map (`Leaflet`), Netatmo Security dashboard with floodlight control & resizable `hls.js` video player, 12 built-in dark/light themes across 6 design families, and a dedicated **Theme Editor** window.

---

## Key Features

### 1. Web Login, OAuth 2.0 & DPAPI Security
- **One-Click Netatmo Web Login (`auth.netatmo.com` / `home.netatmo.com`)**: Opens an embedded Netatmo sign-in window, automatically intercepts the authenticated session token (`netatmocomaccess_token` / `Bearer` token), and supports silent background session renewal.
- **Official Netatmo Connect OAuth 2.0 (`api.netatmo.com/oauth2`)**: Full Authorization Code Grant flow with local loopback callback and automatic `refresh_token` rotation (`read_station read_homecoach`).
- **Windows DPAPI Encryption at Rest**: Encrypts stored tokens, session cookies, and OAuth secrets on disk using Electron's `safeStorage` (Windows DPAPI).
- **Personal Access Token & Built-in Demo Mode**: Paste developer tokens directly from [dev.netatmo.com](https://dev.netatmo.com/apidocumentation/weather) or explore the full UI offline using the built-in Demo Station.

### 2. Fast, Lightweight Local SQLite Time-Series Storage
- Powered by Node's native `node:sqlite` (`DatabaseSync`) in WAL (`Write-Ahead Logging`) mode—zero external database servers.
- Uses a clustered **`WITHOUT ROWID`** primary key `(module_id, metric, scale, ts)` for compact storage and sub-millisecond range queries across millions of data points, alongside tables for cached security events, custom themes, and per-station sensor tile order.
- **Incremental Delta Sync & Traffic Optimization**: Tracks downloaded time spans per module and scale (`sync_log`) for gap-only historical backfills, backed by API response caching and single-flight request deduplication.
- **Configurable History Window**:
  - **Default**: **14 days** of historical sync (`historyDays: 14`).
  - **Configurable up to Netatmo's Maximum**: Presets and slider up to **Maximum Allowed (All History Since Station `date_setup`)** mode that paginates `/api/getmeasure` in 1,024-point chunks back to your station's initial setup date.

### 3. Live Sensors & Air Quality Dashboard
- **Rearrangeable Sensor Tiles**: Drag and drop station/module cards in the Sensors view to organize rooms and sensors the way you prefer; your custom order is saved in the local SQLite database with a one-click reset button to restore the default arrangement.
- **Semantic CO₂ Color Coding & Diagnostics**: Colorizes live CO₂ readings by air quality threshold, displays Wi-Fi / RF / battery hardware diagnostics, and uses a clean fit-to-content layout without trailing empty space when all tiles fit on screen.

### 4. Flexible Multi-Curve Chart Studio
- **Multi-Sensor Comparison**: Plot up to **10 sensor curves** from any station or room simultaneously.
- **Sensor-Aware Quick Presets**: Dynamically generates presets tailored to your connected hardware (*All Temperatures*, *Indoor Temps*, *CO₂ All Rooms*, *Humidity All Rooms*, *Outdoor & Pressure*, *Noise All Rooms*, plus *Wind & Gusts* and *Rain* when present).
- **Overlay (Dual Y-Axis) & Stacked Sub-Charts**: Compare different physical units (e.g., Outdoor Temp `°C` on Left Axis vs. Barometric Pressure `mbar` on Right Axis) or view synchronized stacked panels.
- **Flexible Time Ranges & Resolutions**: Defaults to `7d` view with quick presets (`24h`, `3d`, `7d`, `14d`, `30d`, `90d`, `1Y`, `Max`) and custom date pickers, across `Auto`, `max` (~5 min), `30min`, `1hour`, `3hours`, and `1day` resolutions.
- **Visual Customization & Analysis**:
  - Area, Line, Bar, or Step-Line series styles.
  - Moving Average smoothing, Avg dashed lines, Min/Max pins, drag-to-zoom on the canvas, interactive crosshair inspector, summary statistics cards (`Latest`, `Min`, `Average`, `Max`, `Delta`, `Points`), and one-click **CSV Export**.

### 5. Interactive Rain Radar Map (RainViewer & DWD Nowcast)
- **Dual Precipitation Sources**: Switch between **RainViewer** (European & global 2-hour past frames in 10-minute steps) and **DWD 1km RADOLAN-RY + 2h Nowcast** radar imagery over Central Europe.
- **No-API-Key Basemaps & Station Overlays**: Choose between Auto, Esri Dark/Light Canvas, OpenStreetMap, and OpenTopoMap layers, with live weather station pins showing current station temperature readings.
- **Timeline Playback & 24h Local Tile Cache**: Scrub past and forecast frames with Play/Pause controls, an opacity slider, viewport cache progress indicators, and a local `127.0.0.1` tile cache proxy for smooth playback.

### 6. Netatmo Security Cameras, Floodlights, Live Feeds & Event Timeline
- **Camera Status, Floodlight Control, Live Feeds & 24h Replay Downloads**: Lists connected indoor/outdoor cameras and doorbells (`NACamera`, `NOC`/`NOC2`, `NDB`, `NPC`) with monitoring state, Local LAN / VPN route indicator, Wi-Fi signal strength (`dB`), SD card status, power state, and firmware version. Switch floodlight mode (**Auto** / **On** / **Off**) on supported outdoor Presence cameras, click **Live Feed** on any camera card to stream live HLS video (`{local_url|vpn_url}/live/index*.m3u8`) directly in the app, or click **24h Replay** on supported outdoor cameras (`NOC`/`NOC2` Presence) to download the full 24-hour timelapse replay to your computer with live byte and segment progress.
- **Resizable HLS Video Player & Media Downloads**: Stream recorded camera event clips (`/vod/{video_id}/index*.m3u8`) or live feeds inside a resizable, maximizable `hls.js` modal powered by a local `127.0.0.1` loopback proxy. View full-resolution snapshots, manually refresh missing/expired event images, save snapshots, and download recorded event videos or outdoor camera 24h replays with a live segment & byte progress bar.
- **Filterable Event Timeline & Local SQLite Persistence**: Two-column layout with a fluid, window-scaling Events column filterable by event category (`All Events`, `Person / Human`, `Vehicle`, `Animal`, `Motion`, `Doorbell`, `System`), camera, person, and search text. Optionally caches security events in SQLite (`security_events`, toggleable and clearable in Settings) and performs unseen-only incremental background syncs on the shared **10-minute** default refresh cycle.
- **Known Persons & Home Presence Control**: Merges static person profiles with live `/api/homestatus` presence to show currently home vs. recently seen away family members, filter events by person, and notify Netatmo via **Home is Empty (Everybody Left)** (`POST /api/setpersonsaway`).
- **Debug Console & Rate-Limit Telemetry**: Main-header rate-limit warning indicator with hover explanation and quick access to the standalone Debug Console window, which logs transfer rates and filters raw API telemetry separately by **Weather Station**, **Security**, and **Auth** requests.

### 7. Floating Windows Taskbar Widget, Theme Editor & Multi-Language UI
- **Live Taskbar & System Tray Sensor Reading**: Shows a live single sensor reading (e.g., outside temperature `14°` with semantic status colors or a custom value text color) directly in your Windows taskbar tray using crisp DPI-aware rendering (`Franklin Gothic Demi Cond` at `16`/`24`/`32px`). Fully customizable in settings to outside temp (default), indoor temp, CO₂, humidity, pressure, or any discovered station sensor.
- **Floating Single-Line Taskbar Bar**: Always-on-top, frameless rounded widget that auto-sizes to fit your pinned sensors on a single line, is freely resizable, and includes a **25%–100% Opacity slider**.
- **Smart Upward / Downward 24h Flyout**: Expands upwards when docked near the bottom taskbar and downwards when placed near the top of the screen, restoring its exact position on collapse.
- **12 Built-In Themes Across 6 Design Families**: Includes light & dark presets across *Modern Fluent* (*Fluent Slate*, *Fluent Daylight*), *Compact Density* (*Compact Dark*, *Compact Light*), *Cyber Terminal* (*Cyber Matrix*, *Laboratory Monospace*), *Nordic Minimalist* (*Nord Polar Night*, *Nord Snow Storm*), *Neo-Brutalist* (*Neo-Brutal Dark*, *Neo-Brutal Light*), and *Soft Organic* (*Soft Velvet*, *Soft Cream*) with native Windows dark/light title bar sync.
- **Dedicated Theme Editor Window**: Launch the Theme Editor directly from Settings to create custom themes from scratch or clone any existing or preinstalled theme. Customize colors, fonts, window borders, and spacing with an interactive live preview, store custom themes in SQLite so they appear in the theme dropdown, and import or export `.json` theme files.
- **Multi-Language Support**: Translated UI across **9 languages** (`English`, `Deutsch`, `Français`, `Español`, `Português`, `Italiano`, `Polski`, `Čeština`, and `Ελληνικά`).

---

## Netatmo API Reference Implemented

| Endpoint | Usage in winAtmo |
| :--- | :--- |
| `GET /api/getstationsdata` | Loads Weather Station topology (`NAMain`, `NAModule1..4`), live `dashboard_data`, `date_setup`, `last_status_store`, `wifi_status`, `rf_status`, and `battery_vp` / `battery_percent`. |
| `GET /api/gethomecoachsdata` | Loads Healthy Home Coach (`NHC`) indoor air quality devices and live metrics. |
| `GET /api/getmeasure` | Fetches historical time-series (`scale`: `max`, `30min`, `1hour`, `3hours`, `1day`; `limit=1024`; `optimize=false`; `real_time=true`) with automatic pagination across arbitrary time ranges. |
| `GET /api/homesdata` (`gethomedata`) | Loads Netatmo home topology, Security cameras/doorbells (`NACamera`, `NOC`, `NDB`, `NPC`), modules, and known person profiles. |
| `GET /api/homestatus` | Fetches live camera monitoring status, stream `vpn_url` / `local_url`, Wi-Fi/SD/power/floodlight health, and live person presence (`out_of_sight`, `last_seen`). |
| `GET /api/getevents` (`geteventsuntil`) | Retrieves camera security timelines, sub-events, snapshots, and recorded clip references (`video_id`). |
| `POST /api/setpersonsaway` | Marks all persons in the selected home as away (**Home is Empty**). |
| `POST /api/setstate` | Updates camera floodlight settings (`auto` / `on` / `off`) on supported outdoor cameras, with local/VPN `/command/floodlight_set_config` fallback. |
| `/api/getcamerapicture`, `/vod/*`, `/live/*` | Fetches event snapshots and proxies live and recorded HLS camera streams via winAtmo's local `127.0.0.1` loopback proxy. |
| `GET/POST /oauth2/*` | Official Netatmo Connect OAuth 2.0 Authorization Code & Refresh Token grant flows. |

---

## Installation & Getting Started

### Option 1: Microsoft Store (Recommended)

For the easiest install, zero dependencies, and automatic background updates, get **winAtmo** directly from the Microsoft Store:

<a href="https://apps.microsoft.com/detail/9P5LDB7WCKFG">
  <img src="https://get.microsoft.com/images/en-us%20dark.svg" alt="Download from Microsoft Store" width="220" />
</a>

- **Direct Store Page:** [https://apps.microsoft.com/detail/9P5LDB7WCKFG](https://apps.microsoft.com/detail/9P5LDB7WCKFG)

---

### Option 2: Run from Source / GitHub

#### Prerequisites
- Windows 10 or Windows 11
- Node.js 22+

#### Installation & Build
```powershell
# Clone the repository
git clone https://github.com/guidooswald/winAtmo.git
cd winAtmo

# Install dependencies and launch
npm install
npm run build
npm start
```
Or double-click **`run.bat`** to build (if needed) and launch the native Windows app.

#### Development Mode (Hot Reload)
```powershell
npm run dev
```

---

## License & Privacy

- **License:** Released under the [MIT License](LICENSE) • Copyright © 2026 [Guido Oswald](https://guido.swiss)
- **Privacy Policy:** See [PRIVACY.md](PRIVACY.md) for data handling and security disclosures.
- **Security Audit:** See [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) for the security assessment, findings, and implemented remediations.

---

## Disclaimer

winAtmo is an independent, non-commercial, open-source project and is not affiliated with, endorsed by, or sponsored by Netatmo SAS or Legrand. "Netatmo" is a registered trademark of Netatmo SAS.
