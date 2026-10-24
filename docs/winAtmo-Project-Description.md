# winAtmo — Technical Architecture & Product Overview

A Modern, High-Performance Windows Desktop Studio for Netatmo Weather & Air Quality Monitoring

---

## Executive Summary

**winAtmo** is a purpose-built, high-performance desktop application engineered for Microsoft Windows 10 and 11, providing real-time telemetry, comprehensive multi-curve historical analytics, and an ambient desktop widget for Netatmo Smart Weather Stations and Smart Indoor Air Quality Monitors.

While macOS users have enjoyed native weather station dashboards, Windows users have historically lacked a dedicated, native client, forced instead to rely on browser tabs or smartphone apps. winAtmo bridges this gap by delivering a fluid 60 FPS desktop experience built on Electron, React 19, TypeScript, and Node.js. It features an embedded SQLite time-series engine, local hardware-backed credential encryption via the Windows Data Protection API (DPAPI), a zero-dependency custom SVG charting engine, and seamless Windows Desktop Window Manager (DWM) integration across 12 dark and light visual themes.

---

## Core Mission & Architecture Principles

The architecture of winAtmo is guided by four foundational engineering pillars:

* **Zero-Latency Responsiveness**: Instantaneous application launch and query performance achieved through local time-series caching in an embedded SQLite database running in Write-Ahead Logging (WAL) mode.
* **Hardware-Secured Privacy**: All authentication tokens, credentials, and configuration secrets are encrypted at rest using Windows DPAPI (`safeStorage`). No user telemetry or analytics are collected or transmitted to third parties.
* **Native Windows Ergonomics**: Designed to feel like a first-class Windows 11 application, featuring dynamic title bar theme synchronization via DWM, system tray persistence, and an acrylic-style floating desktop widget.
* **Deep Analytical Precision**: Moving beyond simple single-station displays, the Chart Studio empowers users to superimpose up to 10 independent physical metrics simultaneously across different physical rooms or outdoor modules with dual-axis normalization.

---

## System Architecture Overview

winAtmo employs a robust multi-process architecture that strictly segregates security-sensitive system operations and cloud communication from the user interface. The backend runs in Node.js within the Electron Main process, communicating over a context-isolated, asynchronous Inter-Process Communication (IPC) bridge with the React 19 frontend renderer.

```
+-------------------------------------------------------------------------+
|                              Netatmo Cloud                              |
|           (Weather Stations, Modules, Air Quality Monitors)             |
+-------------------------------------------------------------------------+
                                    |
                                    | HTTPS / OAuth2 (Tokens + REST API)
                                    v
+-------------------------------------------------------------------------+
|                          Electron Main Process                          |
|  +--------------------+  +--------------------+  +--------------------+ |
|  |   Netatmo Client   |  | Time-Series SQLite |  | Store & DPAPI Enc. | |
|  | (Poller & Backoff) |  |   (WAL Mode DB)    |  |  (Windows Secrets) | |
|  +--------------------+  +--------------------+  +--------------------+ |
|  +--------------------------------------------------------------------+ |
|  |      Native Windows Integrations (Tray, DWM, Desktop Widget)       | |
|  +--------------------------------------------------------------------+ |
+-------------------------------------------------------------------------+
                                    |
                                    | Typed IPC Bridge (Context Isolation)
                                    v
+-------------------------------------------------------------------------+
|                        Electron Renderer Process                        |
|  +--------------------+  +--------------------+  +--------------------+ |
|  |  React 19 & Vite   |  | Custom SVG Charts  |  | 12-Theme Engine    | |
|  |  (TypeScript App)  |  |  (Dual Y-Axis Core)|  | (DWM Auto-Sync)    | |
|  +--------------------+  +--------------------+  +--------------------+ |
|  +--------------------------------------------------------------------+ |
|  |    Views: Live Dashboard | Chart Studio | Settings | Mini-Widget   | |
|  +--------------------------------------------------------------------+ |
+-------------------------------------------------------------------------+
```

### Component Decomposition

1. **Netatmo Cloud & API Sync**: Connects to Netatmo's official REST API endpoints (`/getstationsdata`, `/getmeasure`). Authentication supports both custom OAuth2 client credentials and an integrated, secure web-based login workflow. The poller operates on a configurable background cadence (defaulting to 10 minutes) with exponential backoff on network failures.
2. **Local Persistence Engine (`node:sqlite`)**: Uses Node's built-in SQLite engine configured with Write-Ahead Logging (`PRAGMA journal_mode = WAL`) and normalized composite primary key indexing (`WITHOUT ROWID`). Incoming measurements are ingested atomically, enabling offline historical analytics without querying external cloud servers.
3. **Hardware-Backed Credential Security (`safeStorage`)**: All OAuth2 access and refresh tokens are protected at rest using Windows DPAPI, binding encryption keys directly to the current Windows user account and hardware TPM.
4. **Context-Isolated IPC Bridge**: The preload script establishes a strongly-typed IPC interface (`window.api`), exposing only safe query methods and preventing arbitrary Node.js code execution within the browser context.
5. **Renderer Engine**: Built with React 19, TypeScript, and Tailwind CSS, bundled with Vite for near-instant hot-module reloading and optimized production bundles.

---

## Real-Time Telemetry Dashboard

The Sensors Dashboard provides an immediate overview of all configured Netatmo stations, outdoor transmitters, and indoor companion modules. Rather than presenting dense tables of raw numbers, winAtmo organizes live sensor telemetry into visual cards grouped logically by physical station and room.

Each card surfaces current readings with clear visual state indicators:

* **Indoor Environmental Factors**: Temperature (°C or °F), Relative Humidity (%), Carbon Dioxide concentration (ppm) with health status badges (Good, Warning, Alert), Acoustic Noise levels (dB), and Barometric Pressure (mbar or inHg) with trend indicators.
* **Outdoor & Meteorological Tracking**: Real-time outdoor temperature, humidity, rain accumulation (current, 1-hour, 24-hour totals), wind speed, wind gust velocity, and wind angle.
* **Hardware Health & Diagnostics**: Live battery percentage badges and radio frequency (RF) signal reception indicators for all wireless modules, ensuring that low batteries or degraded wireless signals are detected before data collection is interrupted.

---

## Interactive Multi-Curve Chart Studio

At the heart of winAtmo's analytical capability is the Chart Studio. While consumer weather applications restrict historical viewing to a single metric or a single room, winAtmo allows power users to correlate diverse physical phenomena on a unified, high-density timeline.

### Key Capabilities of the Charting Engine

* **Up to 10 Simultaneous Curves**: Plot indoor temperature, outdoor temperature, living room CO2, bedroom humidity, and barometric pressure concurrently on the same coordinate space.
* **Dual Synchronized Y-Axes**: Metrics sharing physical dimensions (e.g., temperatures) align automatically on the left Y-axis, while secondary dimensions (e.g., CO2 ppm or relative humidity %) bind dynamically to the right Y-axis, complete with color-matched scale ticks.
* **Zero-Dependency SVG Rendering**: Rendered using pure mathematical SVG paths, eliminating bloated canvas or WebGL dependencies while guaranteeing razor-sharp display clarity at any DPI scale or window resolution.
* **Interactive Crosshair & Hover Inspector**: Moving the mouse over the plot tracks the nearest recorded timestamp and renders a multi-metric floating tooltip displaying the exact reading of every active curve at that precise moment.
* **Dynamic, Sensor-Aware Presets**: In addition to standard intervals (1 Day, 7 Days default, 30 Days, 90 Days, 1 Year, Max, or Custom Date Picker), the studio provides smart preset comparisons (e.g., Indoor vs. Outdoor Temperature, Air Quality & CO2). If rain or wind sensors are absent, irrelevant presets are intelligently hidden.

---

## Floating Desktop Widget & Windows Integration

For users who want continuous ambient awareness of their indoor environment without keeping the full application window open, winAtmo includes a dedicated desktop widget.

### Widget Specifications

* **Frameless & Translucent**: Designed with an acrylic/mica translucent backdrop and subtle rounded corners, floating smoothly over the Windows desktop.
* **Ambient Air Quality Ring**: Features color-coded visual accents reflecting real-time CO2 thresholds (green for fresh air, amber for moderate ventilation needed, red for elevated CO2 levels requiring immediate airing).
* **24-Hour Sparklines**: Provides high-density, smooth SVG micro-charts displaying 24-hour temperature and humidity trends at a glance.
* **Interactive Expandability**: Can be toggled between a compact single-metric badge and an expanded multi-module inspection view. When collapsed, the widget preserves its exact desktop coordinate positioning.
* **Customizable Transparency & Pinning**: Users can dynamically adjust widget opacity via a slider and toggle an `Always on Top` pin to float above productive workspaces or sit quietly on secondary monitors.
* **Dynamic Taskbar & System Tray Sensor Reading**: Instead of a static application icon, winAtmo can render a live single sensor reading (e.g., outside temperature with semantic status color coding) directly into the Windows taskbar notification area, defaulting to outside temperature and customizable to any connected module or metric.
* **System Tray & DWM Synchronization**: winAtmo minimizes unobtrusively to the Windows notification tray, with instant menu actions to show or hide the studio or widget. The main window frame dynamically synchronizes native Windows DWM title bar styling to match the selected theme.

---

## Theme Engine & Visual Customization

winAtmo features an extensive, professionally tuned theme system designed for visual comfort in diverse lighting conditions. Users can switch between 12 distinct dark and light palettes, each carefully balanced for contrast, legibility, and reduced eye strain:

| Theme Name | Mode | Aesthetic & Dominant Colors | Primary Usage |
| :--- | :--- | :--- | :--- |
| **System** | Adaptive | Follows Windows 10/11 OS light/dark preference automatically | Default, general day-to-night usage |
| **Charcoal** | Dark | Neutral dark gray (#1e2124) with crisp white typography | High contrast, professional workstation |
| **Midnight Blue** | Dark | Deep indigo and sapphire (#0f172a) with cyan accents | Low-light ambient monitoring |
| **Nord** | Dark | Arctic, north-bluish palette (#2e3440) with frost highlights | Developer and power-user favorite |
| **Cyberpunk** | Dark | Neon violet, electric yellow, and high-saturation pink | High visual energy, gaming setups |
| **Forest Dark** | Dark | Organic pine green and earthy slate tones | Relaxing, natural ambiance |
| **Dracula** | Dark | Classic purple (#282a36) and vibrant pastel accents | Popular dark code-editor styling |
| **Soft Light** | Light | Crisp, clean slate and soft white (#f8fafc) | Bright daylight office environments |
| **Solarized Light** | Light | Warm ivory (#fdf6e3) with solarized amber accents | Reduced glare, prolonged reading |
| **Paper Warm** | Light | Natural parchment tones (#f7f4ee) with warm gray borders | Soft editorial aesthetic |
| **Cool Gray** | Light | Modern enterprise gray (#f1f3f5) with slate typography | Formal corporate and clean desk setups |
| **Sandstone** | Light | Warm desert sandstone and beige tones | Warm, relaxed daytime monitoring |

---

## Configuration, Preferences & Security Management

The Settings view provides granular control over authentication, network sync cadence, units of measurement, and local storage lifecycle:

* **Authentication & Token Management**: Supports both standard Netatmo Developer API credentials (Client ID and Client Secret) and an integrated Web Authentication workflow. Tokens are refreshed automatically without user intervention.
* **Unit Preferences**: Configurable temperature units (Celsius or Fahrenheit) and barometric pressure units (Millibars/hPa or Inches of Mercury).
* **Data Caching & Reset Tools**: Users can inspect the local SQLite database size, trigger immediate manual cloud synchronization, or perform a complete cache flush if historical records need to be re-indexed from scratch.
* **Version & Build Traceability**: The bottom of the application displays a dynamic version identifier (`v0.1.<build>`), where the build number increments with every Git commit. Active links provide one-click access to the GitHub open-source repository and the author's personal website.

---

## Security, Privacy & Compliance Verification

winAtmo was audited and hardened against modern software security standards:

1. **Hardware-Backed Encryption at Rest**: Authentication tokens are encrypted using Electron's `safeStorage` API, which leverages Windows DPAPI backed by the host's Trusted Platform Module (TPM). Credentials cannot be extracted by inspecting the on-disk SQLite or JSON configuration stores.
2. **Context Isolation & Sandboxing**: The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Web code cannot invoke operating system shells or read arbitrary local files.
3. **No External Telemetry or Advertising**: The application communicates solely with Netatmo's official cloud endpoints (`api.netatmo.com`). Zero tracking libraries, analytics SDKs, or third-party advertising cookies are included.
4. **Scrubbed Source Code & Sanitized Assets**: All repository assets, documentation, and user screenshots have been scrubbed of personal identification, real MAC addresses, and private location data.

---

## Technical Specifications & Stack

The following matrix summarizes the software architecture and dependencies underpinning winAtmo:

| Subsystem | Technology | Version | Purpose & Architecture Role |
| :--- | :--- | :--- | :--- |
| **Runtime Container** | Electron | 35.x | Desktop application wrapper, native Windows OS integration |
| **UI Framework** | React | 19.x | Declarative component hierarchy and reactive state management |
| **Language** | TypeScript | 5.8 | End-to-end static typing across Main, Preload, and Renderer |
| **Build Tooling** | Vite | 6.x | High-speed compilation, HMR, and tree-shaken production bundles |
| **Embedded Database** | `node:sqlite` | Node 24 | High-performance local time-series store in WAL mode |
| **Styling & Design** | Tailwind CSS | 4.x | Utility-first responsive design and dynamic 12-theme variables |
| **Cryptography** | Windows DPAPI | Native | Hardware-backed local credential encryption at rest |
| **Platform Target** | Windows OS | 10 / 11 | x64 native desktop deployment |
| **Open Source License** | MIT License | 2026 | Permissive open-source license for global community use |

---

## Project Resources & Links

* **GitHub Repository**: [https://github.com/guido-o/winAtmo](https://github.com/guido-o/winAtmo)
* **Author Homepage**: [https://guido.swiss](https://guido.swiss)
* **License**: MIT License — Copyright (c) 2026 Guido Oswald
