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
			width: "30rem",
		});

		const loginState = {
			pin: ctx.state<string | null>(null),
			status: ctx.state<string>(""),
			polling: ctx.state<boolean>(false),
			connected: ctx.state<boolean>(!!resolveAccessToken()),
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
					loginState.status.set("Connected! Your watchlist will sync now.");
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
			loginState.status.set("Disconnected. Token cleared.");
			tray.update();
		}

		// Render the tray content. Re-invoked after every tray.update().
		tray.render(() => {
			const items: any[] = [];

			items.push(
				tray.text("SIMKL Sync", { className: "font-semibold text-lg" }),
				tray.text("Connect your SIMKL account to enable watchlist syncing.", { className: "text-sm opacity-70" })
			);

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
							tray.button("Disconnect", {
								intent: "danger-subtle",
								onClick: ctx.eventHandler("listsync:tray:disconnect", () => disconnect()),
							}),
						],
						{ gap: 8 }
					)
				);
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

			return tray.stack(items, { gap: 10 });
		});
	});
}
