/// <reference path="../app.d.ts" />
/// <reference path="../core.d.ts" />
/// <reference path="../plugin.d.ts" />

// Stream Downloader
//
// Downloads episode sources from installed online-streaming providers to disk.
//
// Flow:
//   1. Pick a provider (GET /api/v1/extensions/list/onlinestream-provider)
//   2. Search AniList (GraphQL) for an anime -> pick it (mediaId)
//   3. episode-list  POST /api/v1/onlinestream/episode-list  { mediaId, provider, dubbed }
//   4. Pick an episode
//   5. episode-source POST /api/v1/onlinestream/episode-source { mediaId, provider, episodeNumber, dubbed }
//   6. Pick a source -> download (mp4 via ctx.downloader / m3u8 via ffmpeg $osExtra.asyncCmd)
//
// All app data flows through Seanime's own loopback HTTP API:
//   base URL defaults to http://127.0.0.1:43211 (configurable: "server-base-url").
//
// Notes:
//   - Requires the "system" scope (downloader + $osExtra) and non-strict security mode.
//   - Requires the app's online streaming feature enabled and at least one
//     online-streaming provider extension installed.
//   - m3u8 downloads need ffmpeg available via PATH (the manifest grants a
//     command scope for it).

function init() {
	$ui.register((ctx) => {
		const TRAY_ICON = "https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/StreamDownloader/icon.png";

		const DEFAULT_BASE_URL = "http://127.0.0.1:43211";

		// ------------------------------------------------------------------
		// Config
		// ------------------------------------------------------------------

		function baseUrl(): string {
			const v = ($getUserPreference("server-base-url") || "").trim();
			return v.length > 0 ? v.replace(/\/+$/, "") : DEFAULT_BASE_URL;
		}

		function downloadDirPref(): string {
			return ($getUserPreference("download-dir") || "").trim();
		}

		// ------------------------------------------------------------------
		// Async helpers (the whole runtime is the UI VM, so state lives here)
		// ------------------------------------------------------------------

		// API request to the Seanime loopback server. Returns res.json().data.
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
		// Local types
		// ------------------------------------------------------------------

		interface ProviderItem {
			id: string;
			name: string;
			lang?: string;
			episodeServers?: string[];
			supportsDub?: boolean;
		}

		interface AnilistSearchHit {
			id: number;
			title?: { romaji?: string; english?: string; native?: string };
			coverImage?: { extraLarge?: string; large?: string; medium?: string };
			format?: string;
			seasonYear?: number;
			episodes?: number;
			status?: string;
		}

		interface EpisodeItem {
			number: number;
			title?: string;
			image?: string;
			isFiller?: boolean;
		}

		interface VideoSource {
			server: string;
			headers?: Record<string, string>;
			url: string;
			label?: string;
			quality: string;
			type: "mp4" | "m3u8";
		}

		interface DownloadsEntry {
			id: string;
			label: string;
			dest: string;
			status: string;
			pct: number;
			speed: number;
			error?: string;
			elapsed?: number;
		}

		// ------------------------------------------------------------------
		// State
		// ------------------------------------------------------------------

		const providers = ctx.state<ProviderItem[]>([]);
		const providerSelected = ctx.state<string>("");
		const view = ctx.state<"search" | "episodes" | "sources" | "downloads">("search");
		const searchResults = ctx.state<AnilistSearchHit[]>([]);
		const searching = ctx.state<boolean>(false);
		const status = ctx.state<string>("");
		const loading = ctx.state<boolean>(false);

		const mediaTitle = ctx.state<string>("");
		const mediaId = ctx.state<number>(0);
		const episodes = ctx.state<EpisodeItem[]>([]);
		const episodeSelected = ctx.state<EpisodeItem | null>(null);
		const sources = ctx.state<VideoSource[]>([]);
		const dubbed = ctx.state<boolean>(false);

		const downloads = ctx.state<DownloadsEntry[]>([]);

		const searchRef = ctx.fieldRef<string>("");

		// ------------------------------------------------------------------
		// Download helpers
		// ------------------------------------------------------------------

		function sanitizeName(name: string): string {
			return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim() || "anime";
		}

		function buildDest(ext: string): { dir: string; full: string } {
			const dir = downloadDirPref().length > 0 ? downloadDirPref() : $osExtra.downloadDir();
			const title = sanitizeName(mediaTitle.get());
			const ep = episodeSelected.get();
			const epLabel = ep && ep.number > 0 ? ` - Episode ${ep.number}` : "";
			const file = `${title}${epLabel}.${ext}`;
			return { dir, full: dir + "/" + file };
		}

		function formatBytes(n: number): string {
			if (!n || n <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB", "TB"];
			const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
			return (n / Math.pow(1024, i)).toFixed(1) + " " + units[i];
		}

		function updateDownloadsEntry(id: string, patch: Partial<DownloadsEntry>): void {
			downloads.set((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
			tray.update();
		}

		async function startMp4Download(src: VideoSource, label: string): Promise<void> {
			const { dir, full } = buildDest("mp4");
			$os.mkdirAll(dir, 0o755);

			const downloadId = ctx.downloader.download(src.url, full, {
				headers: src.headers,
				timeout: 3600,
			});

			const entryId = `dl-${downloadId}`;
			downloads.set((prev) => [
				{ id: entryId, label, dest: full, status: "downloading", pct: 0, speed: 0 },
				...prev,
			]);

			const progress = ctx.downloader.watch(downloadId, (p: $ui.DownloadProgress) => {
				updateDownloadsEntry(entryId, {
					status: p.status,
					pct: p.percentage,
					speed: p.speed,
					error: p.status === "error" ? p.error : undefined,
				});
				if (p.status === "completed") {
					ctx.toast.success(`Downloaded: ${label}`);
				} else if (p.status === "error") {
					ctx.toast.error(`Download failed: ${p.error || "unknown error"}`);
				}
			});

			downloads.set((prev) => prev.map((d) => (d.id === entryId ? { ...d, cancel: () => { ctx.downloader.cancel(downloadId); progress(); } } : d)));
			tray.update();
		}

		async function startHlsDownload(src: VideoSource, label: string): Promise<void> {
			const { dir, full } = buildDest("mkv");
			$os.mkdirAll(dir, 0o755);

			const entryId = `hls-${Date.now()}`;
			downloads.set((prev) => [
				{ id: entryId, label, dest: full, status: "downloading", pct: 0, speed: 0 },
				...prev,
			]);
			tray.update();

			// ffmpeg -headers requires a CRLF-separated block. Build it from the source headers.
			const headersBlock = Object.entries(src.headers ?? {})
				.map(([k, v]) => `${k}: ${v}\r\n`)
				.join("");

			const args = ["-headers", headersBlock, "-i", src.url, "-c", "copy", "-y", full];

			let duration = 0;
			let lastTime = 0;
			const startTs = Date.now();

			const cmd = $osExtra.asyncCmd("ffmpeg", args);

			cmd.run((stdout, stderr, exitCode, signal) => {
				if (stderr !== undefined) {
					const line = $toString(stderr);
					const durMatch = line.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
					if (durMatch) {
						duration = (+durMatch[1] * 3600 + +durMatch[2] * 60) * 1000 + +durMatch[3].replace(".", "") * 10;
					}
					const timeMatch = line.match(/time=\s*(\d+):(\d+):(\d+\.\d+)/);
					if (timeMatch) {
						lastTime = (+timeMatch[1] * 3600 + +timeMatch[2] * 60) * 1000 + +timeMatch[3].replace(".", "") * 10;
						const pct = duration > 0 ? Math.min(100, (lastTime / duration) * 100) : 0;
						updateDownloadsEntry(entryId, { status: "downloading", pct, speed: lastTime / Math.max(1, (Date.now() - startTs) / 1000) });
					}
				}

				if (typeof exitCode === "number") {
					if (exitCode === 0) {
						updateDownloadsEntry(entryId, { status: "completed", pct: 100, speed: 0 });
						ctx.toast.success(`Downloaded: ${label}`);
					} else {
						updateDownloadsEntry(entryId, { status: "error", error: `ffmpeg exited with code ${exitCode}${signal ? ` (${signal})` : ""}` });
						ctx.toast.error(`Download failed (ffmpeg code ${exitCode})`);
					}
				}
			});
		}

		async function startDownload(src: VideoSource, label: string): Promise<void> {
			try {
				if (src.type === "m3u8") {
					await startHlsDownload(src, label);
				} else {
					await startMp4Download(src, label);
				}
			} catch (err) {
				status.set(`Download error: ${(err as Error).message}`);
				ctx.toast.error(`Download error: ${(err as Error).message}`);
				tray.update();
			}
		}

		// ------------------------------------------------------------------
		// Data loading
		// ------------------------------------------------------------------

		async function loadProviders(): Promise<void> {
			try {
				const items = await api<ProviderItem[]>("/api/v1/extensions/list/onlinestream-provider");
				providers.set(Array.isArray(items) ? items : []);
				if (providers.get().length === 0) {
					status.set("No online-streaming providers installed. Install one (e.g. HiAnime) first.");
				} else if (!providerSelected.get()) {
					providerSelected.set(providers.get()[0].id);
				}
				tray.update();
			} catch (err) {
				status.set(`Failed to load providers: ${(err as Error).message}`);
				tray.update();
			}
		}

		async function runSearch(): Promise<void> {
			const query = searchRef.current?.toString()?.trim() || "";
			if (!query) return;

			searching.set(true);
			status.set("");
			tray.update();

			try {
				// AniList GraphQL search (graphql.anilist.co is a whitelisted domain for plugin fetch).
				const res = await fetch("https://graphql.anilist.co", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: {
						query: `query ($search: String, $page: Int, $perPage: Int) {
							Page(page: $page, perPage: $perPage) {
								media(type: ANIME, search: $search, sort: SEARCH_MATCH) {
									id
									title { romaji english native }
									coverImage { extraLarge large medium }
									format
									seasonYear
									episodes
									status
								}
							}
						}`,
						variables: { search: query, page: 1, perPage: 12 },
					},
					timeout: 30,
				});
				if (!res.ok) {
					throw new Error(`AniList HTTP ${res.status}`);
				}
				const json = res.json();
				const hits: AnilistSearchHit[] = json?.data?.Page?.media ?? [];
				searchResults.set(hits);
				if (hits.length === 0) {
					status.set("No results on AniList. Try a different title.");
				}
			} catch (err) {
				status.set(`Search error: ${(err as Error).message}`);
			} finally {
				searching.set(false);
				tray.update();
			}
		}

		async function selectMedia(hit: AnilistSearchHit): Promise<void> {
			mediaId.set(hit.id);
			mediaTitle.set(hit.title?.english || hit.title?.romaji || hit.title?.native || `Anime ${hit.id}`);
			loading.set(true);
			status.set("");
			tray.update();

			try {
				const data = await api<{ episodes?: EpisodeItem[] }>("/api/v1/onlinestream/episode-list", {
					mediaId: hit.id,
					provider: providerSelected.get(),
					dubbed: dubbed.get(),
				});
				const eps = (data?.episodes ?? []).sort((a, b) => a.number - b.number);
				episodes.set(eps);
				if (eps.length === 0) {
					status.set("No episodes found for this provider/anime.");
				}
				episodeSelected.set(null);
				sources.set([]);
				view.set("episodes");
			} catch (err) {
				status.set(`Episode list error: ${(err as Error).message}`);
			} finally {
				loading.set(false);
				tray.update();
			}
		}

		async function selectEpisode(ep: EpisodeItem): Promise<void> {
			episodeSelected.set(ep);
			loading.set(true);
			status.set("");
			tray.update();

			try {
				const data = await api<{ videoSources?: VideoSource[] }>("/api/v1/onlinestream/episode-source", {
					mediaId: mediaId.get(),
					provider: providerSelected.get(),
					episodeNumber: ep.number,
					dubbed: dubbed.get(),
				});
				sources.set(data?.videoSources ?? []);
				if (sources.get().length === 0) {
					status.set("No video sources returned for this episode.");
				}
				view.set("sources");
			} catch (err) {
				status.set(`Source error: ${(err as Error).message}`);
			} finally {
				loading.set(false);
				tray.update();
			}
		}

		// ------------------------------------------------------------------
		// UI
		// ------------------------------------------------------------------

		function sourceLabel(src: VideoSource): string {
			const q = src.quality || "auto";
			const t = src.type === "m3u8" ? "HLS" : "MP4";
			return `${q} · ${t}${src.label ? " · " + src.label : ""}`;
		}

		function formatSpeed(n: number): string {
			return n >= 1000 ? `${(n / 1000).toFixed(1)} KB/s` : `${Math.round(n)} B/s`;
		}

		function searchView(): any[] {
			const items: any[] = [];

			items.push(
				tray.text("Search anime (AniList)", { className: "text-xs opacity-70" }),
				tray.input("Search title", { placeholder: "e.g. Frieren: Beyond Journey's End", fieldRef: searchRef, size: "md" }),
				tray.button("Search", {
					intent: "primary",
					loading: searching.get(),
					onClick: ctx.eventHandler("streamdownloader:search", () => {
						runSearch();
					}),
				})
			);

			if (searching.get()) {
				items.push(tray.text("Searching...", { className: "text-xs opacity-60" }));
				return items;
			}

			const hits = searchResults.get();
			if (hits.length === 0) {
				return items;
			}

			items.push(tray.text(`${hits.length} result(s) — pick one to load episodes:`, { className: "text-xs opacity-70" }));

			for (const hit of hits.slice(0, 8)) {
				const t = hit.title?.english || hit.title?.romaji || hit.title?.native || `Anime ${hit.id}`;
				const meta = [hit.seasonYear ? String(hit.seasonYear) : "", hit.format || "", hit.episodes ? `${hit.episodes} eps` : ""]
					.filter(Boolean)
					.join(" · ");
				items.push(
					tray.button(t, {
						size: "sm",
						loading: loading.get() && mediaId.get() === hit.id,
						onClick: ctx.eventHandler(`streamdownloader:media:${hit.id}`, () => {
							selectMedia(hit);
						}),
					})
				);
				if (meta) {
					items.push(tray.text(meta, { className: "text-[10px] opacity-50 -mt-1" }));
				}
			}

			return items;
		}

		function episodesView(): any[] {
			const items: any[] = [];
			items.push(
				tray.text(mediaTitle.get(), { className: "font-medium" }),
				tray.flex(
					[
						tray.button("← Back to search", {
							size: "sm",
							intent: "gray-subtle",
							onClick: ctx.eventHandler("streamdownloader:back-search", () => {
								view.set("search");
								tray.update();
							}),
						}),
					],
					{ gap: 4 }
				)
			);

			const eps = episodes.get();
			if (eps.length === 0) {
				items.push(tray.text("No episodes to show.", { className: "text-xs opacity-60" }));
				return items;
			}

			items.push(tray.text(`Provider: ${providerSelected.get()} — choose an episode:`, { className: "text-xs opacity-70" }));

			for (const ep of eps) {
				const label = ep.title && ep.title.length > 0 && !ep.title.startsWith("[") ? `Ep ${ep.number} · ${ep.title}` : `Episode ${ep.number}`;
				items.push(
					tray.button(label, {
						size: "sm",
						loading: loading.get() && episodeSelected.get()?.number === ep.number,
						onClick: ctx.eventHandler(`streamdownloader:episode:${ep.number}`, () => {
							selectEpisode(ep);
						}),
					})
				);
			}

			return items;
		}

		function sourcesView(): any[] {
			const items: any[] = [];
			items.push(
				tray.text(`${mediaTitle.get()} — Episode ${episodeSelected.get()?.number ?? "?"}`, { className: "font-medium" }),
				tray.flex(
					[
						tray.button("← Episodes", {
							size: "sm",
							intent: "gray-subtle",
							onClick: ctx.eventHandler("streamdownloader:back-episodes", () => {
								view.set("episodes");
								tray.update();
							}),
						}),
					],
					{ gap: 4 }
				)
			);

			const srcs = sources.get();
			if (srcs.length === 0) {
				items.push(tray.text("No video sources. Try a different episode.", { className: "text-xs opacity-60" }));
				return items;
			}

			items.push(tray.text("Choose a source to download:", { className: "text-xs opacity-70" }));

			for (let i = 0; i < srcs.length; i++) {
				const src = srcs[i];
				items.push(
					tray.button(sourceLabel(src), {
						size: "sm",
						intent: src.type === "m3u8" ? "warning-subtle" : "primary-subtle",
						onClick: ctx.eventHandler(`streamdownloader:source:${i}`, () => {
							startDownload(src, `${mediaTitle.get()} E${episodeSelected.get()?.number ?? ""} [${sourceLabel(src)}]`);
						}),
					})
				);
			}

			items.push(
				tray.text("Tip: HLS (.m3u8) sources are remuxed with ffmpeg; MP4 sources stream directly.", { className: "text-[10px] opacity-50" })
			);

			return items;
		}

		function downloadsView(): any[] {
			const items: any[] = [];
			const active = downloads.get();

			if (active.length === 0) {
				items.push(tray.text("No active downloads.", { className: "text-sm opacity-60" }));
				return items;
			}

			for (const d of active) {
				const pct = Math.round(d.pct);
				const statusLine =
					d.status === "completed" ? "Done" : d.status === "error" ? (d.error || "Failed") : `${pct}% · ${formatSpeed(d.speed)}`;

				items.push(
					tray.stack(
						[
							tray.flex(
								[
									tray.text(d.label, { className: "text-xs font-medium truncate" }),
									tray.badge(d.status === "completed" ? "Done" : d.status === "error" ? "Error" : "DL", {
										intent: d.status === "completed" ? "success" : d.status === "error" ? "alert" : "info",
										size: "sm",
									}),
								],
								{ gap: 6 }
							),
							tray.text(statusLine, { className: "text-[11px] opacity-60" }),
							tray.text(d.dest, { className: "text-[10px] opacity-40 truncate" }),
						],
						{ gap: 2 }
					)
				);

				if ((d as DownloadsEntry & { cancel?: () => void }).cancel) {
					items.push(
						tray.button("Cancel", {
							size: "xs",
							intent: "danger-subtle",
							onClick: ctx.eventHandler(`streamdownloader:cancel:${d.id}`, () => {
								(d as DownloadsEntry & { cancel?: () => void }).cancel?.();
							}),
						})
					);
				}
			}

			return items;
		}

		// ------------------------------------------------------------------
		// Tray
		// ------------------------------------------------------------------

		const tray = ctx.newTray({
			iconUrl: TRAY_ICON,
			withContent: true,
			width: "26rem",
			minHeight: "20rem",
		});

		tray.onOpen(() => {
			loadProviders();
		});

		tray.render(() => {
			const items: any[] = [
				tray.text("Stream Downloader", { className: "font-semibold text-lg" }),
				tray.text("Download online-streaming episode sources to disk.", { className: "text-sm opacity-70" }),
				tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
			];

			// Provider picker + dubbed toggle (persistent across views).
			const providerOpts = providers.get().map((p) => ({ label: p.name, value: p.id }));
			if (providerOpts.length > 0) {
				items.push(
					tray.flex(
						[
							tray.select("Provider", {
								options: providerOpts,
								value: providerSelected.get(),
								size: "sm",
								onChange: ctx.eventHandler("streamdownloader:provider", (e) => {
									const val = e?.value ?? (e as any)?.target?.value ?? "";
									if (val) providerSelected.set(val);
									tray.update();
								}),
							}),
							tray.switch("Dubbed", {
								value: dubbed.get(),
								onChange: ctx.eventHandler("streamdownloader:dubbed", (e) => {
									dubbed.set(Boolean(e?.value ?? e));
									tray.update();
								}),
							}),
						],
						{ gap: 8 }
					)
				);
			} else {
				items.push(tray.text("No streaming providers installed.", { className: "text-xs opacity-60" }));
			}

			items.push(tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }));

			switch (view.get()) {
				case "search":
					items.push(...searchView());
					break;
				case "episodes":
					items.push(...episodesView());
					break;
				case "sources":
					items.push(...sourcesView());
					break;
				case "downloads":
					items.push(...downloadsView());
					break;
			}

			// Global status line.
			if (status.get()) {
				items.push(
					tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
					tray.text(status.get(), { className: "text-[11px] opacity-70" })
				);
			}

			if (downloads.get().length > 0 && view.get() !== "downloads") {
				items.push(
					tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
					tray.button("View downloads", {
						size: "sm",
						intent: "gray-subtle",
						onClick: ctx.eventHandler("streamdownloader:view-downloads", () => {
							view.set("downloads");
							tray.update();
						}),
					})
				);
			}

			if (view.get() !== "search") {
				items.push(
					tray.button("New search", {
						size: "sm",
						intent: "gray-subtle",
						onClick: ctx.eventHandler("streamdownloader:new-search", () => {
							view.set("search");
							tray.update();
						}),
					})
				);
			}

			return tray.stack(items, { gap: 8 });
		});

		tray.open();
	});
}