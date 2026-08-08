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

const CUSTOM_SOURCE_OFFSET = 2 ** 31;

const SIMKL_API_BASE = "https://api.simkl.com";

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

// Push the status change to SIMKL.
async function pushStatus(data: { mediaId: number; status?: string; scoreRaw?: number }): Promise<void> {
	const clientId = $getUserPreference("client-id");
	const accessToken = $getUserPreference("access-token");
	if (!clientId || !accessToken) {
		console.log("listsync: missing client-id or access-token, skipping");
		return;
	}

	const to = data.status ? SIMKL_STATUS_MAP[data.status] : undefined;

	const media = $anilist.getAnime(data.mediaId);
	if (!media || !media.siteUrl) {
		console.log(`listsync: media not found (${data.mediaId}), skipping`);
		return;
	}

	const external = parseExternalId(media.siteUrl, media.format);
	if (!external) {
		console.log(`listsync: could not resolve external id for media ${data.mediaId}`);
		return;
	}

	const item: Record<string, any> = { ids: external.ids };
	if (to) item.to = to;
	if (data.scoreRaw != null) item.rating = Math.round(data.scoreRaw / 10);

	const payload: Record<string, any[]> = { movies: [], shows: [] };
	payload[external.category].push(item);

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
	} else {
		console.error(`listsync: POST /sync/add-to-list failed (${res.status}) -> ${JSON.stringify(payload)}`);
	}
}

// ---- pre-update: stash the new status/score ----
$app.onPreUpdateEntry((e) => {
	if (!e.mediaId || e.mediaId < CUSTOM_SOURCE_OFFSET) return;
	$store.set("PRE_UPDATE_ENTRY_DATA", $clone(e));
});

// ---- post-update: trigger the SIMKL push ----
$app.onPostUpdateEntry((e) => {
	if (!e.mediaId || e.mediaId < CUSTOM_SOURCE_OFFSET) return;
	$store.set("POST_UPDATE_ENTRY", $clone(e));
});

// ---- UI VM: react to the post-update bridge and do the async work ----
$ui.register(() => {
	$store.watch("POST_UPDATE_ENTRY", async (e) => {
		const data = $store.get<{ mediaId?: number; status?: string; scoreRaw?: number }>("PRE_UPDATE_ENTRY_DATA");
		if (!data || data.mediaId !== e.mediaId) return;
		$store.set("PRE_UPDATE_ENTRY_DATA", null);

		try {
			await pushStatus({ mediaId: data.mediaId!, status: data.status, scoreRaw: data.scoreRaw });
		} catch (err) {
			console.error(`listsync: sync error -> ${(err as Error).message}`);
		}
	});
});
