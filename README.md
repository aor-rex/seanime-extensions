# seanime-extensions (fork)

Personal fork of [`dot-fx/seanime-extensions`](https://github.com/dot-fx/seanime-extensions) for Seanime.

> Upstream has no license file; this fork is for personal use. All upstream extension code belongs to its original authors.

## Changes in this fork

### SIMKL custom source (`src/SIMKL`) — **Simkl V2** (`id: simklv2`)
- Movie support in addition to TV shows.
- **Watchlist** support via a SIMKL OAuth access token (PIN flow).
- Per-season TV/anime sources; bumped to `2.1.1`, points at the fork's raw URLs.
- Renamed to `simklv2` so it can be installed alongside (or replace) the community SIMKL extension.

### ListSync (`src/ListSync`)
Two-way sync between your SIMKL watchlist and your SIMKL V2 / TMDB V2 custom-source entries:

- **Push** — status/score changes on custom-source entries are posted to your simkl.com watchlist, plus a manual "Sync library now" backfill and delete handling.
- **Pull** — your simkl.com watchlist is written back into your library (per **reverse-sync-target**: SIMKL, TMDB V2, or both), creating new entries when they aren't in the collection yet.
- **`sync-anime`** (off by default) skips SIMKL anime so they never duplicate your native AniList anime.

**ListSync works with SIMKL V2 and TMDB V2**, not the community jabifx SIMKL:

- SIMKL V2 / TMDB V2 use *encoded* media ids (`movie 1e9+id`, `tv/anime 2e9|3e9 + id*1000 + season`), exactly the scheme ListSync plans with.
- Their siteUrls are the parseable forms (`simkl.com/movies|shows/…`, `themoviedb.org/movie|tv/…`).
- The community SIMKL uses **raw** simkl ids and `simkl.com/movie|tv|anime/…` siteUrls, which ListSync cannot match — install **Simkl V2** instead.

Manifest URL: `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/ListSync/manifest.json`

### Torrent providers (`src/*`)
| Provider | Type | Notes |
|---|---|---|
| `TPB` | torrent provider | The Pirate Bay via `apibay.org` JSON; series + movies; smart search with `S01Exx`. |
| `1337x` | torrent provider | HTML scrape (movies/tv categories); magnet fetched lazily from the torrent page. |
| `YTS` | torrent provider | Movies only (720p/1080p/4K); uses the YTS JSON API. |
| `EZTV` | torrent provider | Series episodes; magnets come straight from the search page. |
| `EXT` | torrent provider | EXT Torrents (`extto.com`) HTML scrape; signed per-request magnet links. |
| `Torrentio` | torrent provider | Streams via `torrentio.strem.fun`; `type: special` (search-only). Fork of `Crashdaemon/Seanime-Torrentio`. Resolves AniList IDs via ARM/YUNA, plus a fallback for **TMDB custom-source** media: decodes the synthetic ID, maps TMDB → IMDb via Wikidata, and queries Torrentio by IMDb. Stremio-catalog media (FNV-1a hash IDs) are **not** resolvable. |

The bundled `anime-torrent-provider.d.ts` / `core.d.ts` were added (they're missing from upstream) and lightly patched:
- `AnimeTorrent.magnetLink` / `infoHash` now allow `null`.
- `Media` gains `seasonYear`.

## Setup

1. Install the extensions in Seanime:
   - **Extensions → Add extensions → paste the manifest URL** for each provider you want, or drop the `src/<provider>/manifest.json` into Seanime's `extensions` data directory.

   Manifest URLs (the fork's raw GitHub links):

   | Extension | Type | ID | Manifest URL |
   |---|---|---|---|
   | **Simkl V2** | custom source | `simklv2` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/SIMKL/manifest.json` |
   | **TMDB V2** | custom source | `tmdbv2` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/TMDB/manifest.json` |
   | **ListSync** | plugin | `listsync` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/ListSync/manifest.json` |
   | **UI Translation** | plugin | `ui-translation` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/UI-Translation/manifest.json` |
   | **EXT Torrents** | torrent provider | `ext` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/EXT/manifest.json` |
   | **1337x** | torrent provider | `l337x` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/1337x/manifest.json` |
   | **YTS** | torrent provider | `yts` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/YTS/manifest.json` |
   | **EZTV** | torrent provider | `eztv` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/EZTV/manifest.json` |
   | **ThePirateBay V2** | torrent provider | `thepiratebayv2` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/TPB/manifest.json` |
   | **Torrentio V2** | torrent provider | `torrentiov2` | `https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/Torrentio/manifest.json` |

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
