# seanime-extensions (fork)

Personal fork of [`dot-fx/seanime-extensions`](https://github.com/dot-fx/seanime-extensions) for Seanime.

> Upstream has no license file; this fork is for personal use. All upstream extension code belongs to its original authors.

## Changes in this fork

### SIMKL custom source (`src/SIMKL`)
- Movie support in addition to TV shows.
- **Watchlist** support via a SIMKL OAuth access token (PIN flow).
- Per-season TV/anime sources; bumped to `2.1.0`, points at the fork's raw URLs.

### Torrent providers (`src/*`)
| Provider | Type | Notes |
|---|---|---|
| `TPB` | torrent provider | The Pirate Bay via `apibay.org` JSON; series + movies; smart search with `S01Exx`. |
| `1337x` | torrent provider | HTML scrape (movies/tv categories); magnet fetched lazily from the torrent page. |
| `YTS` | torrent provider | Movies only (720p/1080p/4K); uses the YTS JSON API. |
| `EZTV` | torrent provider | Series episodes; magnets come straight from the search page. |
| `EXT` | torrent provider | EXT Torrents (`extto.com`) HTML scrape; signed per-request magnet links. |

The bundled `anime-torrent-provider.d.ts` / `core.d.ts` were added (they're missing from upstream) and lightly patched:
- `AnimeTorrent.magnetLink` / `infoHash` now allow `null`.
- `Media` gains `seasonYear`.

## Setup

1. Install the extensions in Seanime:
   - **Extensions → Add extensions → paste the manifest URL** for each provider you want, or drop the `src/<provider>/manifest.json` into Seanime's `extensions` data directory.
2. SIMKL needs a **Client ID** (from https://simkl.com/settings/developer/) and, for the watchlist, an **Access Token** — generate one with the OAuth helper at `auth/callback.html` (see below).

## SIMKL OAuth (access token)

`auth/callback.html` runs the SIMKL **PIN flow** so you get a long-lived access token without exposing a client secret:

1. Open `auth/callback.html` (any static host; in Seanime you can open it in a browser).
2. Paste your SIMKL **Client ID**.
3. Follow the redirect, enter the PIN on simkl.com, authorize.
4. Copy the access token from the page and paste it into the SIMKL extension config.

A minimal static server from the repo root works: `python3 -m http.server 8000` → `http://localhost:8000/auth/callback.html`.

## Development

- **Playground**: torrent providers can be tested live in Seanime's extension playground.
- **Type check**: `npx tsc --noEmit --target es2020 --strict --skipLibCheck src/<provider>/main.ts`.

## Upstream

Original extensions & providers: https://github.com/dot-fx/seanime-extensions
