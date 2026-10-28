# Privacy Policy for winAtmo

**Effective Date:** October 28, 2026  
**Last Updated:** October 28, 2026  

winAtmo is a privacy-first, local-first Windows desktop client for Netatmo Personal Weather Stations and Air Quality Monitors. This Privacy Policy describes how winAtmo handles your data.

---

## 1. Summary

- **Zero Tracking:** winAtmo contains **no analytics, no telemetry, no tracking scripts, and no advertising**.
- **No Third-Party Servers:** The developer of winAtmo does not own, operate, or maintain any intermediate backend servers. The app communicates directly and exclusively with Netatmo's official cloud APIs.
- **Local Data Storage:** All weather data, historical measurements, settings, and credentials reside solely on your local computer.
- **Hardware-Level Encryption:** Sensitive credentials and authentication tokens are encrypted at rest using the **Windows Data Protection API (DPAPI)**.

---

## 2. Information We Handle

### A. Authentication Credentials & Tokens
To fetch your weather data, winAtmo connects to your Netatmo account through official authentication methods:
- **Netatmo Web Login / OAuth 2.0:** Authentication occurs directly between your computer and Netatmo's authentication servers (`auth.netatmo.com` and `api.netatmo.com`).
- **Encryption at Rest:** Received access tokens, refresh tokens, and session cookies are encrypted on your hard drive using Electron's `safeStorage` API, which leverages **Windows DPAPI** (tied to your Windows user account).
- **Access:** Your passwords and login credentials are never visible to, stored by, or transmitted to the developer of winAtmo.

### B. Weather Station & Sensor Measurements
- winAtmo downloads sensor readings (temperature, humidity, $\text{CO}_2$, barometric pressure, noise, rainfall, wind) and station topology (module names, battery status, Wi-Fi/RF signal strength) from Netatmo's servers.
- These measurements are stored locally in an SQLite database file (`winatmo-history.db`) in your Windows User Application Data folder (`%APPDATA%\winatmo`).
- This data is used solely to render your local dashboards, historical charts, and taskbar widget. It is never uploaded, shared, or analyzed outside your PC.

### C. Application Preferences
- User interface preferences (such as selected theme, temperature/pressure/wind units, taskbar widget position, widget size, and pinned sensor choices) are stored locally in `%APPDATA%\winatmo\winatmo-config.json`.

---

## 3. Network Communication

winAtmo initiates network connections strictly for the following purposes:
1. **Netatmo Cloud Services:**
   - Authenticating your account via `auth.netatmo.com` and `api.netatmo.com`.
   - Querying live station metrics (`/api/getstationsdata`, `/api/gethomecoachsdata`).
   - Querying historical measurements (`/api/getmeasure`).
2. **Microsoft Store (if installed via Store):**
   - Application installation, automatic updates, and licensing checks are handled directly by the Windows Store client and Microsoft infrastructure.

No requests are ever made to any other analytics, logging, advertising, or third-party servers.

---

## 4. Third-Party Privacy Policies & Terms

Your use of Netatmo cloud services and APIs through winAtmo is governed by Netatmo's official agreements:
- **Netatmo Privacy Policy:** [https://legals.netatmo.com/?goto=privacy](https://legals.netatmo.com/?goto=privacy)
- **Netatmo Terms of Use:** [https://legals.netatmo.com/?goto=terms](https://legals.netatmo.com/?goto=terms)
- **Netatmo Connect API Documentation:** [https://dev.netatmo.com/](https://dev.netatmo.com/)

If you obtain winAtmo via the Microsoft Store, your download is subject to Microsoft's Privacy Statement:
- **Microsoft Privacy Statement:** [https://privacy.microsoft.com/](https://privacy.microsoft.com/)

---

## 5. Non-Affiliation & Trademark Disclaimer

winAtmo is an independent, non-commercial, open-source client application. It is not affiliated with, endorsed by, certified by, or sponsored by Netatmo SAS or Legrand. "Netatmo" is a registered trademark of Netatmo SAS. All product names, logos, and brands are property of their respective owners.

---

## 6. Data Retention & Deletion

You retain full ownership and control over your data:
- **Revoking Access:** You can revoke winAtmo's access at any time by signing out within the app or by revoking third-party app permissions in your Netatmo account portal at [my.netatmo.com](https://my.netatmo.com).
- **Deleting Stored Data:** You can permanently delete all local cache, database history, and stored tokens at any time by deleting the application data folder located at:
  ```
  %APPDATA%\winatmo
  ```
  Uninstalling winAtmo (via Windows Settings or the Microsoft Store) removes the application.

---

## 7. Children's Privacy

winAtmo does not collect any personal data from anyone, including children under the age of 13 (or under the applicable age of digital consent).

---

## 8. Changes to this Privacy Policy

If any changes are made to this Privacy Policy, the updated document will be published directly in the winAtmo repository with an updated revision date.

---

## 9. Contact & Inquiries

For questions, feedback, or inquiries regarding winAtmo or this Privacy Policy, please open an issue on GitHub:
- **GitHub Repository:** [https://github.com/guidooswald/winAtmo](https://github.com/guidooswald/winAtmo)
- **Issues:** [https://github.com/guidooswald/winAtmo/issues](https://github.com/guidooswald/winAtmo/issues)
