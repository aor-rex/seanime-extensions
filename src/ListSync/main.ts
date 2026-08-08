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
	$app.onPreUpdateEntry((e) => {
		$store.set("PRE_UPDATE_ENTRY_DATA", $clone(e));
	});

	// ---- post-update: trigger the SIMKL push ----
	$app.onPostUpdateEntry((e) => {
		$store.set("POST_UPDATE_ENTRY", $clone(e));
	});

	// ---- post-delete: remove the entry from SIMKL ----
	$app.onPostDeleteEntry((e) => {
		$store.set("POST_DELETE_ENTRY", $clone(e));
	});

	// ---- UI VM: react to the store bridges and do the async work ----
	$ui.register((ctx) => {
		const CUSTOM_SOURCE_OFFSET = 2 ** 31;

		const SIMKL_API_BASE = "https://api.simkl.com";

		const STORAGE_BACKFILL_DONE = "listsync:backfill:done";

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

			// SIMKL movie: https://simkl.com/movies/<id>/<slug>
			m = real.match(/simkl\.com\/movies\/(\d+)/);
			if (m) return { category: "movies", ids: { simkl: Number(m[1]) } };

			// SIMKL show: https://simkl.com/shows/<id>/<slug>
			m = real.match(/simkl\.com\/shows\/(\d+)/);
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

		// Resolve the external id for a media id (custom-source ids resolve through the extension).
		function resolveExternalId(mediaId: number): ResolvedExternalId | undefined {
			const media = $anilist.getAnime(mediaId);
			if (!media || !media.siteUrl) {
				console.log(`listsync: media not found (${mediaId}), skipping`);
				return undefined;
			}
			return parseExternalId(media.siteUrl, media.format);
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
			const accessToken = $getUserPreference("access-token");
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
			const accessToken = $getUserPreference("access-token");
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
		async function syncEntries(): Promise<void> {
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

			if (payload.movies.length === 0 && payload.shows.length === 0) {
				console.log("listsync: backfill found no custom-source entries to sync");
				return;
			}

			await postToSimkl(payload);
		}

		// Push the status change to SIMKL.
		async function pushStatus(data: { mediaId: number; status?: string; scoreRaw?: number }): Promise<void> {
			const external = resolveExternalId(data.mediaId);
			if (!external) return;

			const item = buildAddItem({ status: data.status ?? "", scoreRaw: data.scoreRaw, ids: external.ids });
			if (!item) return;

			const payload: ListSyncPayload = { movies: [], shows: [] };
			payload[external.category].push(item);

			await postToSimkl(payload);
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
			if (!isEnabled()) return;

			const data = $store.get<{ mediaId?: number; status?: string; scoreRaw?: number }>("PRE_UPDATE_ENTRY_DATA");
			if (!data || data.mediaId !== e.mediaId) return;
			$store.set("PRE_UPDATE_ENTRY_DATA", null);

			try {
				await pushStatus({ mediaId: data.mediaId!, status: data.status, scoreRaw: data.scoreRaw });
			} catch (err) {
				console.error(`listsync: sync error -> ${(err as Error).message}`);
			}
		});

		$store.watch("POST_DELETE_ENTRY", async (e) => {
			if (!isEnabled()) return;
			if (!e.mediaId || e.mediaId < CUSTOM_SOURCE_OFFSET) return;

			try {
				const external = resolveExternalId(e.mediaId);
				if (!external) return;

				const payload = { movies: [], shows: [] } as { movies: { ids: Record<string, number> }[]; shows: { ids: Record<string, number> }[] };
				payload[external.category].push({ ids: external.ids });
				await removeFromSimkl(payload);
			} catch (err) {
				console.error(`listsync: delete sync error -> ${(err as Error).message}`);
			}
		});
	});
}
