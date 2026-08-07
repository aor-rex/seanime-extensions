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

    private catsFor(media: Media): string {
        return this.isMovie(media) ? this.MOVIE_CATS.join(",") : this.SERIES_CATS.join(",")
    }

    private isVideoCategory(cat: string): boolean {
        return [...this.SERIES_CATS, ...this.MOVIE_CATS].includes(Number(cat))
    }

    private toAnimeTorrent(t: TpbTorrent): AnimeTorrent {
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
            isBatch: /(^|\b)(batch|complete)(\b|$)/i.test(t.name) || /\bS\d{1,2}(?![\dE])/i.test(t.name),
            episodeNumber: this.episodeOf(t.name),
            releaseGroup: "",
            isBestRelease: false,
            confirmed: true,
        }
    }

    // Parses the episode number from a torrent name ("S05E08" -> 8). Returns -1 if none.
    private episodeOf(name: string): number {
        const m = name.match(/\bS\d{1,2}E(\d{1,3})\b/i)
        if (m) return Number(m[1])
        const single = name.match(/(?:^|[.\s-])E(\d{1,3})(?:[.\s-]|$)/i)
        return single ? Number(single[1]) : -1
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

    private mergeDedup(a: TpbTorrent[], b: TpbTorrent[]): TpbTorrent[] {
        const seen = new Set<string>()
        return [...a, ...b].filter((t) => {
            if (seen.has(t.info_hash)) return false
            seen.add(t.info_hash)
            return true
        })
    }

    // ------------------------------------------------------------------ API

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const q = opts.query || opts.media.englishTitle || opts.media.romajiTitle || ""
        let torrents = await this.searchQuery(q, this.catsFor(opts.media))
        if (torrents.length === 0) torrents = await this.searchQuery(q)
        return torrents.map((t) => this.toAnimeTorrent(t))
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        let q = this.baseTitle(opts)

        if (this.isMovie(opts.media)) {
            if (opts.media.seasonYear) q += ` ${opts.media.seasonYear}`
        } else if (opts.batch) {
            q += " complete"
        } else if (opts.episodeNumber > 0) {
            q += ` S01E${String(opts.episodeNumber).padStart(2, "0")}`
        }

        if (opts.resolution) q += ` ${opts.resolution}`
        if (q.trim() === "") return []

        let torrents = await this.searchQuery(q, this.catsFor(opts.media))
        if (torrents.length === 0) torrents = await this.searchQuery(q)

        if (opts.batch) {
            const seasonQ = `${this.baseTitle(opts)} season${opts.resolution ? ` ${opts.resolution}` : ""}`
            let more = await this.searchQuery(seasonQ, this.catsFor(opts.media))
            if (more.length === 0) more = await this.searchQuery(seasonQ)
            torrents = this.mergeDedup(torrents, more)
        }

        return torrents.map((t) => this.toAnimeTorrent(t))
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
