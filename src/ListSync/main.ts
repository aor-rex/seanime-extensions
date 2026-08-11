/// <reference path="../app.d.ts" />
/// <reference path="../core.d.ts" />
/// <reference path="../plugin.d.ts" />

// ListSync
//
// Pushes list status updates (status + score) for custom-source entries
// (TMDB V2 / SIMKL) to the user's SIMKL watchlist.
//
// Native AniList entries are intentionally skipped (the community SimklSync
// plugin already handles those).
//
// Custom-source media ids are >= 2^31 (customsource.IsExtensionId).
//
// Architecture note: the loader VM runs this source and calls init(). Hooks
// are registered here (they only bridge into $store). The $ui.register
// callback is stringified and re-evaluated in a separate UI VM, so ALL
// constants, types, and helpers it needs are declared INSIDE the callback.

function init() {
	// ---- pre-update: stash the new status/score ----
	// Store minimal primitive objects only: the core clone/marshal layer for
	// $store.set is happy with plain JSON-safe values, but goja can panic on
	// rich nested clones of the event object.
	$app.onPreUpdateEntry((e) => {
		$store.set("PRE_UPDATE_ENTRY_DATA", { mediaId: e.mediaId, status: e.status, scoreRaw: e.scoreRaw });
	});

	// ---- post-update: trigger the SIMKL push ----
	$app.onPostUpdateEntry((e) => {
		$store.set("POST_UPDATE_ENTRY", { mediaId: e.mediaId });
	});

	// ---- post-delete: remove the entry from SIMKL ----
	$app.onPostDeleteEntry((e) => {
		$store.set("POST_DELETE_ENTRY", { mediaId: e.mediaId });
	});

	// ---- UI VM: react to the store bridges and do the async work ----
	$ui.register((ctx) => {
		const CUSTOM_SOURCE_OFFSET = 2 ** 31;

		const SIMKL_API_BASE = "https://api.simkl.com";

		const STORAGE_BACKFILL_DONE = "listsync:backfill:done";

		// Access token can come from the in-app PIN login (persisted to $storage) or
		// from the extension's "access-token" config field (power-user fallback).
		function resolveAccessToken(): string | undefined {
			return $storage.get("listsync.accessToken") ?? $getUserPreference("access-token") ?? undefined;
		}

		const SIMKL_STATUS_MAP: Record<string, string> = {
			PLANNING: "plantowatch",
			CURRENT: "watching",
			COMPLETED: "completed",
			DROPPED: "dropped",
			PAUSED: "hold",
			REPEATING: "watching",
		};

		interface ResolvedExternalId {
			/** Category key for the SIMKL payload */
			category: "movies" | "shows";
			/** The SIMKL ids object, e.g. { tmdb: 296 } or { simkl: 53536 } */
			ids: Record<string, number>;
		}

		interface ListSyncItem {
			to: string;
			ids: Record<string, number>;
			rating?: number;
		}

		interface ListSyncPayload {
			movies: ListSyncItem[];
			shows: ListSyncItem[];
		}

		// ------------------------------------------------------------------
		// Activity log
		// ------------------------------------------------------------------

		interface ActivityEntry {
			ts: number;
			action: string;
			message: string;
			result: "ok" | "error";
		}

		// NOTE: the activity array must NOT live at a key that is a prefix of
		// ACTIVITY_UNREAD_KEY - $storage nests dotted paths, so "listsync.activity"
		// would clobber/block "listsync.activity.unread". The ".log" suffix keeps
		// the two keys independent.
		const ACTIVITY_KEY = "listsync.activity.log";
		const ACTIVITY_UNREAD_KEY = "listsync.activity.unread";
		const ACTIVITY_MAX = 50;

		function getActivity(): ActivityEntry[] {
			const raw = $storage.get(ACTIVITY_KEY);
			return Array.isArray(raw) ? (raw as ActivityEntry[]) : [];
		}

		function updateBadge(): void {
			const unread = Number($storage.get(ACTIVITY_UNREAD_KEY)) || 0;
			const hasErrors = getActivity().some((a) => a.result === "error");
			tray.updateBadge({ number: unread, intent: hasErrors ? "alert" : "info" });
		}

		function pushActivity(action: string, message: string, result: "ok" | "error"): void {
			const entries = getActivity();
			entries.unshift({ ts: Date.now(), action, message, result });
			$storage.set(ACTIVITY_KEY, entries.slice(0, ACTIVITY_MAX));
			$storage.set(ACTIVITY_UNREAD_KEY, (Number($storage.get(ACTIVITY_UNREAD_KEY)) || 0) + 1);
			updateBadge();
			tray.update();
		}

		function markActivityRead(): void {
			$storage.set(ACTIVITY_UNREAD_KEY, 0);
			updateBadge();
		}

		function clearActivity(): void {
			$storage.set(ACTIVITY_KEY, []);
			$storage.set(ACTIVITY_UNREAD_KEY, 0);
			updateBadge();
			tray.update();
		}

		// ------------------------------------------------------------------
		// Reverse sync (SIMKL -> custom-source AniList entries)
		// ------------------------------------------------------------------

		const REVERSE_SIMKL_STATUS_MAP: Record<string, $app.AL_MediaListStatus> = {
			plantowatch: "PLANNING",
			watching: "CURRENT",
			completed: "COMPLETED",
			dropped: "DROPPED",
			hold: "PAUSED",
		};

		const SIMKL_HOST = "https://simkl.com";
		const TMDB_HOST = "https://www.themoviedb.org";

		interface ReverseSeason {
			number?: number;
		}

		interface ReverseItem {
			status?: string;
			user_rating?: number;
			seasons?: ReverseSeason[];
			movie?: { ids?: { simkl?: number; tmdb?: number }; title?: string; seasons?: ReverseSeason[] };
			show?: { ids?: { simkl?: number; tmdb?: number }; title?: string; seasons?: ReverseSeason[] };
			anime?: { ids?: { simkl?: number; tmdb?: number }; title?: string; seasons?: ReverseSeason[] };
		}

		interface PlannedEntry {
			mediaId: number;
			status: $app.AL_MediaListStatus;
			scoreRaw?: number;
		}

		// Build a custom-source media id using Seanime's bit layout:
		// 2^31 + (extensionIdentifier << 40) + localId.
		function buildMediaId(extIdentifier: number, localId: number): number {
			return CUSTOM_SOURCE_OFFSET + extIdentifier * 2 ** 40 + localId;
		}

		// Encode a local id using the TMDB extension scheme:
		// movie 1e9+id, tv 2e9+id*1000+season, anime 3e9+id*1000+season.
		function encodeLocalId(type: "movie" | "tv" | "anime", externalId: number, season: number): number {
			const n = Number(externalId);
			if (type === "movie") return 1000000000 + n;
			const base = type === "anime" ? 3000000000 : 2000000000;
			const s = Math.max(1, Math.min(season || 1, 999));
			return base + n * 1000 + s;
		}

		// Encode a local id using the SIMKL V2 extension scheme (SIMKL/main.ts):
		// movie 1e10+id, tv 2e10+id*1000+season, anime 3e10+id*1000+season.
		function encodeSimklLocalId(type: "movie" | "tv" | "anime", externalId: number, season: number): number {
			const n = Number(externalId);
			if (type === "movie") return 10000000000 + n;
			const base = type === "anime" ? 30000000000 : 20000000000;
			const s = Math.max(1, Math.min(season || 1, 999));
			return base + n * 1000 + s;
		}

		// Scan the merged collection for a custom-source entry whose real site URL
		// starts with `host` and return that extension's numeric identifier.
		function findExtIdentifierForHost(host: string): number | undefined {
			const collection = $anilist.getAnimeCollection(true);
			const lists = collection.MediaListCollection?.lists ?? [];
			for (const list of lists) {
				for (const entry of list.entries ?? []) {
					if (entry.id < CUSTOM_SOURCE_OFFSET) continue;
					const url = entry.media?.siteUrl ?? "";
					const idx = url.indexOf("|END|");
					if (idx < 0) continue;
					if (!url.slice(idx + "|END|".length).startsWith(host)) continue;
					return Math.floor((entry.id - CUSTOM_SOURCE_OFFSET) / 2 ** 40);
				}
			}
			return undefined;
		}

		function reverseSyncTarget(): string {
			const t = $getUserPreference("reverse-sync-target");
			return t === "tmdb" ? "tmdb" : t === "both" ? "both" : "simkl";
		}

		function seasonsOf(seasons?: ReverseSeason[]): number[] {
			if (!Array.isArray(seasons) || seasons.length === 0) return [1];
			const nums = seasons.map((s) => Number(s?.number)).filter((n) => !isNaN(n) && n > 0);
			return nums.length > 0 ? nums : [1];
		}

		// `seasons[]` is item-level watch state, but fall back to the media stub too.
		function seasonsOfItem(item: ReverseItem): number[] {
			return seasonsOf(item.seasons ?? item.show?.seasons ?? item.movie?.seasons ?? item.anime?.seasons);
		}

		let pendingClearTimer: (() => void) | null = null;

		// Clean up the pull-suppression set once the watcher has drained it (or after
		// a safety timeout, so a stale id never blocks future pushes).
		function schedulePendingClear(): void {
			if (pendingClearTimer) pendingClearTimer();
			const start = Date.now();
			pendingClearTimer = ctx.setInterval(() => {
				const pending = $storage.get("listsync.pull.pending");
				if (Array.isArray(pending) && pending.length > 0 && Date.now() - start < 15000) {
					return; // keep waiting for the watcher to drain
				}
				$storage.remove("listsync.pull.pending");
				if (pendingClearTimer) {
					pendingClearTimer();
					pendingClearTimer = null;
				}
			}, 1000);
		}

		// Scan the collection for SIMKL / TMDB custom-source entries and decode each
		// one into (a) lookup maps of external id -> existing media ids and (b) the
		// extension identifiers used to create new entries. Matching is scheme-agnostic:
		// SIMKL ids come from the siteUrl and TMDB ids + seasons from the encoded local
		// id, so both the community (raw) and V2 (encoded) schemes resolve to the
		// actual media ids in the collection.
		function scanCollectionForTargets(): {
			simklAnyExt?: number;
			simklV2Ext?: number;
			tmdbExt?: number;
			simklBySimklId: Record<number, number[]>;
			tmdbByKey: Record<string, number[]>;
		} {
			const collection = $anilist.getAnimeCollection(true);
			const lists = collection.MediaListCollection?.lists ?? [];

			const simklBySimklId: Record<number, number[]> = {};
			const tmdbByKey: Record<string, number[]> = {};
			let simklAnyExt: number | undefined;
			let simklV2Ext: number | undefined;
			let tmdbExt: number | undefined;

			for (const list of lists) {
				for (const entry of list.entries ?? []) {
					if (entry.id < CUSTOM_SOURCE_OFFSET) continue;
					const extId = Math.floor((entry.id - CUSTOM_SOURCE_OFFSET) / 2 ** 40);
					const localId = (entry.id - CUSTOM_SOURCE_OFFSET) % 2 ** 40;
					const url = entry.media?.siteUrl ?? "";
					const idx = url.indexOf("|END|");
					const real = idx >= 0 ? url.slice(idx + "|END|".length) : url;

					// TMDB: https://www.themoviedb.org/(movie|tv)/<id>
					const tmdbMatch = real.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
					if (tmdbMatch) {
						tmdbExt = tmdbExt ?? extId;
						const tmdbId = Number(tmdbMatch[1]);
						let season = 1;
						if (localId >= 2000000000) season = (localId - 2000000000) % 1000 || 1;
						const key = `${tmdbId}:${season}`;
						(tmdbByKey[key] ?? (tmdbByKey[key] = [])).push(entry.id);
						continue;
					}

					// SIMKL: simkl.com/(movies|shows|movie|tv|anime)/<id>/... or bare simkl.com/<id>
					const simklMatch = real.match(/simkl\.com\/(movies|shows|movie|tv|anime)\/(\d+)/) ?? real.match(/simkl\.com\/(\d+)/);
					if (simklMatch) {
						simklAnyExt = simklAnyExt ?? extId;
						if (simklMatch[1] === "movies" || simklMatch[1] === "shows") simklV2Ext = simklV2Ext ?? extId;
						const simklId = simklMatch[2] ? Number(simklMatch[2]) : Number(simklMatch[1]);
						(simklBySimklId[simklId] ?? (simklBySimklId[simklId] = [])).push(entry.id);
					}
				}
			}

			return { simklAnyExt, simklV2Ext, tmdbExt, simklBySimklId, tmdbByKey };
		}

		// Pull the user's SIMKL watchlist and write status/score into the target
		// custom-source lists (SIMKL / TMDB extension) via $anilist.updateEntry.
		async function pullFromSimkl(): Promise<{ pushed: number; skipped: number }> {
			console.log("listsync: pull started");
			const clientId = $getUserPreference("client-id");
			const accessToken = resolveAccessToken();
			if (!clientId || !accessToken) {
				console.log("listsync: pull skipped - missing client-id / access-token");
				pushActivity("pull", "Reverse sync skipped: set your Client ID / Access Token first", "error");
				ctx.toast.error("ListSync: set your Client ID and Access Token to pull from SIMKL");
				return { pushed: 0, skipped: 0 };
			}

			console.log("listsync: pull resolving target extensions");
			const target = reverseSyncTarget();
			const targetSimkl = target !== "tmdb";
			const targetTmdb = target !== "simkl";
			const syncAnime = $getUserPreference("sync-anime") === "true";

			// Scan the collection once and decode every custom-source entry into
			// per-external-id media id maps (for existing-entry updates) plus the
			// extension identifiers used to CREATE new entries.
			const lookup = scanCollectionForTargets();
			const simklAnyExt = targetSimkl ? lookup.simklAnyExt : undefined;
			const tmdbExt = targetTmdb ? lookup.tmdbExt : undefined;

			if (!simklAnyExt && !tmdbExt) {
				pushActivity("pull", "No SIMKL/TMDB entries in your collection yet — add one first", "error");
				ctx.toast.error("ListSync: add a SIMKL/TMDB entry to your collection before pulling");
				return { pushed: 0, skipped: 0 };
			}

			// NOTE: include_all_episodes=yes makes the payload enormous for large
			// watchlists (every episode for every show). We only need season-level
			// watch state, which all-items returns by default, so we omit it. A
			// generous timeout also guarantees the fetch can never hang forever.
			console.log(`listsync: pull fetching watchlist (simklExtId=${lookup.simklV2Ext} tmdbExtId=${tmdbExt})`);
			const res = await fetch(`${SIMKL_API_BASE}/sync/all-items/?extended=full`, {
				timeout: 90,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"simkl-api-key": clientId,
				},
			});
			console.log(`listsync: pull fetch resolved (status=${res.status})`);
			if (!res.ok) {
				console.error(`listsync: pull watchlist HTTP ${res.status}`);
				pushActivity("pull", `Failed to fetch SIMKL watchlist (HTTP ${res.status})`, "error");
				ctx.toast.error(`ListSync: failed to fetch watchlist (HTTP ${res.status})`);
				return { pushed: 0, skipped: 0 };
			}

			const data = res.json() as { movies?: ReverseItem[]; shows?: ReverseItem[]; anime?: ReverseItem[] };
			console.log(`listsync: pull parsed ${data.movies?.length ?? 0} movies, ${data.shows?.length ?? 0} shows, ${data.anime?.length ?? 0} anime`);

			const planned: PlannedEntry[] = [];
			let pushed = 0;
			let skipped = 0;

			// For each watchlist item: update existing collection entries when found
			// (matched scheme-agnostically by external id), otherwise create new ones
			// in the target extension(s) using their own id schemes.
			const apply = (item: ReverseItem, kind: "movie" | "show" | "anime", simklId: number, tmdbId: number | undefined, seasons: number[]): void => {
				const status = REVERSE_SIMKL_STATUS_MAP[item.status ?? ""];
				if (!status) {
					skipped++;
					return;
				}
				const scoreRaw = typeof item.user_rating === "number" && item.user_rating > 0 ? Math.round(item.user_rating * 10) : undefined;
				const type = kind === "movie" ? "movie" : kind === "anime" ? "anime" : "tv";
				let plannedAny = false;

				if (targetSimkl) {
					const ids = lookup.simklBySimklId[simklId] ?? [];
					if (ids.length > 0) {
						for (const mediaId of ids) planned.push({ mediaId, status, scoreRaw });
						plannedAny = true;
					} else if (lookup.simklV2Ext) {
						for (const season of seasons) {
							planned.push({ mediaId: buildMediaId(lookup.simklV2Ext, encodeSimklLocalId(type, simklId, season)), status, scoreRaw });
						}
						plannedAny = true;
					}
				}

				if (targetTmdb && tmdbId) {
					for (const season of seasons) {
						const ids = lookup.tmdbByKey[`${tmdbId}:${season}`] ?? [];
						if (ids.length > 0) {
							for (const mediaId of ids) planned.push({ mediaId, status, scoreRaw });
							plannedAny = true;
						} else if (tmdbExt) {
							planned.push({ mediaId: buildMediaId(tmdbExt, encodeLocalId(type === "anime" ? "tv" : type, tmdbId, season)), status, scoreRaw });
							plannedAny = true;
						}
					}
				}

				if (plannedAny) {
					pushed++;
				} else {
					skipped++;
				}
			};

			for (const item of data.movies ?? []) {
				const id = item.movie?.ids?.simkl;
				if (!id) {
					skipped++;
					continue;
				}
				apply(item, "movie", id, item.movie?.ids?.tmdb, [1]);
			}
			for (const item of data.shows ?? []) {
				const id = item.show?.ids?.simkl;
				if (!id) {
					skipped++;
					continue;
				}
				apply(item, "show", id, item.show?.ids?.tmdb, seasonsOfItem(item));
			}
			for (const item of data.anime ?? []) {
				// Skip anime when sync-anime is off so SIMKL anime never duplicate
				// native AniList entries.
				if (!syncAnime) {
					skipped++;
					continue;
				}
				const id = item.anime?.ids?.simkl;
				if (!id) {
					skipped++;
					continue;
				}
				apply(item, "anime", id, item.anime?.ids?.tmdb, seasonsOfItem(item));
			}

			// Register the suppression set BEFORE firing any updateEntry, so the
			// asynchronous POST_UPDATE_ENTRY watcher skips these media ids.
			$storage.set("listsync.pull.pending", planned.map((p) => p.mediaId));
			schedulePendingClear();

			// Each updateEntry runs synchronously on the UI VM scheduler, so a
			// large watchlist can keep it busy for a while. Track per-entry
			// failures and log progress so a stuck/failed update is visible and
			// one failure doesn't abort the whole pull.
			console.log(`listsync: pull applying ${planned.length} update(s)`);
			let failed = 0;
			const total = planned.length;
			for (let i = 0; i < total; i++) {
				const entry = planned[i];
				try {
					$anilist.updateEntry(entry.mediaId, entry.status, entry.scoreRaw, undefined, undefined, undefined);
				} catch (err) {
					failed++;
					console.error(`listsync: updateEntry failed for media ${entry.mediaId} -> ${(err as Error).message}`);
				}
				if ((i + 1) % 50 === 0 || i + 1 === total) {
					console.log(`listsync: pull progress ${i + 1}/${total} (${failed} failed)`);
				}
			}
			console.log(`listsync: pull done (applied=${total - failed}, failed=${failed})`);

			if (pushed > 0) {
				if (failed > 0) {
					pushActivity("pull", `Pulled ${pushed} item(s) from SIMKL${skipped ? ` (${skipped} skipped)` : ""} (${failed} failed)`, "error");
					ctx.toast.error(`ListSync: pulled ${pushed} item(s), ${failed} update(s) failed`);
				} else {
					pushActivity("pull", `Pulled ${pushed} item(s) from SIMKL${skipped ? ` (${skipped} skipped)` : ""}`, "ok");
					ctx.toast.success(`ListSync: pulled ${pushed} item(s) from SIMKL`);
				}
			} else {
				pushActivity("pull", `Nothing to pull${skipped ? ` (${skipped} skipped)` : ""}`, "ok");
			}
			return { pushed, skipped };
		}

		// Parse the real site URL out of a normalized custom-source siteUrl of the form
		// `ext_custom_source_<extId>|END|<realSiteUrl>` and resolve the external id.
		function parseExternalId(siteUrl: string, format?: string): ResolvedExternalId | undefined {
			const marker = "|END|";
			const idx = siteUrl.indexOf(marker);
			const real = idx >= 0 ? siteUrl.slice(idx + marker.length) : siteUrl;

			// TMDB movie: https://www.themoviedb.org/movie/<id>
			let m = real.match(/themoviedb\.org\/movie\/(\d+)/);
			if (m) return { category: "movies", ids: { tmdb: Number(m[1]) } };

			// TMDB tv: https://www.themoviedb.org/tv/<id>
			m = real.match(/themoviedb\.org\/tv\/(\d+)/);
			if (m) return { category: "shows", ids: { tmdb: Number(m[1]) } };

			// SIMKL movie: https://simkl.com/movies/<id>/<slug> or simkl.com/movie/<id>
			m = real.match(/simkl\.com\/movies\/(\d+)/) ?? real.match(/simkl\.com\/movie\/(\d+)/);
			if (m) return { category: "movies", ids: { simkl: Number(m[1]) } };

			// SIMKL show: https://simkl.com/shows/<id>/<slug> or simkl.com/(tv|anime)/<id>
			m = real.match(/simkl\.com\/shows\/(\d+)/) ?? real.match(/simkl\.com\/(?:tv|anime)\/(\d+)/);
			if (m) return { category: "shows", ids: { simkl: Number(m[1]) } };

			// SIMKL bare: https://simkl.com/<id> (no slug, type unknown) -> use format
			m = real.match(/simkl\.com\/(\d+)/);
			if (m) return { category: format === "MOVIE" ? "movies" : "shows", ids: { simkl: Number(m[1]) } };

			return undefined;
		}

		// Master on/off toggle. Defaults to on when unset.
		function isEnabled(): boolean {
			return $getUserPreference("enable-sync") !== "false";
		}

		// Resolve the external id for a collection entry's media without a fresh lookup.
		function resolveExternalIdFromEntry(entry: {
			media?: $app.AL_BaseAnime;
		}): ResolvedExternalId | undefined {
			if (!entry.media?.siteUrl) return undefined;
			return parseExternalId(entry.media.siteUrl, entry.media.format);
		}

		// POST /sync/add-to-list to set status (+ optional rating) on the user's watchlist.
		async function postToSimkl(payload: ListSyncPayload): Promise<boolean> {
			const clientId = $getUserPreference("client-id");
			const accessToken = resolveAccessToken();
			if (!clientId || !accessToken) {
				console.log("listsync: missing client-id or access-token, skipping");
				return false;
			}

			const res = await fetch(`${SIMKL_API_BASE}/sync/add-to-list`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
					"simkl-api-key": clientId,
				},
				body: JSON.stringify(payload),
			});

			if (res.ok) {
				console.log(`listsync: POST /sync/add-to-list ok -> ${JSON.stringify(payload)}`);
				return true;
			}
			console.error(`listsync: POST /sync/add-to-list failed (${res.status}) -> ${JSON.stringify(payload)}`);
			return false;
		}

		// POST /sync/history/remove to remove the media from the watchlist + history.
		async function removeFromSimkl(payload: { movies: { ids: Record<string, number> }[]; shows: { ids: Record<string, number> }[] }): Promise<boolean> {
			const clientId = $getUserPreference("client-id");
			const accessToken = resolveAccessToken();
			if (!clientId || !accessToken) {
				console.log("listsync: missing client-id or access-token, skipping");
				return false;
			}

			const res = await fetch(`${SIMKL_API_BASE}/sync/history/remove`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
					"simkl-api-key": clientId,
				},
				body: JSON.stringify(payload),
			});

			if (res.ok) {
				console.log(`listsync: POST /sync/history/remove ok -> ${JSON.stringify(payload)}`);
				return true;
			}
			console.error(`listsync: POST /sync/history/remove failed (${res.status}) -> ${JSON.stringify(payload)}`);
			return false;
		}

		// Build a single add-to-list item from a status + raw score.
		function buildAddItem(data: { status?: string; scoreRaw?: number; ids: Record<string, number> }): ListSyncItem | undefined {
			const to = data.status ? SIMKL_STATUS_MAP[data.status] : undefined;
			if (!to) return undefined;

			const item: ListSyncItem = { to, ids: data.ids };
			if (data.scoreRaw != null) item.rating = Math.round(data.scoreRaw / 10);
			return item;
		}

		// Backfill the whole custom-source library: push current status + score for every
		// custom-source collection entry in a single batched add-to-list request.
		async function syncEntries(): Promise<{ movies: number; shows: number }> {
			const collection = $anilist.getAnimeCollection(false);
			const lists = collection.MediaListCollection?.lists ?? [];

			const payload: ListSyncPayload = { movies: [], shows: [] };

			for (const list of lists) {
				for (const entry of list.entries ?? []) {
					// Custom-source entries have id >= 2^31
					if (entry.id < CUSTOM_SOURCE_OFFSET) continue;
					if (!entry.status) continue;

					const external = resolveExternalIdFromEntry(entry);
					if (!external) {
						console.log(`listsync: could not resolve external id for media ${entry.id}`);
						continue;
					}

					const item = buildAddItem({ status: entry.status, scoreRaw: entry.score, ids: external.ids });
					if (!item) continue;

					payload[external.category].push(item);
				}
			}

			const total = payload.movies.length + payload.shows.length;
			if (total === 0) {
				console.log("listsync: backfill found no custom-source entries to sync");
				return { movies: 0, shows: 0 };
			}

			const ok = await postToSimkl(payload);
			if (ok) {
				pushActivity("sync", `Pushed ${total} item(s) to SIMKL`, "ok");
				ctx.toast.success(`ListSync: pushed ${total} item(s) to SIMKL`);
			} else {
				pushActivity("sync", `Failed to push ${total} item(s) to SIMKL`, "error");
				ctx.toast.error("ListSync: failed to push library to SIMKL");
			}
			return { movies: payload.movies.length, shows: payload.shows.length };
		}

		// Push the status change to SIMKL.
		async function pushStatus(data: { mediaId: number; status?: string; scoreRaw?: number }): Promise<void> {
			const media = $anilist.getAnime(data.mediaId);
			if (!media || !media.siteUrl) return;

			const external = parseExternalId(media.siteUrl, media.format);
			if (!external) return;

			const item = buildAddItem({ status: data.status ?? "", scoreRaw: data.scoreRaw, ids: external.ids });
			if (!item) return;

			const payload: ListSyncPayload = { movies: [], shows: [] };
			payload[external.category].push(item);

			const ok = await postToSimkl(payload);
			const title = media.title?.userPreferred ?? media.title?.english ?? String(data.mediaId);
			if (ok) {
				pushActivity("status", `"${title}" → ${data.status ?? "no status"}`, "ok");
			} else {
				pushActivity("status", `Failed to sync "${title}"`, "error");
				ctx.toast.error(`ListSync: failed to sync "${title}"`);
			}
		}

		// Manual backfill: toggling "run-backfill" on reloads the plugin, so on init
		// we check the flag and run the sync exactly once (guarded by $storage).
		const runBackfill = $getUserPreference("run-backfill") === "true";
		if (runBackfill) {
			if ($storage.get(STORAGE_BACKFILL_DONE) !== "true") {
				if (!isEnabled()) {
					console.log("listsync: sync is disabled, skipping backfill");
				} else {
					syncEntries()
						.then(() => {
							$storage.set(STORAGE_BACKFILL_DONE, "true");
						})
						.catch((err) => {
							console.error(`listsync: backfill error -> ${(err as Error).message}`);
						});
				}
			} else {
				console.log("listsync: backfill already ran for this toggle (flip off then on to re-run)");
			}
		} else {
			// Toggle is off -> re-arm the backfill marker.
			$storage.remove(STORAGE_BACKFILL_DONE);
		}

		$store.watch("POST_UPDATE_ENTRY", async (e) => {
			try {
				if (!isEnabled()) return;

				const data = $store.get<{ mediaId?: number; status?: string; scoreRaw?: number }>("PRE_UPDATE_ENTRY_DATA");
				if (!data || data.mediaId !== e.mediaId) return;
				$store.set("PRE_UPDATE_ENTRY_DATA", null);

				// Skip entries written by a reverse-sync pull so they don't get pushed back
				// to SIMKL (they came FROM there).
				const pending = $storage.get("listsync.pull.pending");
				if (Array.isArray(pending) && pending.includes(e.mediaId)) {
					const remaining = pending.filter((id) => id !== e.mediaId);
					$storage.set("listsync.pull.pending", remaining);
					return;
				}

				await pushStatus({ mediaId: data.mediaId!, status: data.status, scoreRaw: data.scoreRaw });
			} catch (err) {
				console.error(`listsync: sync error -> ${(err as Error).message}`);
			}
		});

		$store.watch("POST_DELETE_ENTRY", async (e) => {
			try {
				if (!isEnabled()) return;
				if (!e.mediaId || e.mediaId < CUSTOM_SOURCE_OFFSET) return;

				const media = $anilist.getAnime(e.mediaId);
				if (!media || !media.siteUrl) return;

				const external = parseExternalId(media.siteUrl, media.format);
				if (!external) return;

				const payload = { movies: [], shows: [] } as { movies: { ids: Record<string, number> }[]; shows: { ids: Record<string, number> }[] };
				payload[external.category].push({ ids: external.ids });
				const ok = await removeFromSimkl(payload);

				const title = media.title?.userPreferred ?? media.title?.english ?? String(e.mediaId);
				if (ok) {
					pushActivity("delete", `Removed "${title}" from SIMKL`, "ok");
				} else {
					pushActivity("delete", `Failed to remove "${title}" from SIMKL`, "error");
					ctx.toast.error(`ListSync: failed to remove "${title}" from SIMKL`);
				}
			} catch (err) {
				console.error(`listsync: delete sync error -> ${(err as Error).message}`);
			}
		});

		// ------------------------------------------------------------------
		// SIMKL login tray (PIN/device flow)
		//
		// SIMKL disabled urn:ietf:wg:oauth:2.0:oob, so we use the PIN flow:
		//   GET  /oauth/pin            -> { user_code, verification_uri, interval, expires_in }
		//   GET  /oauth/pin/<code>     -> { result: "OK", access_token } | { result: "KO", ... }
		// The token is persisted to $storage so the sync functions pick it up.
		// ------------------------------------------------------------------

		const STORAGE_ACCESS_TOKEN = "listsync.accessToken";

		const TRAY_ICON = "https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/ListSync/icon.png";

		const tray = ctx.newTray({
			iconUrl: TRAY_ICON,
			withContent: true,
			width: "32rem",
		});

		// Restore the badge (unread activity count) on load.
		updateBadge();

		// One-time migration: older versions stored the activity array at
		// "listsync.activity", which collided with "listsync.activity.unread".
		// Move it to "listsync.activity.log" if present.
		if ($storage.get(ACTIVITY_KEY) == null && Array.isArray($storage.get("listsync.activity"))) {
			$storage.set(ACTIVITY_KEY, $storage.get("listsync.activity"));
			$storage.remove("listsync.activity");
		}

		const loginState = {
			pin: ctx.state<string | null>(null),
			status: ctx.state<string>(""),
			polling: ctx.state<boolean>(false),
			connected: ctx.state<boolean>(!!resolveAccessToken()),
			token: ctx.state<string | null>(null),
		};

		let pollCancel: (() => void) | null = null;

		function cancelPolling(): void {
			if (pollCancel) {
				pollCancel();
				pollCancel = null;
			}
		}

		// Start the PIN flow: request a user code, show it, then poll until authorized.
		async function startLogin(): Promise<void> {
			const clientId = $getUserPreference("client-id");
			if (!clientId) {
				loginState.status.set("Set your Client ID in the extension settings first.");
				tray.update();
				return;
			}

			cancelPolling();
			loginState.status.set("Requesting PIN...");
			loginState.pin.set(null);
			loginState.polling.set(true);
			tray.update();

			try {
				const res = await fetch(`${SIMKL_API_BASE}/oauth/pin?client_id=${encodeURIComponent(clientId)}&app-name=listsync&app-version=1.0`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = res.json() as { user_code: string; interval: number; expires_in: number; verification_uri?: string };

				if (!data.user_code) throw new Error("Invalid response from SIMKL");

				loginState.pin.set(data.user_code);
				loginState.status.set(`Enter the PIN at simkl.com/pin — valid for ${Math.round((data.expires_in ?? 900) / 60)} min`);
				tray.update();

				const intervalMs = (data.interval ?? 5) * 1000;
				pollCancel = ctx.setInterval(() => {
					poll(clientId, data.user_code);
				}, intervalMs);
			} catch (err) {
				loginState.status.set(`Error: ${(err as Error).message}`);
				loginState.polling.set(false);
				pushActivity("login", `Login error: ${(err as Error).message}`, "error");
				ctx.toast.error(`ListSync: ${(err as Error).message}`);
				tray.update();
			}
		}

		// Poll for authorization. Stops on success, expiry, or error.
		async function poll(clientId: string, userCode: string): Promise<void> {
			try {
				const res = await fetch(`${SIMKL_API_BASE}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(clientId)}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = res.json() as { result?: string; access_token?: string; message?: string };

				if (data.result === "OK" && data.access_token) {
					$storage.set(STORAGE_ACCESS_TOKEN, data.access_token);
					cancelPolling();
					loginState.pin.set(null);
					loginState.polling.set(false);
					loginState.connected.set(true);
					loginState.token.set(data.access_token);
					loginState.status.set("Connected! Token copied — paste it into SIMKL V2 settings.");
					pushActivity("login", "Connected to SIMKL", "ok");
					(ctx as any).dom.clipboard.write(data.access_token);
					ctx.toast.success("ListSync: connected. Token copied for SIMKL V2.");
					tray.update();
					return;
				}

				// device_code presence in the poll response means the code was consumed or expired.
				if (data.result === "KO") {
					loginState.status.set("Waiting for authorization...");
					tray.update();
				}
			} catch (err) {
				cancelPolling();
				loginState.polling.set(false);
				loginState.status.set(`Polling error: ${(err as Error).message}`);
				tray.update();
			}
		}

		// Clear the token from $storage (keeps the config field intact if set).
		function disconnect(): void {
			$storage.remove(STORAGE_ACCESS_TOKEN);
			cancelPolling();
			loginState.pin.set(null);
			loginState.polling.set(false);
			loginState.connected.set(false);
			loginState.token.set(null);
			loginState.status.set("Disconnected. Token cleared.");
			pushActivity("login", "Disconnected from SIMKL", "ok");
			tray.update();
		}

		// Opening the tray clears the unread badge. If auto-reverse-sync is enabled,
		// pull the SIMKL watchlist down into the custom-source lists.
		tray.onOpen(() => {
			markActivityRead();
			if ($getUserPreference("reverse-sync-auto") === "true" && isEnabled() && resolveAccessToken()) {
				pullFromSimkl().catch((err) => {
					console.error(`listsync: auto-pull failed -> ${(err as Error).message}`);
					pushActivity("pull", `Auto-pull error: ${(err as Error).message}`, "error");
				});
			}
		});

		function syncTabItems(): any[] {
			const items: any[] = [];
			const connected = loginState.connected.get();

			if (connected) {
				items.push(
					tray.badge("Connected", { intent: "success" }),
					tray.flex(
						[
							tray.button("Sync library now", {
								intent: "primary",
								onClick: ctx.eventHandler("listsync:tray:backfill", () => {
									$storage.remove(STORAGE_BACKFILL_DONE);
									syncEntries().catch((err) => {
										loginState.status.set(`Backfill error: ${(err as Error).message}`);
										tray.update();
									});
								}),
							}),
							tray.button("Pull from SIMKL", {
								intent: "success",
								onClick: ctx.eventHandler("listsync:tray:pull", () => {
									pullFromSimkl().catch((err) => {
										pushActivity("pull", `Pull error: ${(err as Error).message}`, "error");
									});
								}),
							}),
							tray.button("Disconnect", {
								intent: "danger-subtle",
								onClick: ctx.eventHandler("listsync:tray:disconnect", () => disconnect()),
							}),
						],
						{ gap: 8, direction: "column" }
					)
				);

				const token = loginState.token.get() ?? resolveAccessToken();
				if (token) {
					items.push(
						tray.text("SIMKL V2 access token:", { className: "text-xs opacity-70" }),
						tray.flex(
							[
								tray.input("Token", { value: token, disabled: true, size: "sm" }),
								tray.button("Copy", {
									intent: "gray-subtle",
									size: "sm",
									onClick: ctx.eventHandler("listsync:tray:copy-token", () => {
										const tok = loginState.token.get() ?? resolveAccessToken();
										if (tok) {
											(ctx as any).dom.clipboard.write(tok);
											ctx.toast.success("ListSync: token copied to clipboard");
										}
									}),
								}),
							],
							{ gap: 8 }
						)
					);
				}
			} else {
				const pin = loginState.pin.get();

				if (!pin) {
					items.push(
						tray.button("Connect to SIMKL", {
							intent: "primary",
							size: "md",
							loading: loginState.polling.get(),
							onClick: ctx.eventHandler("listsync:tray:login", () => startLogin()),
						})
					);
				} else {
					items.push(
						tray.text("Enter this code on the SIMKL website:", { className: "text-sm opacity-70" }),
						tray.text(pin, {
							className: "text-center font-bold text-2xl tracking-widest select-all",
							style: { userSelect: "all", letterSpacing: "0.5rem" },
						}),
						tray.anchor({
							text: "Open simkl.com/pin →",
							href: "https://simkl.com/pin",
							target: "_blank",
						}),
						tray.button("Cancel", {
							intent: "gray-subtle",
							onClick: ctx.eventHandler("listsync:tray:cancel", () => {
								cancelPolling();
								loginState.pin.set(null);
								loginState.polling.set(false);
								loginState.status.set("");
								tray.update();
							}),
						})
					);
				}
			}

			if (loginState.status.get()) {
				items.push(tray.text(loginState.status.get(), { className: "text-xs opacity-60" }));
			}

			return items;
		}

		function activityTabItems(): any[] {
			const items: any[] = [];
			const activity = getActivity();

			if (activity.length === 0) {
				items.push(tray.text("No activity yet. Sync your library or pull from SIMKL to get started.", { className: "text-sm opacity-60" }));
				return items;
			}

			for (const entry of activity.slice(0, 10)) {
				const d = new Date(entry.ts);
				const stamp = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")} ${d.toLocaleDateString()}`;
				items.push(
					tray.stack(
						[
							tray.flex(
								[
									tray.badge(entry.result === "ok" ? "OK" : "ERR", {
										intent: entry.result === "ok" ? "success" : "alert",
										size: "sm",
									}),
									tray.text(entry.action, { className: "text-xs font-medium" }),
									tray.text(stamp, { className: "text-xs opacity-50" }),
								],
								{ gap: 8 }
							),
							tray.text(entry.message, { className: "text-xs opacity-70" }),
						],
						{ gap: 2 }
					)
				);
			}

			items.push(
				tray.button("Clear log", {
					intent: "gray-subtle",
					size: "sm",
					onClick: ctx.eventHandler("listsync:tray:clear-activity", () => clearActivity()),
				})
			);

			return items;
		}

		// Render the tray content. Re-invoked after every tray.update().
		tray.render(() => {
			const items: any[] = [
				tray.text("ListSync", { className: "font-semibold text-lg" }),
				tray.text("Keep your TMDB / SIMKL library in sync with your SIMKL watchlist.", { className: "text-sm opacity-70" }),
				tray.tabs({
					defaultValue: "sync",
					items: [
						tray.tabsList({
							items: [
								tray.tabsTrigger(tray.text("Sync"), { value: "sync" }),
								tray.tabsTrigger(tray.text("Activity"), { value: "activity" }),
							],
						}),
						tray.tabsContent({
							value: "sync",
							items: syncTabItems(),
						}),
						tray.tabsContent({
							value: "activity",
							items: activityTabItems(),
						}),
					],
				}),
			];

			return tray.stack(items, { gap: 10 });
		});
	});
}
