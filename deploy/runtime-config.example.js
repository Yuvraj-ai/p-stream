// Template runtime configuration. Copy it to deploy/runtime-config.js and
// fill in your own values — deploy/runtime-config.js is git-ignored, so your
// keys and LAN IP never get committed.
//
// Get a free TMDB READ key at https://www.themoviedb.org/settings/api
// (the long "API Read Access Token", not the short v3 key).

window.__CONFIG__ = {
  // ── required ────────────────────────────────────────────────────────────
  VITE_TMDB_READ_API_KEY: "PASTE_YOUR_TMDB_READ_TOKEN_HERE",

  // URL of the proxy service (the `proxy` container). Must be reachable from
  // the DEVICES you watch on — use the homeserver's LAN IP or hostname.
  // Do NOT add a trailing slash.
  VITE_CORS_PROXY_URL: "http://YOUR_SERVER_IP:8081",
  VITE_M3U8_PROXY_URL: "http://YOUR_SERVER_IP:8081",

  // ── recommended ─────────────────────────────────────────────────────────
  // false = hash-based routing (works on any nginx without SPA rewrites)
  VITE_NORMAL_ROUTER: "false",
  // skip the first-run onboarding wizard (proxy + TMDB are preconfigured here)
  VITE_HAS_ONBOARDING: "false",
  VITE_HIDE_PROXY_ONBOARDING: "true",

  // ── optional ────────────────────────────────────────────────────────────
  // p-stream accounts/progress sync backend — leave null to keep everything
  // stored locally per device. See "Optional: accounts backend" in README.
  VITE_BACKEND_URL: null,
  // complaint email shown in the footer; null hides the link
  VITE_DMCA_EMAIL: null,
  VITE_DISALLOWED_IDS: "",
};
