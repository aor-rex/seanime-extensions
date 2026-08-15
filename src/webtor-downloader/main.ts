/// <reference path="../app.d.ts" />
/// <reference path="../core.d.ts" />
/// <reference path="../plugin.d.ts" />

// Webtor.io Downloader Plugin
//
// Flow:
//   1. Toggle ON in tray -> captures torrent searches via $app.onTorrentSearch hook
//   2. User searches torrents in Seanime -> results stored in plugin state
//   3. Tray shows recent torrents with "Download via Webtor.io" buttons
//   4. User clicks -> plugin calls Webtor.io API -> streams download to disk
//   5. File registered in Seanime library via $database.localFiles.insert
//
// Webtor.io API:
//   POST /resource/ {magnet} -> {id}
//   GET /resource/{id}/list -> {items: [{id, name, type, size, ...}]}
//   GET /resource/{id}/export/{content_id}?output=download -> {exports: {content_id: {url}}}

function init() {
	$ui.register((ctx) => {
		const TRAY_ICON = "https://raw.githubusercontent.com/aor-rex/seanime-extensions/master/src/webtor-downloader/icon.png";
		const WEBTOR_API = "https://api.webtor.io/v1";

		// ------------------------------------------------------------------
		// Config
		// ------------------------------------------------------------------
		function downloadDir(): string {
			const pref = ($getUserPreference("download-dir") || "").trim();
			return pref.length > 0 ? pref : $osExtra.downloadDir();
		}

		// ------------------------------------------------------------------
		// State
		// ------------------------------------------------------------------
		const enabled = ctx.state<boolean>(false);
		const recentTorrents = ctx.state<Array<{
			infoHash: string;
			name: string;
			size: number;
			formattedSize: string;
			seeders: number;
			leechers: number;
			magnetLink: string | null;
			provider: string;
			resolution: string;
			episodeNumber: number;
			isBatch: boolean;
			mediaTitle: string;
			mediaId: number;
			capturedAt: number;
		}>>([]);
		const downloads = ctx.state<Array<{
			id: string;
			label: string;
			dest: string;
			status: "downloading" | "completed" | "error";
			pct: number;
			speed: number;
			error?: string;
		}>>([]);
		const status = ctx.state<string>("");
		const manualInput = ctx.fieldRef<string>("");
		const searching = ctx.state<boolean>(false);

		// ------------------------------------------------------------------
		// Helpers
		// ------------------------------------------------------------------
		function sanitizeName(name: string): string {
			return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim() || "download";
		}

		function formatBytes(n: number): string {
			if (!n || n <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB", "TB"];
			const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
			return (n / Math.pow(1024, i)).toFixed(1) + " " + units[i];
		}

		function formatSpeed(n: number): string {
			return n >= 1024 ? `${(n / 1024).toFixed(1)} KB/s` : `${Math.round(n)} B/s`;
		}

		function updateDownload(id: string, patch: Partial<typeof downloads.get()[0]>): void {
			downloads.set((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
			tray.update();
		}

		function pushStatus(msg: string): void {
			status.set(msg);
			tray.update();
			setTimeout(() => { if (status.get() === msg) status.set(""); tray.update(); }, 8000);
		}

		// ------------------------------------------------------------------
		// Hook: Capture torrent searches when enabled
		// ------------------------------------------------------------------
		$app.onTorrentSearch((e) => {
			if (enabled.get() && e.searchData?.torrents) {
				const mediaTitle = e.options?.media?.englishTitle || e.options?.media?.romajiTitle || "Unknown";
				const mediaId = e.options?.media?.id || 0;
				const captured = e.searchData.torrents
					.filter((t: any) => t.infoHash || t.magnetLink)
					.map((t: any) => ({
						infoHash: t.infoHash || "",
						name: t.name,
						size: t.size || 0,
						formattedSize: t.formattedSize || formatBytes(t.size || 0),
						seeders: t.seeders || 0,
						leechers: t.leechers || 0,
						magnetLink: t.magnetLink || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}` : null),
						provider: t.provider || "unknown",
						resolution: t.resolution || "",
						episodeNumber: t.episodeNumber || -1,
						isBatch: t.isBatch || false,
						mediaTitle,
						mediaId,
						capturedAt: Date.now(),
					}));
				recentTorrents.set((prev) => [...captured, ...prev].slice(0, 30));
				tray.update();
			}
			e.next();
		});

		// ------------------------------------------------------------------
		// Webtor.io API Client
		// ------------------------------------------------------------------
		async function addResource(magnet: string): Promise<string> {
			const res = await ctx.fetch(`${WEBTOR_API}/resource/`, {
				method: "POST",
				body: magnet,
				headers: { "Content-Type": "text/plain" },
				timeout: 120,
			});
			if (!res.ok) throw new Error(`Add resource failed: ${res.status}`);
			const data = res.json();
			if (!data?.id) throw new Error("No resource ID returned");
			return data.id;
		}

		async function listFiles(resourceId: string): Promise<Array<{id: string; name: string; type: string; size: number; index: number}>> {
			const res = await ctx.fetch(`${WEBTOR_API}/resource/${resourceId}/list`, { timeout: 60 });
			if (!res.ok) throw new Error(`List files failed: ${res.status}`);
			const data = res.json();
			return (data?.items || []).filter((f: any) => f.type === "file");
		}

		async function getDownloadUrl(resourceId: string, contentId: string): Promise<string> {
			const res = await ctx.fetch(`${WEBTOR_API}/resource/${resourceId}/export/${contentId}?output=download`, { timeout: 60 });
			if (!res.ok) throw new Error(`Get download URL failed: ${res.status}`);
			const data = res.json();
			const url = data?.exports?.[contentId]?.url;
			if (!url) throw new Error("No download URL in response");
			return url;
		}

		// ------------------------------------------------------------------
		// Streaming Download
		// ------------------------------------------------------------------
		async function streamDownload(url: string, filename: string, downloadId: string): Promise<string> {
			const dir = downloadDir();
			$os.mkdirAll(dir, 0o755);
			const safeName = sanitizeName(filename);
			const destPath = `${dir}/${safeName}`;

			const res = await ctx.fetch(url, { timeout: 0 }); // no timeout for streaming
			if (!res.ok) throw new Error(`Download request failed: ${res.status}`);

			const file = $os.create(destPath);
			const writer = $bufio.newWriter(file);

			const reader = $bufio.newReader(res.body);
			const buffer = new Uint8Array(64 * 1024);
			let total = 0;
			const startTime = Date.now();

			while (true) {
				const n = reader.read(buffer);
				if (n === 0) break;
				writer.write(buffer.subarray(0, n));
				total += n;

				const elapsed = (Date.now() - startTime) / 1000;
				const speed = elapsed > 0 ? total / elapsed : 0;
				const pct = -1; // unknown total size
				updateDownload(downloadId, { status: "downloading", pct, speed });
			}

			writer.flush();
			file.close();
			return destPath;
		}

		// ------------------------------------------------------------------
		// Register in Seanime Library
		// ------------------------------------------------------------------
		async function registerLocalFile(filepath: string, filename: string, mediaId: number, episode: number): Promise<void> {
			try {
				$database.localFiles.insert([{
					path: filepath,
					name: filename,
					mediaId,
					locked: false,
					ignored: false,
					metadata: {
						episode,
						aniDBEpisode: String(episode),
						type: "main",
					},
				}]);
				$app.invalidateClientQuery(["library", "anime", mediaId]);
				$app.invalidateClientQuery(["entry", mediaId]);
				pushStatus("Added to library");
			} catch (err) {
				pushStatus(`Library register failed: ${(err as Error).message}`);
			}
		}

		// ------------------------------------------------------------------
		// Download Flow
		// ------------------------------------------------------------------
		async function startDownload(torrent: typeof recentTorrents.get()[0]): Promise<void> {
			if (!torrent.magnetLink) {
				pushStatus("No magnet link available");
				return;
			}

			const downloadId = `dl-${Date.now()}`;
			const label = `${torrent.mediaTitle} - ${torrent.name}`;

			downloads.set((prev) => [{
				id: downloadId,
				label,
				dest: "",
				status: "downloading",
				pct: 0,
				speed: 0,
			}, ...prev]);

			tray.update();

			try {
				pushStatus("Adding to Webtor.io...");
				const resourceId = await addResource(torrent.magnetLink);

				pushStatus("Fetching file list...");
				const files = await listFiles(resourceId);
				if (files.length === 0) throw new Error("No files in torrent");

				// Pick largest video file
				const videoExts = [".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts", ".m2ts"];
				const videoFiles = files.filter((f) => videoExts.some((ext) => f.name.toLowerCase().endsWith(ext)));
				if (videoFiles.length === 0) throw new Error("No video files found");

				const target = videoFiles.reduce((a, b) => a.size > b.size ? a : b);

				pushStatus("Getting download URL...");
				const downloadUrl = await getDownloadUrl(resourceId, target.id);

				pushStatus("Downloading...");
				const destPath = await streamDownload(downloadUrl, target.name, downloadId);

				updateDownload(downloadId, { status: "completed", pct: 100, speed: 0, dest: destPath });
				pushStatus("Download complete");

await registerLocalFile(destPath, target.name, torrent.mediaId, torrent.episodeNumber > 0 ? torrent.episodeNumber : 1);
			ctx.toast.success(`Downloaded: ${target.name}`);
			} catch (err) {
				const msg = (err as Error).message;
				updateDownload(downloadId, { status: "error", error: msg });
				pushStatus(`Error: ${msg}`);
				ctx.toast.error(`Download failed: ${msg}`);
			} finally {
				tray.update();
			}
		}

		// ------------------------------------------------------------------
		// Manual magnet/hash download
		// ------------------------------------------------------------------
		async function startManualDownload(): Promise<void> {
			const input = manualInput.current?.trim() || "";
			if (!input) return;

			const magnet = input.startsWith("magnet:") ? input : (input.match(/^[a-fA-F0-9]{40}$/) ? `magnet:?xt=urn:btih:${input}` : "");
			if (!magnet) {
				pushStatus("Invalid magnet link or info hash");
				return;
			}

			const downloadId = `dl-${Date.now()}`;
			const label = `Manual: ${input.slice(0, 50)}`;

			downloads.set((prev) => [{
				id: downloadId,
				label,
				dest: "",
				status: "downloading",
				pct: 0,
				speed: 0,
			}, ...prev]);

			manualInput.setValue("");
			tray.update();

			try {
				pushStatus("Adding to Webtor.io...");
				const resourceId = await addResource(magnet);

				pushStatus("Fetching file list...");
				const files = await listFiles(resourceId);
				if (files.length === 0) throw new Error("No files in torrent");

				const videoExts = [".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts", ".m2ts"];
				const videoFiles = files.filter((f) => videoExts.some((ext) => f.name.toLowerCase().endsWith(ext)));
				if (videoFiles.length === 0) throw new Error("No video files found");

				const target = videoFiles.reduce((a, b) => a.size > b.size ? a : b);

				pushStatus("Getting download URL...");
				const downloadUrl = await getDownloadUrl(resourceId, target.id);

				pushStatus("Downloading...");
				const destPath = await streamDownload(downloadUrl, target.name, downloadId);

				updateDownload(downloadId, { status: "completed", pct: 100, speed: 0, dest: destPath });
				pushStatus("Download complete");

				// Try to infer mediaId/episode from filename
				const parsed = $habari.parse(target.name);
				await registerLocalFile(destPath, target.name, parsed.anilist_id || 0, parsed.episode_number || 1);
				ctx.toast.success(`Downloaded: ${target.name}`);
			} catch (err) {
				const msg = (err as Error).message;
				updateDownload(downloadId, { status: "error", error: msg });
				pushStatus(`Error: ${msg}`);
				ctx.toast.error(`Download failed: ${msg}`);
			} finally {
				tray.update();
			}
		}

		// ------------------------------------------------------------------
		// UI Rendering
		// ------------------------------------------------------------------
		const tray = ctx.newTray({
			iconUrl: TRAY_ICON,
			withContent: true,
			width: "28rem",
			minHeight: "22rem",
		});

		function torrentItem(t: typeof recentTorrents.get()[0]): any[] {
			const epLabel = t.episodeNumber > 0 ? `E${t.episodeNumber}` : (t.isBatch ? "Batch" : "");
			const resLabel = t.resolution ? ` · ${t.resolution}` : "";
			const sizeLabel = t.formattedSize ? ` · ${t.formattedSize}` : "";
			const seedLabel = `S:${t.seeders} L:${t.leechers}`;

			return [
				tray.flex([
					tray.flex([
						tray.text(t.name, { className: "text-xs font-medium truncate flex-1" }),
						tray.text(`${epLabel}${resLabel}${sizeLabel} · ${seedLabel}`, { className: "text-[10px] opacity-50 truncate" }),
					], { direction: "column", gap: 1, style: { flex: 1 } }),
					tray.button("Download", {
						size: "sm",
						intent: "primary",
						loading: downloads.get().some(d => d.label.includes(t.name) && d.status === "downloading"),
						onClick: ctx.eventHandler(`webtor:dl:${t.infoHash || t.name}`, () => startDownload(t)),
					}),
				], { gap: 8, alignItems: "center" }),
				tray.text(`Provider: ${t.provider} · ${t.mediaTitle}`, { className: "text-[10px] opacity-40 -mt-2" }),
			];
		}

		function downloadItem(d: typeof downloads.get()[0]): any[] {
			const pct = d.pct > 0 ? `${Math.round(d.pct)}%` : "—";
			const statusLabel = d.status === "completed" ? "Done" : d.status === "error" ? (d.error || "Failed") : `${pct} · ${formatSpeed(d.speed)}`;
			const badgeIntent = d.status === "completed" ? "success" : d.status === "error" ? "alert" : "info";

			return [
				tray.stack([
					tray.flex([
						tray.text(d.label, { className: "text-xs font-medium truncate" }),
						tray.badge(d.status === "completed" ? "Done" : d.status === "error" ? "Error" : "DL", {
							intent: badgeIntent,
							size: "sm",
						}),
					], { gap: 6 }),
					tray.text(statusLabel, { className: "text-[10px] opacity-60" }),
					d.dest ? tray.text(d.dest, { className: "text-[9px] opacity-40 truncate" }) : null,
				], { gap: 2 }),
			].filter(Boolean);
		}

		tray.render(() => {
			const items: any[] = [
				tray.flex([
					tray.text("Webtor.io Downloader", { className: "font-semibold text-lg" }),
					tray.switch(enabled.get() ? "ON" : "OFF", {
						value: enabled.get(),
						onChange: ctx.eventHandler("webtor:toggle", (e) => {
							const val = Boolean(e?.value ?? e);
							enabled.set(val);
							if (val) {
								pushStatus("Enabled — torrent searches will be captured");
							} else {
								pushStatus("Disabled");
							}
							tray.update();
						}),
					}),
				], { gap: 8, justifyContent: "space-between", alignItems: "center" }),

				tray.text("Toggle ON to capture torrent searches and download via Webtor.io", { className: "text-xs opacity-60" }),
				tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),

				// Manual input
				tray.flex([
					tray.input("Magnet link or Info Hash", {
						placeholder: "magnet:?xt=urn:btih:... or 40-char hash",
						fieldRef: manualInput,
						size: "md",
					}),
					tray.button("Download", {
						size: "sm",
						intent: "primary",
						onClick: ctx.eventHandler("webtor:manual", () => startManualDownload()),
					}),
				], { gap: 4 }),

				tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),

				// Recent torrents
				tray.flex([
					tray.text("Recent Searches", { className: "font-medium text-sm" }),
					recentTorrents.get().length > 0 ? tray.button("Clear", {
						size: "xs",
						intent: "gray-subtle",
						onClick: ctx.eventHandler("webtor:clear", () => {
							recentTorrents.set([]);
							tray.update();
						}),
					}) : null,
				], { gap: 4, justifyContent: "space-between" }),

				...(() => {
					const torrents = recentTorrents.get();
					if (torrents.length === 0) {
						return [tray.text("No searches captured yet. Enable toggle and search for torrents in Seanime.", { className: "text-xs opacity-50" })];
					}
					const out: any[] = [];
					for (const t of torrents.slice(0, 15)) {
						out.push(...torrentItem(t));
					}
					return out;
				})(),

				tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),

				// Active downloads
				(() => {
					const active = downloads.get().filter(d => d.status === "downloading");
					if (active.length === 0) return [];
					return [
						tray.text("Active Downloads", { className: "font-medium text-sm" }),
						...active.flatMap(downloadItem),
					];
				})(),

				// Completed/error downloads (last 5)
				(() => {
					const done = downloads.get().filter(d => d.status !== "downloading").slice(0, 5);
					if (done.length === 0) return [];
					return [
						tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
						tray.text("Recent", { className: "font-medium text-sm opacity-70" }),
						...done.flatMap(downloadItem),
					];
				})(),

				// Status
				status.get() ? [
					tray.text("", { className: "border-t border-zinc-800 my-1 w-full" }),
					tray.text(status.get(), { className: "text-[10px] opacity-70" }),
				] : [],
			];

			return tray.stack(items, { gap: 6 });
		});

		tray.open();
	});
}