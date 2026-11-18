# Hosting P-Stream on your homeserver

This fork of P-Stream ships with **9 Zangetsu streaming sources ported in**
(plus the recovered built-in provider pack), and a docker-compose deployment
tailored for a home server. Everything runs on your LAN.

## What's inside

| Piece | What it does |
| --- | --- |
| `p-stream-web` container | The P-Stream frontend (nginx). Contains the ported sources. |
| `p-stream-proxy` container | CORS + m3u8 proxy (`deploy/simple-proxy/`). Provider scrapes and header-locked streams go through it. |
| `vendor/@p-stream/providers/` | The providers package (original was DMCA-taken-down) + the Zangetsu adapter. |
| `deploy/runtime-config.js` | Your settings (TMDB key, LAN IP). Edit without rebuilding. |

### Ported sources (Zangetsu providers)

HiAnime · AniKoto · Kartoons · AnimeCube (anime) — 4KHDHub · UHD Movies ·
HDHub4u · VegaMovies · MultiMovies (movies/series). They appear as
`zangetsu-*` in Settings → Sources and are tried first.

> TorBox was skipped (needs a personal API key). The CloudStream
> (`.cs3`) and Aniyomi (`.apk`) repos you linked are **compiled Android
> plugins** — they cannot run in a web app; the Zangetsu JS providers cover
> the same sites in a portable format.

## Setup (about 5 minutes)

### 1. Get a TMDB API read key

Create a free account at [themoviedb.org](https://www.themoviedb.org/signup),
then open **Settings → API** and copy the long **API Read Access Token**
(v4 token, starts with `eyJ…`).

### 2. Configure

Edit `deploy/runtime-config.js`:

```js
VITE_TMDB_READ_API_KEY: "eyJhbGciOi…",      // your TMDB read token
VITE_CORS_PROXY_URL: "http://192.168.1.50:8081",   // your server's LAN IP
VITE_M3U8_PROXY_URL: "http://192.168.1.50:8081",
```

Use the IP/hostname other devices on your network will type — not
`localhost` (that would point at the *client's* machine).

### 3. Start

```bash
docker compose up -d --build
```

- Web UI: **http://YOUR_SERVER_IP:8080**
- Proxy health check: http://YOUR_SERVER_IP:8081/ping → `pong`

### 4. Watch

Search a title, pick it, hit play. The scrape panel will run the sources
(Zangetsu ones first). First boot needs no onboarding — proxy and TMDB are
preconfigured.

## Changing settings

Edit `deploy/runtime-config.js`, then:

```bash
docker compose up -d --force-recreate p-stream
```

No rebuild needed (the file is volume-mounted into nginx).

## Updating sources

The Zangetsu providers are vendored at
`src/zangetsu/files/*.js` inside the providers package. To update them when
the upstream repo ([Spyou/zangetsu-providers](https://github.com/Spyou/zangetsu-providers))
changes:

```bash
# from the workspace root
cp ../zangetsu-providers/providers/*.js repos/providers-fork/src/zangetsu/files/
cp ../zangetsu-providers/index.json repos/providers-fork/src/zangetsu/files/manifest.json
cd repos/providers-fork && node scripts/gen-zangetsu.mjs && pnpm run build
# then re-vendor + rebuild (see scripts note in README)
```

Or simply ask me to refresh them.

## Optional: accounts backend

Progress sync across devices needs the backend service
([p-stream/backend](https://github.com/p-stream/backend)). Without it, watch
progress is stored per-device (still fully usable). If you want sync later,
run the backend on another port and set `VITE_BACKEND_URL` in
`deploy/runtime-config.js`.

## Optional: browser extension

Installing the [P-Stream extension](https://p-stream.github.io/docs/extension)
in your browser bypasses the proxy for stream playback (headers are applied
by the extension instead) and enables sources that hard-block proxies.
Without it, everything plays through the proxy container — that's the
default path here.

## Troubleshooting

- **"No playable streams" on everything** — check the proxy is up
  (`/ping`), and that the IP in `runtime-config.js` is the server's LAN IP.
- **A specific source fails** — streaming sites rotate domains and some
  block datacenter/cloud IPs; on a residential connection most work.
  Re-try other sources in the source list.
- **HLS plays but MP4 doesn't** — some direct-file hosts check Range
  headers strictly; the proxy forwards them, but a few hosts still
  misbehave behind proxies.
- **Rebuild from scratch** — `docker compose down && docker compose up -d --build`.

## Legal note

P-Stream and the ported sources host nothing: they scrape public sites.
Streaming copyrighted content without permission may be illegal where you
live — you are responsible for what you watch.
