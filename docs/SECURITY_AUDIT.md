# winAtmo Security Audit & Remediation Report

- **Application:** `winAtmo` (`v0.3.0`)
- **Audit Date:** 2026-11-19
- **Remediation Commit:** [`d2eec46`](https://github.com/guidooswald/winAtmo/commit/d2eec46757241d794ad7afaf52736e648426c0b7) (`d2eec46757241d794ad7afaf52736e648426c0b7`, 14 files updated)
- **Audit Scope:** Electron main, preload, and renderer processes; IPC surface and sender validation; OAuth 2.0 and Netatmo Web Login authentication flows; Windows DPAPI (`safeStorage`) and SQLite secret persistence; localhost HTTP proxies (`securityMediaProxy` and `radarService`); Content-Security-Policy (CSP), navigation, and Chromium permission hardening; debug logging redaction; CSV export and SVG handling; and `npm audit` dependency review.

---

## Executive Summary

A full source-code and runtime security assessment of **winAtmo** identified **11 code-level security findings** (4 High, 4 Medium, 3 Low) and **1 build-time-only Moderate dependency advisory** (`npm audit`).

- All **11 code-level findings** (`SEC-01` through `SEC-11`) were remediated in commit [`d2eec46`](https://github.com/guidooswald/winAtmo/commit/d2eec46757241d794ad7afaf52736e648426c0b7) and verified through TypeScript static checking (`tsc --noEmit`), full Vite + esbuild production compilation, and automated Electron runtime security verification.
- The single remaining advisory (`SEC-12`, `minimatch` `GHSA-g3hv-75wg-m249`) exists exclusively in the build-time dev dependency chain (`electron-builder` -> `app-builder-lib` -> `@electron/universal`) and does not ship inside packaged `dist/main` or `dist/renderer` application bundles.

---

## Findings Summary

| ID | Severity | Finding | Affected Files | Status |
| :--- | :--- | :--- | :--- | :--- |
| `SEC-01` | **High** | Unrestricted SSRF / Arbitrary HTTP Fetcher Exposed Over IPC (`security:fetch-media`) | [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/main.ts`](../src/main/main.ts), [`src/main/preload.ts`](../src/main/preload.ts) | Remediated (`d2eec46`) |
| `SEC-02` | **High** | Live OAuth Access/Refresh Tokens & Camera Secrets Logged Unredacted to Debug Console | [`src/main/debugLogger.ts`](../src/main/debugLogger.ts), [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/securityMediaProxy.ts`](../src/main/securityMediaProxy.ts) | Remediated (`d2eec46`) |
| `SEC-03` | **High** | Plaintext Credential Persistence on Quit / Encryption Fallback (`AppStore`) | [`src/main/store.ts`](../src/main/store.ts), [`src/main/webAuth.ts`](../src/main/webAuth.ts) | Remediated (`d2eec46`) |
| `SEC-04` | **High** | Missing Content-Security-Policy (CSP), Unblocked `will-navigate`, and Unvalidated IPC Senders | [`src/main/main.ts`](../src/main/main.ts), [`index.html`](../index.html) | Remediated (`d2eec46`) |
| `SEC-05` | **Medium** | Decrypted `oauthClientSecret` Exposed to All Renderers Over IPC | [`src/main/store.ts`](../src/main/store.ts), [`src/main/main.ts`](../src/main/main.ts), [`src/main/webAuth.ts`](../src/main/webAuth.ts), [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/preload.ts`](../src/main/preload.ts), [`src/renderer/App.tsx`](../src/renderer/App.tsx), [`src/renderer/components/SettingsView.tsx`](../src/renderer/components/SettingsView.tsx) | Remediated (`d2eec46`) |
| `SEC-06` | **Medium** | Localhost HTTP Proxy Hardening Gaps (`securityMediaProxy` & `radarService`) | [`src/main/securityMediaProxy.ts`](../src/main/securityMediaProxy.ts), [`src/main/radarService.ts`](../src/main/radarService.ts), [`src/renderer/types.ts`](../src/renderer/types.ts), [`src/renderer/components/RadarMapView.tsx`](../src/renderer/components/RadarMapView.tsx) | Remediated (`d2eec46`) |
| `SEC-07` | **Medium** | Auth Window Isolation, Substring Cookie Domain Match & Missing Permission Handlers | [`src/main/webAuth.ts`](../src/main/webAuth.ts), [`src/main/main.ts`](../src/main/main.ts) | Remediated (`d2eec46`) |
| `SEC-08` | **Medium** | Camera Secret URLs Stored Unencrypted in SQLite & Exposed to Renderer | [`src/main/database.ts`](../src/main/database.ts), [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts) | Remediated (`d2eec46`) |
| `SEC-09` | **Low** | Offscreen Taskbar Renderer Used `contextIsolation: false` | [`src/main/taskbarIcon.ts`](../src/main/taskbarIcon.ts) | Remediated (`d2eec46`) |
| `SEC-10` | **Low** | Unvalidated `settings:update` Payload Keys & CSV Formula Injection | [`src/main/main.ts`](../src/main/main.ts) | Remediated (`d2eec46`) |
| `SEC-11` | **Low** | Unescaped `eventId` in Demo SVG, `.svg` Snapshot Export & Production Dev Helpers | [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/main.ts`](../src/main/main.ts) | Remediated (`d2eec46`) |
| `SEC-12` | **Moderate** | `minimatch` ReDoS Advisory (`GHSA-g3hv-75wg-m249`) via `electron-builder` | [`package.json`](../package.json) | Open — Build-Time Only |

---

## Detailed Findings & Remediations

### High Severity

#### SEC-01 — Unrestricted SSRF / Arbitrary HTTP Fetcher Exposed Over IPC (`security:fetch-media`)
- **Affected Files:** [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/main.ts`](../src/main/main.ts), [`src/main/preload.ts`](../src/main/preload.ts)
- **Finding:**
  - An unused `security:fetch-media` IPC handler was exposed through the preload bridge (`window.winatmo.fetchSecurityMedia`) to every renderer window despite having zero renderer callers.
  - `fetchSecurityMedia` accepted arbitrary URLs without a host allowlist, forwarded caller-supplied `req.headers`, sent `persist:netatmo` session cookies, attached `Authorization: Bearer` tokens based on URL host matching, and followed arbitrary HTTP redirects.
  - `refreshSecurityEventImage` also accepted renderer-supplied `candidateUrls` and passed them straight through to `fetchSecurityMedia`.
- **Remediation:**
  - Removed the `security:fetch-media` IPC registration from `main.ts` and removed `fetchSecurityMedia` from `preload.ts`.
  - Restricted `fetchSecurityMedia` to `private` internal visibility on `NetatmoClient`.
  - Added strict URL validation via `isAllowedSecurityMediaUrl` and `allowedMediaOrigins`, blocking loopback and link-local addresses (`localhost`, `127.*`, `0.0.0.0`, `::1`, `169.254.*`, `fe80:*`) and permitting only trusted Netatmo/Azure blob hosts or origins explicitly registered from authenticated Netatmo API responses.
  - Filtered renderer `candidateUrls` in `refreshSecurityEventImage` against `isAllowedSecurityMediaUrl`.
  - Enforced manual redirect handling (maximum 3 hops, stripping `Authorization` headers across origin changes) and bounded response payloads (32 MB standard / 250 MB timelapse).

#### SEC-02 — Live OAuth Access/Refresh Tokens & Camera Secrets Logged Unredacted to Debug Console
- **Affected Files:** [`src/main/debugLogger.ts`](../src/main/debugLogger.ts), [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/securityMediaProxy.ts`](../src/main/securityMediaProxy.ts)
- **Finding:**
  - OAuth token refresh calls to `oauth2/token` logged `rawBody: rawText` verbatim, capturing JSON responses containing live `access_token` and `refresh_token` credentials.
  - `redactSensitiveText` in `debugLogger.ts` only redacted a narrow set of query `key=value` and `Bearer` patterns, leaving JSON secret fields, form-encoded secrets, Netatmo VPN path tokens, private LAN hex token paths, and raw `.m3u8` HLS manifests exposed.
  - Logs were retained in the in-memory ring buffer and broadcast over `debug:stream` / `debug:get-snapshot` IPC channels to windows.
- **Remediation:**
  - Expanded `redactSensitiveText` in `debugLogger.ts` to redact query/form secret parameters (`access_token`, `refresh_token`, `client_secret`, `token`, `key`), JSON secret properties (`access_token`, `refresh_token`, `client_secret`, `vpn_url`, `local_url`, `key`, `secret`, `password`, `authorization`, `cookie`), `Bearer` authorization tokens, Netatmo VPN path token segments, and private LAN hex token paths.
  - Replaced raw `oauth2/token` and `.m3u8` `rawBody` payloads in `netatmoClient.ts` and `securityMediaProxy.ts` with structured, redacted summaries.

#### SEC-03 — Plaintext Credential Persistence on Quit / Encryption Fallback (`AppStore`)
- **Affected Files:** [`src/main/store.ts`](../src/main/store.ts), [`src/main/webAuth.ts`](../src/main/webAuth.ts)
- **Finding:**
  - `encryptSecretAsync()` fell back to returning plaintext if Electron `safeStorage` encryption was unavailable or errored.
  - `flushSync()` (invoked synchronously on `before-quit`) fell back to writing unencrypted `accessToken`, `refreshToken`, `oauthClientSecret`, and `cookies` whenever cached ciphertext was absent or invalidated.
  - `startOAuthLogin()` persisted `oauthClientSecret` via `updateSettings` even when the user chose `storeLocally === false`.
- **Remediation:**
  - Updated `encryptSecretAsync` and `writeEncryptedApiKeysFile` to fail closed so credentials are never serialized to disk in plaintext.
  - Implemented `encryptSecretSync` and `syncEncryptOrReuse` for `flushSync()` using synchronous DPAPI (`safeStorage`) encryption.
  - Added `setTransientOAuthCredentials` so sessions with `storeLocally === false` retain OAuth credentials strictly in memory without disk persistence.

#### SEC-04 — Missing Content-Security-Policy (CSP), Unblocked `will-navigate`, and Unvalidated IPC Senders
- **Affected Files:** [`src/main/main.ts`](../src/main/main.ts), [`index.html`](../index.html)
- **Finding:**
  - Application responses did not enforce a Content-Security-Policy header.
  - `mainWindow`, `widgetWindow`, and `debugWindow` lacked `will-navigate` and `will-redirect` handlers restricting navigation away from trusted app URLs.
  - Privileged IPC handlers did not validate `event.senderFrame.url` before executing actions.
- **Remediation:**
  - Attached CSP headers via `session.defaultSession.webRequest.onHeadersReceived` for `mainFrame` and `subFrame` resources (enforcing `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`, and explicit `img-src`, `media-src`, and `connect-src` directives in production, with scoped Vite HMR allowances in unpackaged dev mode).
  - Added `attachWindowSecurityGuards` to `mainWindow`, `widgetWindow`, and `debugWindow` to block untrusted navigations and redirects via `isTrustedAppUrl`.
  - Wrapped IPC handlers with `handleTrustedIpc` and `onTrustedIpc` helpers that verify `event.senderFrame.url` originates from a trusted application frame.

---

### Medium Severity

#### SEC-05 — Decrypted `oauthClientSecret` Exposed to All Renderers Over IPC
- **Affected Files:** [`src/main/store.ts`](../src/main/store.ts), [`src/main/main.ts`](../src/main/main.ts), [`src/main/webAuth.ts`](../src/main/webAuth.ts), [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/preload.ts`](../src/main/preload.ts), [`src/renderer/App.tsx`](../src/renderer/App.tsx), [`src/renderer/components/SettingsView.tsx`](../src/renderer/components/SettingsView.tsx)
- **Finding:**
  - `store.getSettings()` returned the decrypted `oauthClientSecret` over `settings:get` and `settings:updated` broadcasts to renderer processes that did not need direct access to the secret.
- **Remediation:**
  - Added `store.getPublicSettings()` stripping `oauthClientSecret` from all IPC reads, updates, and broadcasts.
  - Updated the Settings UI Client Secret input to behave as write-only (`Stored securely (leave blank to keep)`), while main-process `saveApiKeys`, `startOAuthLogin`, and `verifyAndSaveWebToken` reuse the stored secret automatically when omitted by the renderer.

#### SEC-06 — Localhost HTTP Proxy Hardening Gaps (`securityMediaProxy` & `radarService`)
- **Affected Files:** [`src/main/securityMediaProxy.ts`](../src/main/securityMediaProxy.ts), [`src/main/radarService.ts`](../src/main/radarService.ts), [`src/renderer/types.ts`](../src/renderer/types.ts), [`src/renderer/components/RadarMapView.tsx`](../src/renderer/components/RadarMapView.tsx)
- **Finding:**
  - Both local `127.0.0.1` proxies returned `Access-Control-Allow-Origin: *` and lacked upstream response byte caps.
  - `radarService.ts` had no per-session authentication token, permitted cleartext `http:` tile upstreams, and automatically followed redirects.
  - `securityMediaProxy.ts` used a non-constant-time (`!==`) token comparison, wildcard-allowed loopback/RFC1918 destinations, and automatically allowlisted redirect and `.m3u8` segment origins.
- **Remediation:**
  - Added a per-session `TILE_PROXY_SECRET` (`cacheProxyToken`) verified with `crypto.timingSafeEqual` in `radarService.ts` and wired it through `RadarMapView.tsx`.
  - Restricted `radarService.ts` upstream fetches to `https:` only with manual redirect validation and an 8 MB response cap.
  - Removed wildcard loopback/RFC1918 allowlisting and automatic `.m3u8`/redirect origin registration in `securityMediaProxy.ts`, blocked loopback/link-local addresses inside `allowUrlOrigin`, enforced manual redirect verification, added a 32 MB streaming size cap, and switched token comparison to `crypto.timingSafeEqual`.
  - Restricted CORS headers on both proxies strictly to validated local application origins (`null` for `file://` and `http://localhost` / `http://127.0.0.1`).

#### SEC-07 — Auth Window Isolation, Substring Cookie Domain Match & Missing Permission Handlers
- **Affected Files:** [`src/main/webAuth.ts`](../src/main/webAuth.ts), [`src/main/main.ts`](../src/main/main.ts)
- **Finding:**
  - Session cookie filtering used `.includes('netatmo.com')` substring matching instead of exact domain suffix checks.
  - `authWin`, `hiddenWin`, and `oauthWin` lacked `setWindowOpenHandler` and `will-navigate` restrictions, `oauthWin` omitted explicit `sandbox: true`, and `onBeforeSendHeaders` remained attached after login completion.
  - Neither `session.defaultSession` nor `persist:netatmo` configured permission request/check handlers to deny sensitive Chromium capabilities (camera, microphone, geolocation, notifications).
- **Remediation:**
  - Replaced substring domain checks with exact suffix validation (`isAllowedNetatmoDomain`).
  - Detached `onBeforeSendHeaders(null)` reliably on authentication completion or window close.
  - Enabled `sandbox: true` on `oauthWin`, denied popups via `setWindowOpenHandler`, enforced `will-navigate` allowlists (`isAllowedAuthNavUrl`) on all authentication windows, and verified OAuth `state` parameters using `crypto.timingSafeEqual`.
  - Configured global permission denial via `setPermissionRequestHandler` and `setPermissionCheckHandler` on both `session.defaultSession` and `persist:netatmo`.

#### SEC-08 — Camera Secret URLs Stored Unencrypted in SQLite & Exposed to Renderer
- **Affected Files:** [`src/main/database.ts`](../src/main/database.ts), [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts)
- **Finding:**
  - `security_cameras.vpn_url` and `local_url` (which embed Netatmo camera access tokens in URL paths) were persisted unencrypted in `winatmo-history.sqlite` and returned to the renderer inside `SecurityEventVideoResult`.
- **Remediation:**
  - Scrubbed legacy `vpn_url` and `local_url` values in `TimeSeriesDatabase.initSchema()` and removed persistence and retrieval of those columns in `database.ts`.
  - Stripped `vpnUrl`, `localUrl`, `localHlsUrl`, and unproxied `candidates` from `wrapDiscoveredVideo` in `netatmoClient.ts`, keeping raw stream URLs strictly inside main-process memory for tokenized proxy playback.

---

### Low Severity & Defense-in-Depth Hardening

#### SEC-09 — Offscreen Taskbar Renderer Used `contextIsolation: false`
- **Affected File:** [`src/main/taskbarIcon.ts`](../src/main/taskbarIcon.ts)
- **Finding:** The offscreen `BrowserWindow` used to rasterize live Windows taskbar tray badge icons configured `contextIsolation: false`.
- **Remediation:** Enabled `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`, and attached `setWindowOpenHandler` and `will-navigate` denials on the offscreen renderer.

#### SEC-10 — Unvalidated `settings:update` Payload Keys & CSV Formula Injection
- **Affected File:** [`src/main/main.ts`](../src/main/main.ts)
- **Finding:**
  - `settings:update` forwarded renderer-supplied partial setting objects without filtering key names or rejecting prototype-pollution / secret keys.
  - CSV export cells did not neutralize spreadsheet formula prefixes (`=`, `+`, `-`, `@`, `\t`).
- **Remediation:**
  - Added `ALLOWED_SETTINGS_KEYS` allowlist validation via `sanitizePartialSettings` (explicitly excluding `oauthClientSecret` and prototype keys).
  - Added `escapeCsvCell` to neutralize leading formula characters (`=`, `+`, `-`, `@`, `\t`) and double-quote embedded quotes (`""`).

#### SEC-11 — Unescaped `eventId` in Demo SVG, `.svg` Snapshot Export & Production Dev Helpers
- **Affected Files:** [`src/main/netatmoClient.ts`](../src/main/netatmoClient.ts), [`src/main/main.ts`](../src/main/main.ts)
- **Finding:**
  - Demo-mode snapshot generation interpolated `options.eventId` into SVG markup without XML escaping, and snapshot export allowed saving `.svg` image payloads.
  - `F12` DevTools toggling and the `WINATMO_CAPTURE_STORE_SCREENSHOTS` helper remained reachable without a packaged-app guard.
- **Remediation:**
  - Applied XML character escaping to `options.eventId` in demo SVG generation and disallowed `.svg` snapshots in `resolveEventSnapshotBuffer`.
  - Gated `F12` DevTools toggling and `WINATMO_CAPTURE_STORE_SCREENSHOTS` strictly behind `!app.isPackaged`.

---

### Dependency Audit (`npm audit`)

#### SEC-12 — `minimatch` ReDoS Advisory (`GHSA-g3hv-75wg-m249`) — Moderate (Build-Time Only, Open)
- **Affected File:** [`package.json`](../package.json) (`devDependencies`)
- **Finding:** `npm audit` flags `minimatch` `7.0.0 - 11.0.0` (`GHSA-g3hv-75wg-m249`, Moderate — ReDoS / globparts matching) as a transitive dependency of `electron-builder` (`26.18.0` -> `app-builder-lib` -> `@electron/universal` -> `minimatch`).
- **Assessment & Status:** **Accepted Build-Time Risk.** `electron-builder` is used solely for Windows packaging (`npm run build:msix`), and [`package.json`](../package.json) `build.files` excludes `node_modules` from packaged output so `minimatch` does not ship in `dist/main`, `dist/renderer`, or the distributed application. `npm audit fix --force` would forcibly downgrade `electron-builder` to `25.1.0`; therefore it is left untouched and tracked for upstream resolution in a future `electron-builder` release.

---

## Verified Existing Security Controls

During the audit, the following existing security controls were inspected and confirmed intact:

- **Parameterized SQLite Queries:** Database queries throughout [`src/main/database.ts`](../src/main/database.ts) consistently use `?` bound parameters with no raw string-interpolated SQL statements.
- **XSS-Safe Renderer Patterns:** No uses of `dangerouslySetInnerHTML`, `innerHTML`, `eval()`, or `new Function` were found in `src/renderer`; dynamic Leaflet HTML popup strings in [`src/renderer/components/RadarMapView.tsx`](../src/renderer/components/RadarMapView.tsx) use `escapeHtml()`.
- **External URL Opening Validation:** `shell:open-external` strictly allows `http:` and `https:` protocols before invoking `shell.openExternal`.
- **Main Window Sandboxing:** `mainWindow`, `widgetWindow`, and `debugWindow` enforce `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- **Loopback OAuth Binding & CSRF State:** The OAuth callback HTTP server binds exclusively to `127.0.0.1` and validates a cryptographically random 128-bit `state` nonce.

---

## Verification Summary

All remediations in commit [`d2eec46`](https://github.com/guidooswald/winAtmo/commit/d2eec46757241d794ad7afaf52736e648426c0b7) were verified after implementation:

- **Static Type Checking & Production Build:**
  - `npm run lint` (`tsc --noEmit`) passed with exit code `0`.
  - `npm run build` (`vite build` + `esbuild`) passed with exit code `0`.
- **Automated Electron Security Runtime Verification:**
  - Confirmed Windows DPAPI (`safeStorage`) availability and encrypted `flushSync()` quit persistence plus transient in-memory OAuth handling when `storeLocally === false`.
  - Confirmed `radarService` rejects missing/invalid proxy tokens, enforces `https:`-only upstream fetches and local-origin CORS, and serves cached radar tiles (`HIT`).
  - Confirmed `securityMediaProxy` blocks unauthorized tokens, SSRF targets (`127.0.0.1`, `169.254.169.254`, unregistered RFC1918 addresses -> HTTP `403`), and cross-origin CORS.
  - Confirmed `debugLogger` redacts tokens, JSON secrets, and VPN/LAN URL secret paths.
  - Confirmed `TimeSeriesDatabase` scrubs legacy `vpn_url`/`local_url` columns, `taskbarIcon` renders under `contextIsolation: true` + `sandbox: true`, and `RadarMapView` loads tokenized cached tiles with zero console errors.
  - Confirmed production `dist/renderer/index.html` enforcement of CSP headers, `window.winatmo.fetchSecurityMedia === undefined`, `will-navigate` external navigation blocking, and zero CSP violation errors.

---

## Maintenance Notes

- Electron logs a deprecation notice for synchronous `safeStorage.isEncryptionAvailable` / `safeStorage.encryptString` calls; in [`src/main/store.ts`](../src/main/store.ts), synchronous encryption is intentionally scoped exclusively to Electron's synchronous `before-quit` `flushSync()` lifecycle hook, while all regular writes use asynchronous `isAsyncEncryptionAvailable` / `encryptStringAsync`.
- Re-run `npm audit` when upgrading `electron-builder` to verify upstream remediation of `GHSA-g3hv-75wg-m249`.
