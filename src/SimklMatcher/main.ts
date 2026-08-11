/// <reference path="../app.d.ts" />
/// <reference path="../core.d.ts" />
/// <reference path="../plugin.d.ts" />

// Simkl Matcher
//
// Resolves seanime's unmatched movies/series by searching SIMKL and matching
// them with one click. Skips anime (matching the user's SIMKL V2 "hide anime").
//
// Flow:
//   1. Scan  -> GET /api/v1/library/collection, collect unmatchedGroups.
//   2. Match -> For each unresolved cluster, search SIMKL (/search/tv, /search/movie)
//               and pick the best title (+ year) hit.
//   3. Build the exact runtime media id the user would have copied from SIMKL V2:
//         localId      = SIMKL encoded id (movie 1e10+id, tv/anime base+id*1000+season)
//         mediaId      = 2^31 + (simklv2 extensionIdentifier << 40) + localId
//   4. POST /api/v1/library/anime-entry/manual-match  { paths, mediaId }
//
// The SIMKL V2 extension identifier is resolved at runtime from
// GET /api/v1/extensions/list/custom-source (it is assigned per install, not fixed).
//
// All app data flows through Seanime's own loopback HTTP API:
//   base URL defaults to http://127.0.0.1:43211 (configurable: "server-base-url").

function init() {
	$ui.register((ctx) => {
		const TRAY_ICON = "https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/SimklMatcher/icon.png";
		const SERVER_BASE_DEFAULT = "http://127.0.0.1:43211";

		// SIMKL V2 id scheme (must stay in sync with src/SIMKL/main.ts)
		const SIMKL_API_BASE = "https://api.simkl.com";
		const MOVIE_OFFSET = 10000000000;
		const TV_OFFSET = 20000000000;
		const ANIME_OFFSET = 30000000000;

		// Seanime custom-source runtime id layout (customsource/customsource.go)
		const CUSTOM_SOURCE_OFFSET = 2147483648; // 2^31
		const MAX_EXT_IDENTIFIER = 1023;
		const MAX_LOCAL_ID = (2 ** 40) - 1; // 2^40 - 1

		const SIMKL_EXTENSION_ID = "simklv2";
		const MATCH_THRESHOLD = 8;

		// The runtime replaces {{client-id}} with the value saved in this
		// plugin's "client-id" user config field.
		const SIMKL_CLIENT_ID = "{{client-id}}";

		// ------------------------------------------------------------------
		// Local types
		// ------------------------------------------------------------------

		interface ParsedInfo {
			original?: string;
			title?: string;
			season?: string;
			episode?: string;
			year?: string;
		}

		interface LocalFile {
			path: string;
			name: string;
			parsedInfo?: ParsedInfo;
			mediaId: number;
		}

		interface UnmatchedGroup {
			dir: string;
			localFiles?: LocalFile[];
		}

		interface MatchCluster {
			title: string;
			season: number;
			year?: number;
			paths: string[];
			label: string;
		}

		interface SimklIds {
			simkl?: number;
			simkl_id?: number;
		}

		interface SimklItem {
			title?: string;
			en_title?: string;
			title_en?: string;
			year?: number;
			type?: string;
			endpoint_type?: string;
			anime_type?: string;
			ids?: SimklIds;
		}

		type MatchStatus = "matched" | "no-match" | "anime" | "error";

		interface MatchResult {
			cluster: MatchCluster;
			status: MatchStatus;
			mediaId?: number;
			matchTitle?: string;
			message?: string;
		}

		// ------------------------------------------------------------------
		// Config
		// ------------------------------------------------------------------

		function baseUrl(): string {
			const v = ($getUserPreference("server-base-url") || "").trim();
			return v.length > 0 ? v.replace(/\/+$/, "") : SERVER_BASE_DEFAULT;
		}

		function hasClientId(): boolean {
			const k = String(SIMKL_CLIENT_ID || "").trim();
			return k.length > 0 && !k.includes("{{");
		}

		// ------------------------------------------------------------------
		// API helpers
		// ------------------------------------------------------------------

		async function api<T = any>(path: string, body?: any): Promise<T> {
			const res = await fetch(baseUrl() + path, {
				method: body !== undefined ? "POST" : "GET",
				headers: { "Content-Type": "application/json" },
				body,
				timeout: 60,
				noCloudflareBypass: true,
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const data = res.json();
			if (data && data.error) {
				throw new Error(data.error);
			}
			return data.data ?? data;
		}

		// ------------------------------------------------------------------
		// SIMKL helpers
		// ------------------------------------------------------------------

		function typeOf(item: SimklItem): "movie" | "tv" | "anime" {
			const t = String(item?.type ?? item?.endpoint_type ?? "").toLowerCase();
			if (t === "movie" || t === "movies") return "movie";
			if (t === "anime" || t === "animes" || t === "ona") return "anime";
			if (item?.anime_type) return "anime";
			return "tv";
		}

		function simklIdOf(item: SimklItem): number | undefined {
			return item?.ids?.simkl ?? item?.ids?.simkl_id;
		}

		// SIMKL V2 encoded id: movie 1e10+id, tv/anime base + id*1000 + season.
		function encodeSimklId(type: "movie" | "tv" | "anime", simklId: number, season: number): number {
			const id = Number(simklId);
			if (type === "movie") return MOVIE_OFFSET + id;
			const s = Math.max(1, Math.min(season || 1, 999));
			const base = type === "anime" ? ANIME_OFFSET : TV_OFFSET;
			return base + id * 1000 + s;
		}

		// Seanime runtime id: 2^31 + (extensionIdentifier << 40) + localId.
		function buildMediaId(extIdentifier: number, localId: number): number {
			const ei = Number(extIdentifier) & MAX_EXT_IDENTIFIER;
			const lid = Number(localId) & MAX_LOCAL_ID;
			return CUSTOM_SOURCE_OFFSET + ei * (2 ** 40) + lid;
		}

		function normalize(s: string): string {
			return String(s || "")
				.toLowerCase()
				.replace(/&/g, " and ")
				.replace(/\W+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		}

		function tokenOverlap(a: string, b: string): number {
			const ta = normalize(a).split(" ").filter(Boolean);
			const tb = normalize(b).split(" ").filter(Boolean);
			if (!ta.length || !tb.length) return 0;
			const set = new Set<string>();
			for (const t of tb) set.add(t);
			let inter = 0;
			for (const t of ta) if (set.has(t)) inter++;
			return inter / Math.min(ta.length, tb.length);
		}

		function scoreHit(queryTitle: string, queryYear: number | undefined, item: SimklItem): number {
			const titles = [item?.title, item?.en_title, item?.title_en].filter(
				(t): t is string => !!t && String(t).trim().length > 0
			);
			if (titles.length === 0) return 0;

			const qn = normalize(queryTitle);
			if (!qn) return 0;

			let bestTitleScore = 0;
			for (const raw of titles) {
				const tn = normalize(raw);
				if (!tn) continue;
				if (qn === tn) {
					bestTitleScore = 1;
					break;
				}
				let s = tokenOverlap(qn, tn);
				if (tn.includes(qn) && qn.length >= 4) s = Math.max(s, 0.9);
				if (qn.includes(tn) && tn.length >= 4) s = Math.max(s, 0.85);
				bestTitleScore = Math.max(bestTitleScore, s);
			}

			let score = bestTitleScore * 10;

			const itemYear = Number(item?.year) || 0;
			const qy = Number(queryYear) || 0;
			if (qy > 0 && itemYear > 0) {
				if (qy === itemYear) score += 2;
				else if (Math.abs(qy - itemYear) <= 1) score += 1;
				else score -= 2;
			}
			return score;
		}

		async function searchSimkl(query: string): Promise<SimklItem[]> {
			const q = encodeURIComponent(query);
			const all: SimklItem[] = [];
			const types = ["tv", "movie"];
			for (const t of types) {
				const res = await fetch(`${SIMKL_API_BASE}/search/${t}?q=${q}&page=1&limit=10&extended=full`, {
					headers: {
						"Content-Type": "application/json",
						"simkl-api-key": SIMKL_CLIENT_ID,
					},
					timeout: 45,
					noCloudflareBypass: true,
				});
				if (!res.ok) continue;
				const data = res.json<any>();
				if (Array.isArray(data)) {
					for (const it of data) all.push(it);
				}
			}
			return all;
		}

		// ------------------------------------------------------------------
		// Title parsing
		// ------------------------------------------------------------------

		const RELEASE_TAGS = /\b(?:[0-9]{3,4}p|bluray|blu-?ray|web-?dl|webrip|hdrip|hdtv|dvdrip|x26[45]|hevc|h\.?26[45]|ac3|dts|aac|10bit|8bit|remux|hdr|dolby|truehd|atmos|imax)\b/gi;

		function cleanTitle(raw: string): string {
			return String(raw || "")
				.replace(/\s*[\[\(][^\])]*[\])]\s*/g, " ")
				.replace(RELEASE_TAGS, " ")
				.replace(/\s+/g, " ")
				.trim();
		}

		function extractYear(...parts: string[]): number | undefined {
			for (const p of parts) {
				const m = String(p || "").match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
				if (m) {
					const y = parseInt(m[1], 10);
					if (y >= 1900 && y <= new Date().getFullYear() + 2) return y;
				}
			}
			return undefined;
		}

		function firstInt(s: string | undefined): number | undefined {
			if (!s) return undefined;
			const m = String(s).match(/\d+/);
			if (!m) return undefined;
			const n = parseInt(m[0], 10);
			return isNaN(n) ? undefined : n;
		}

		function dirBaseName(dir: string): string {
			const parts = String(dir || "").replace(/\\/g, "/").split("/").filter(Boolean);
			return parts.length ? parts[parts.length - 1] : "";
		}

		const ANIME_FANSUB_TAG = /\[(?:subsplease|horriblesubs|erai-raws|toonshub)\]/i;

		function looksLikeAnime(group: UnmatchedGroup, files: LocalFile[]): boolean {
			for (const f of files) {
				if (ANIME_FANSUB_TAG.test(String(f.name || ""))) return true;
			}
			return ANIME_FANSUB_TAG.test(String(group?.dir || ""));
		}

		function buildClusters(group: UnmatchedGroup): MatchCluster[] {
			const files = (group?.localFiles ?? []).filter((lf) => lf && !!lf.path && lf.mediaId === 0);
			if (files.length === 0) return [];

			const baseDir = dirBaseName(group?.dir || "");
			const byKey = new Map<string, { title: string; season: number; year?: number; paths: string[] }>();

			for (const lf of files) {
				const p = lf.parsedInfo ?? {};
				const seasonNum = firstInt(p.season);
				const season = seasonNum && seasonNum >= 1 ? seasonNum : 1;
				const parsedTitle = cleanTitle(p.title || p.original || "");
				const title = parsedTitle || cleanTitle(baseDir);
				const year =
					extractYear(lf.name, lf.path, p.original || "", p.year || "") ||
					extractYear(baseDir);
				const key = `${title}|${season}`;

				let cluster = byKey.get(key);
				if (!cluster) {
					cluster = { title, season, paths: [] };
					byKey.set(key, cluster);
				}
				if (!cluster.year) cluster.year = year;
				cluster.paths.push(lf.path);
			}

			const clusters: MatchCluster[] = [];
			byKey.forEach((c) => {
				clusters.push({
					title: c.title,
					season: c.season,
					year: c.year,
					paths: c.paths,
					label: c.year ? `${c.title} (${c.year})` : c.title,
				});
			});
			return clusters;
		}

		// ------------------------------------------------------------------
		// Data loading
		// ------------------------------------------------------------------

		async function fetchUnmatched(): Promise<UnmatchedGroup[]> {
			const data = await api<{ unmatchedGroups?: UnmatchedGroup[] }>("/api/v1/library/collection");
			return data?.unmatchedGroups ?? [];
		}

		// The SIMKL V2 extension identifier is assigned per install (1-1023).
		async function resolveSimklIdentifier(): Promise<number | undefined> {
			try {
				const list = await api<Array<{ id: string; extensionIdentifier?: number }>>(
					"/api/v1/extensions/list/custom-source"
				);
				const simkl = (list ?? []).find((e) => String(e?.id).toLowerCase() === SIMKL_EXTENSION_ID);
				if (simkl && typeof simkl.extensionIdentifier === "number") {
					return simkl.extensionIdentifier;
				}
			} catch (err) {
				// fall through to the collection scan below
			}
			return findSimklIdentifierInCollection();
		}

		// Fallback: derive the identifier from an existing SIMKL-matched entry.
		function findSimklIdentifierInCollection(): number | undefined {
			try {
				const collection = $anilist.getAnimeCollection(true) as any;
				const lists = collection?.MediaListCollection?.lists ?? [];
				for (const list of lists) {
					for (const entry of list.entries ?? []) {
						const id = Number(entry?.id);
						if (!id || id < CUSTOM_SOURCE_OFFSET) continue;
						const url = String(entry?.media?.siteUrl ?? "");
						const tagged = url.startsWith("ext_custom_source_simklv2");
						const simklUrl =
							url.includes("|END|") && url.slice(url.indexOf("|END|") + 5).startsWith("https://simkl.com");
						if (tagged || simklUrl) {
							return Math.floor((id - CUSTOM_SOURCE_OFFSET) / 2 ** 40);
						}
					}
				}
			} catch (err) {
				// ignore
			}
			return undefined;
		}

		async function matchCluster(cluster: MatchCluster, extIdentifier: number): Promise<MatchResult> {
			try {
				const items = await searchSimkl(cluster.title);
				let best: { item: SimklItem; score: number } | undefined;
				for (const item of items) {
					const t = typeOf(item);
					if (t === "anime") continue;
					const sid = simklIdOf(item);
					if (!sid) continue;
					const s = scoreHit(cluster.title, cluster.year, item);
					if (s >= MATCH_THRESHOLD && (!best || s > best.score)) {
						best = { item, score: s };
					}
				}

				if (!best) {
					return { cluster, status: "no-match", message: "No SIMKL match found" };
				}

				const t = typeOf(best.item);
				const sid = simklIdOf(best.item)!;
				const season = t === "movie" ? 1 : cluster.season;
				const local = encodeSimklId(t, sid, season);
				const mediaId = buildMediaId(extIdentifier, local);

				await api("/api/v1/library/anime-entry/manual-match", {
					paths: cluster.paths,
					mediaId,
				});

				return {
					cluster,
					status: "matched",
					mediaId,
					matchTitle: best.item.title || best.item.en_title || t,
				};
			} catch (err) {
				return { cluster, status: "error", message: (err as Error).message };
			}
		}

		async function scan(): Promise<void> {
			status.set("Scanning library...");
			working.set(true);
			tray.update();
			try {
				const groups = await fetchUnmatched();
				unmatched.set(groups);
				const totalFiles = groups.reduce((acc, g) => acc + (g?.localFiles ?? []).filter((f) => f.mediaId === 0).length, 0);
				const summary = groups.length
					? `${groups.length} unresolved group${groups.length === 1 ? "" : "s"} · ${totalFiles} file${totalFiles === 1 ? "" : "s"}`
					: "No unresolved media - everything is matched";
				status.set(summary);
				tray.updateBadge({ number: groups.length, intent: "info" });
			} catch (err) {
				status.set(`Scan failed: ${(err as Error).message}`);
			} finally {
				working.set(false);
				tray.update();
			}
		}

		async function matchAll(): Promise<void> {
			if (!hasClientId()) {
				status.set("Set your SIMKL Client ID (API key) in the plugin settings first.");
				tray.update();
				ctx.toast.warning("Simkl Matcher: SIMKL API key is missing.");
				return;
			}

			working.set(true);
			status.set("Preparing...");
			tray.update();

			try {
				// Always refetch so we only match files that are still unresolved.
				const groups = await fetchUnmatched();
				unmatched.set(groups);

				const clusters: { cluster: MatchCluster; likelyAnime: boolean }[] = [];
				for (const g of groups) {
					const files = (g?.localFiles ?? []).filter((lf) => lf && !!lf.path && lf.mediaId === 0);
					const anime = looksLikeAnime(g, files);
					for (const c of buildClusters(g)) {
						clusters.push({ cluster: c, likelyAnime: anime });
					}
				}

				if (clusters.length === 0) {
					status.set("No unresolved media to match.");
					tray.update();
					return;
				}

				const extIdentifier = await resolveSimklIdentifier();
				if (extIdentifier === undefined) {
					status.set("Could not find the SIMKL V2 extension identifier. Is SIMKL V2 installed?");
					tray.update();
					ctx.toast.error("Simkl Matcher: SIMKL V2 extension not found.");
					return;
				}

				const results: MatchResult[] = [];
				for (let i = 0; i < clusters.length; i++) {
					const entry = clusters[i];
					if (entry.likelyAnime) {
						results.push({
							cluster: entry.cluster,
							status: "anime",
							message: "Skipped (anime)",
						});
						continue;
					}
					status.set(`Matching ${i + 1}/${clusters.length} — ${entry.cluster.label}...`);
					tray.update();
					results.push(await matchCluster(entry.cluster, extIdentifier));
				}

				lastRun.set(results);
				persistLastRun(results);

				const matched = results.filter((r) => r.status === "matched").length;
				const noMatch = results.filter((r) => r.status === "no-match").length;
				const anime = results.filter((r) => r.status === "anime").length;
				const errors = results.filter((r) => r.status === "error").length;
				status.set(`Done · ${matched} matched · ${noMatch} no match · ${anime} skipped · ${errors} error${errors === 1 ? "" : "s"}`);
				ctx.toast.success(`Simkl Matcher: matched ${matched} of ${results.length}.`);

				// Refresh the unresolved list + badge without clobbering the summary.
				try {
					const remaining = await fetchUnmatched();
					unmatched.set(remaining);
					tray.updateBadge({ number: remaining.length, intent: "info" });
				} catch (err) {
					// ignore, keep the last status line
				}
			} catch (err) {
				status.set(`Match failed: ${(err as Error).message}`);
				ctx.toast.error(`Simkl Matcher: ${(err as Error).message}`);
			} finally {
				working.set(false);
				tray.update();
			}
		}

		// ------------------------------------------------------------------
		// State
		// ------------------------------------------------------------------

		const unmatched = ctx.state<UnmatchedGroup[]>([]);
		const lastRun = ctx.state<MatchResult[]>([]);
		const status = ctx.state<string>("");
		const working = ctx.state<boolean>(false);

		// Persist the last run so the report survives a tray reopen.
		const LAST_RUN_KEY = "simkl-matcher.last-run";
		const saved = $storage.get(LAST_RUN_KEY);
		if (Array.isArray(saved)) {
			lastRun.set(saved);
		}
		function persistLastRun(results: MatchResult[]): void {
			$storage.set(LAST_RUN_KEY, results);
		}

		// ------------------------------------------------------------------
		// UI
		// ------------------------------------------------------------------

		function resultBadge(r: MatchResult): { text: string; intent: any } {
			switch (r.status) {
				case "matched":
					return { text: "Matched", intent: "success" };
				case "no-match":
					return { text: "No match", intent: "gray" };
				case "anime":
					return { text: "Skipped", intent: "blue" };
				default:
					return { text: "Error", intent: "alert" };
			}
		}

		const tray = ctx.newTray({
			iconUrl: TRAY_ICON,
			withContent: true,
			width: "30rem",
			minHeight: "22rem",
		});

		tray.onOpen(() => {
			scan();
		});

		tray.render(() => {
			const items: any[] = [
				tray.text("Simkl Matcher", { className: "font-semibold text-lg" }),
				tray.text("Resolve seanime's unmatched movies/series via SIMKL automatically.", {
					className: "text-sm opacity-70",
				}),
				tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
			];

			items.push(
				tray.flex(
					[
						tray.button("Scan library", {
							size: "sm",
							intent: "gray-subtle",
							loading: working.get(),
							onClick: ctx.eventHandler("simklmatcher:scan", () => {
								scan();
							}),
						}),
						tray.button("Match unresolved", {
							size: "sm",
							intent: "primary",
							disabled: unmatched.get().length === 0 || working.get(),
							loading: working.get(),
							onClick: ctx.eventHandler("simklmatcher:match-all", () => {
								matchAll();
							}),
						}),
					],
					{ gap: 6 }
				)
			);

			if (status.get()) {
				items.push(
					tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
					tray.text(status.get(), { className: "text-[11px] opacity-80" })
				);
			}

			const results = lastRun.get();
			if (results.length > 0) {
				items.push(
					tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
					tray.text("Last run", { className: "text-xs font-medium opacity-70" })
				);
				for (const r of results) {
					const badge = resultBadge(r);
					const detail = r.status === "matched"
						? `${r.matchTitle || ""} · ${r.cluster.paths.length} file${r.cluster.paths.length === 1 ? "" : "s"}`
						: (r.message || badge.text);
					items.push(
						tray.stack(
							[
								tray.flex(
									[
										tray.text(r.cluster.label, { className: "text-xs font-medium truncate" }),
										tray.badge(badge.text, { intent: badge.intent, size: "sm" }),
									],
									{ gap: 6 }
								),
								tray.text(detail, { className: "text-[11px] opacity-60 truncate" }),
							],
							{ gap: 2 }
						)
					);
				}
			} else if (unmatched.get().length > 0) {
				items.push(
					tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
					tray.text("Press \"Match unresolved\" to search SIMKL and match everything at once.", {
						className: "text-[11px] opacity-60",
					})
				);
			}

			return tray.stack(items, { gap: 8 });
		});

		tray.open();
	});
}
