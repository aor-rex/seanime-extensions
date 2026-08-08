/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

type TpbTorrent = {
    id: string
    name: string
    info_hash: string
    leechers: string
    seeders: string
    num_files: string
    size: string
    username: string
    added: string
    status: string
    category: string
    imdb: string
}

class Provider {
    private api = "https://apibay.org"

    private SERIES_CATS = [205, 208, 212]
    private MOVIE_CATS = [201, 202, 204, 207, 211]

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
            type: "main",
        }
    }

    // ------------------------------------------------------------------ utils

    private buildMagnet(infoHash: string, name: string): string {
        const trackers = [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://tracker.dler.org:6969/announce",
            "udp://public.popcorn-tracker.org:6969/announce",
            "udp://open.demonii.com:1337/announce",
            "udp://glotorrents.pw:6969/announce",
            "udp://exodus.desync.com:6969",
            "udp://tracker.internetwarriors.net:1337",
            "udp://p4p.arenabg.com:1337",
            "udp://torrent.gresille.org:80/announce",
            "udp://tracker.bittor.pw:1337",
        ]
        const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("")
        return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${tr}`
    }

    private extractResolution(name: string): string {
        const m = name.match(/(\b\d{3,4}p\b|\b[48]K\b)/i)
        return m ? m[1] : ""
    }

    private isMovie(media: Media): boolean {
        return media.format === "MOVIE" || media.episodeCount === 1
    }

    private baseTitle(opts: { query: string; media: Media }): string {
        return opts.query || opts.media.englishTitle || opts.media.romajiTitle || ""
    }

    // Splits a per-season media title like "Breaking Bad — Season 2" into its
    // base title and season number. Returns season 0 when no marker is present.
    private splitSeason(title: string): { base: string; season: number } {
        const m = title.match(/\s*[—–-]\s*season\s+(\d{1,2})\s*$/i)
        if (m) {
            return {
                base: title.slice(0, m.index).trim(),
                season: Number(m[1]),
            }
        }
        return { base: title.trim(), season: 0 }
    }

    // apibay tokenizes queries and treats a standalone hyphen (surrounded by
    // whitespace) as a negation operator: "Show - The Movie" excludes "The
    // Movie" from results. AniList titles routinely contain " - " (e.g. "BLEACH:
    // Thousand-Year Blood War - The Calamity"), so normalize it away. Hyphens
    // inside words ("Thousand-Year") are left untouched.
    private sanitize(q: string): string {
        return q.replace(/\s+-\s+/g, " ").replace(/\s+/g, " ").trim()
    }

    private catsFor(media: Media): string {
        return this.isMovie(media) ? this.MOVIE_CATS.join(",") : this.SERIES_CATS.join(",")
    }

    private isVideoCategory(cat: string): boolean {
        return [...this.SERIES_CATS, ...this.MOVIE_CATS].includes(Number(cat))
    }

    private isBatchName(name: string): boolean {
        if (/(^|\b)(batch|complete)(\b|$)/i.test(name)) return true
        if (/\bS\d{1,2}(?![\dE])/i.test(name)) return true
        // Episode-range batches like "1-64" or "001-008"
        return /\b\d{1,3}\s*-\s*\d{1,3}\b/.test(name)
    }

    private toAnimeTorrent(t: TpbTorrent, confirmed = true): AnimeTorrent {
        const infoHash = t.info_hash || null
        return {
            name: t.name,
            date: new Date(Number(t.added) * 1000).toISOString(),
            size: Number(t.size),
            formattedSize: "",
            seeders: Number(t.seeders),
            leechers: Number(t.leechers),
            downloadCount: 0,
            link: `${this.api}/torrent/${t.id}`,
            downloadUrl: "",
            magnetLink: infoHash ? this.buildMagnet(infoHash, t.name) : null,
            infoHash: infoHash,
            resolution: this.extractResolution(t.name),
            isBatch: this.isBatchName(t.name),
            episodeNumber: this.episodeOf(t.name),
            releaseGroup: "",
            isBestRelease: false,
            confirmed: confirmed,
        }
    }

    // Parses the episode number from a torrent name ("S05E08" -> 8). Returns -1 if none.
    private episodeOf(name: string): number {
        const m = name.match(/\bS\d{1,2}E(\d{1,3})\b/i)
        if (m) return Number(m[1])
        const ep = name.match(/\b(?:Episode|EP)\s*#?\s*(\d{1,3})\b/i)
        if (ep) return Number(ep[1])
        const single = name.match(/(?:^|[.\s-])E(\d{1,3})(?:[.\s-]|$)/i)
        return single ? Number(single[1]) : -1
    }

    // Parses the season from a torrent name ("S05E08" -> 5). Returns 0 if none.
    private seasonOf(name: string): number {
        const m = name.match(/\bS(\d{1,2})E\d{1,3}\b/i)
        return m ? Number(m[1]) : 0
    }

    // True when the torrent name matches the requested (relative) episode number
    // for the given season. A torrent with an explicit season marker must match
    // that season; torrents without one (absolute numbering, etc.) only need to
    // match the episode number.
    private matchesEpisode(name: string, episodeNumber: number, season: number): boolean {
        if (this.episodeOf(name) !== episodeNumber) return false
        if (season <= 0) return true
        const s = this.seasonOf(name)
        return s === 0 || s === season
    }

    private async searchQuery(q: string, cat?: string): Promise<TpbTorrent[]> {
        try {
            let url = `${this.api}/q.php?q=${encodeURIComponent(q)}`
            if (cat) url += `&cat=${cat}`
            const res = await fetch(url)
            if (!res.ok) return []
            const json = await res.json<TpbTorrent[]>()
            if (!Array.isArray(json)) return []
            return json.filter((t) => Number(t.seeders) > 0)
        } catch (err) {
            return []
        }
    }

    // ------------------------------------------------------------------ API

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const split = this.splitSeason(opts.query || opts.media.englishTitle || opts.media.romajiTitle || "")
        const q = this.sanitize(split.base)
        if (q.trim() === "") return []
        let torrents = await this.searchQuery(q, this.catsFor(opts.media))
        if (torrents.length === 0) torrents = await this.searchQuery(q)
        return torrents.map((t) => this.toAnimeTorrent(t))
    }

    // apibay tokenizes queries and requires every token to appear in the torrent
    // name. Resolution values come in as "1080"/"720" (no "p"), which can't match
    // the "1080p" token in torrent names, so append the "p".
    private resolutionToken(res: string): string {
        if (/^\d{3,4}$/.test(res)) return `${res}p`
        return res
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const split = this.splitSeason(this.sanitize(this.baseTitle(opts)))
        const base = split.base
        const season = split.season
        let q = base

        if (this.isMovie(opts.media)) {
            if (opts.media.seasonYear) q += ` ${opts.media.seasonYear}`
        } else if (opts.batch) {
            q += " complete"
        } else if (opts.episodeNumber > 0) {
            const s = season > 0 ? season : 1
            q += ` S${String(s).padStart(2, "0")}E${String(opts.episodeNumber).padStart(2, "0")}`
        }

        const resToken = opts.resolution ? this.resolutionToken(opts.resolution) : ""
        if (resToken) q += ` ${resToken}`
        q = this.sanitize(q)
        if (q === "") return []

        let torrents = await this.searchQuery(q, this.catsFor(opts.media))
        if (torrents.length === 0) torrents = await this.searchQuery(q)

        // Batch search: apibay rarely has a "complete" or "season" token, so the
        // precise query often comes back empty. Fall back to a title-only query
        // and keep anything that looks like a batch.
        if (opts.batch) {
            if (torrents.length === 0) {
                let fb = base
                if (resToken) fb += ` ${resToken}`
                let fbTorrents = await this.searchQuery(fb, this.catsFor(opts.media))
                if (fbTorrents.length === 0) fbTorrents = await this.searchQuery(fb)
                torrents = fbTorrents.filter((t) => this.isBatchName(t.name))
            }
            return torrents.map((t) => this.toAnimeTorrent(t, true))
        }

        // Single-episode search: apibay requires all query tokens to match, so a
        // "SxxEyy" suffix rarely matches real torrent names (season offsets,
        // absolute episode numbers, etc.). Fall back to a title-only query and
        // keep batches + torrents that parse to the requested season/episode.
        if (opts.episodeNumber > 0 && torrents.length === 0) {
            let fb = base
            if (resToken) fb += ` ${resToken}`
            let fbTorrents = await this.searchQuery(fb, this.catsFor(opts.media))
            if (fbTorrents.length === 0) fbTorrents = await this.searchQuery(fb)
            torrents = fbTorrents.filter(
                (t) => this.isBatchName(t.name) || this.matchesEpisode(t.name, opts.episodeNumber, season),
            )
            return torrents.map((t) => this.toAnimeTorrent(t, false))
        }

        return torrents.map((t) => this.toAnimeTorrent(t, true))
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(`${this.api}/precompiled/data_top100_recent.json`)
            if (!res.ok) return []
            const json = await res.json<TpbTorrent[]>()
            if (!Array.isArray(json)) return []
            return json
                .filter((t) => Number(t.seeders) > 0 && this.isVideoCategory(t.category))
                .map((t) => this.toAnimeTorrent(t))
        } catch (err) {
            return []
        }
    }
}
