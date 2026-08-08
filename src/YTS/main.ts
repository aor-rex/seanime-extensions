/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

type YtsTorrent = {
    quality: string
    type: string
    size: string
    size_bytes: number
    seeds: number
    peers: number
    hash: string
}

type YtsMovie = {
    id: number
    title: string
    year: number
    rating: number
    imdb_code: string
    url: string
    date_uploaded: string
    torrents: YtsTorrent[]
}

class Provider {
    private api = "https://yts.am/api/v2"

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["bestReleases", "query", "resolution"],
            supportsAdult: false,
            type: "main",
        }
    }

    // ------------------------------------------------------------------ utils

    private isMovie(media: Media): boolean {
        return media.format === "MOVIE" || media.episodeCount === 1
    }

    private buildMagnet(hash: string, name: string): string {
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
        ]
        const tr = trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join("")
        return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`
    }

    private toAnimeTorrent(movie: YtsMovie, t: YtsTorrent): AnimeTorrent {
        const name = `${movie.title} (${movie.year}) ${t.quality} [YTS.MX]`
        return {
            name: name,
            date: movie.date_uploaded || new Date().toISOString(),
            size: Number(t.size_bytes) || 0,
            formattedSize: t.size || "",
            seeders: Number(t.seeds) || 0,
            leechers: Number(t.peers) || 0,
            downloadCount: 0,
            link: movie.url || "",
            downloadUrl: "",
            magnetLink: t.hash ? this.buildMagnet(t.hash, name) : null,
            infoHash: t.hash || null,
            resolution: t.quality || "",
            isBatch: false,
            episodeNumber: -1,
            releaseGroup: "YTS.MX",
            isBestRelease: /^(1080p|2160p)$/.test(t.quality),
            confirmed: true,
        }
    }

    private async fetchMovies(q: string, quality?: string): Promise<YtsMovie[]> {
        try {
            let url = `${this.api}/list_movies.json?query_term=${encodeURIComponent(q)}&limit=50&sort_by=seeds&order_by=desc`
            if (quality) url += `&quality=${encodeURIComponent(quality)}`
            const res = await fetch(url)
            if (!res.ok) return []
            const json = res.json<{ data: { movies: YtsMovie[] } }>()
            if (!json || !json.data || !Array.isArray(json.data.movies)) return []
            return json.data.movies.filter((m) => m && Array.isArray(m.torrents))
        } catch (err) {
            return []
        }
    }

    // ------------------------------------------------------------------ API

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const q = opts.query || opts.media.englishTitle || opts.media.romajiTitle || ""
        if (q.trim() === "") return []
        const movies = await this.fetchMovies(q)
        const ret: AnimeTorrent[] = []
        for (const m of movies) {
            for (const t of m.torrents) ret.push(this.toAnimeTorrent(m, t))
        }
        return ret
    }

    // YTS only provides movies; return nothing for series.
    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        if (!this.isMovie(opts.media)) return []

        let q = opts.query || opts.media.englishTitle || opts.media.romajiTitle || ""
        if (opts.media.seasonYear) q += ` ${opts.media.seasonYear}`
        if (q.trim() === "") return []

        const quality = opts.resolution ? opts.resolution.replace(/\D/g, "") : undefined
        const movies = await this.fetchMovies(q, quality)

        let ret: AnimeTorrent[] = []
        for (const m of movies) {
            for (const t of m.torrents) ret.push(this.toAnimeTorrent(m, t))
        }

        // If bestReleases is enabled, keep the best (1080p/2160p) release of each title.
        if (opts.bestReleases) {
            const seen: Record<string, AnimeTorrent> = {}
            for (const t of ret) {
                const key = t.name.replace(/\s+\d{3,4}p.*$/, "")
                const prev = seen[key]
                if (!prev || this.rank(t) > this.rank(prev)) seen[key] = t
            }
            ret = Object.values(seen)
        }

        return ret
    }

    private rank(t: AnimeTorrent): number {
        const r = t.resolution === "2160p" ? 3 : t.resolution === "1080p" ? 2 : 1
        return r * 100 + t.seeders
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(`${this.api}/list_movies.json?limit=50&sort_by=date_added&order_by=desc`)
            if (!res.ok) return []
            const json = res.json<{ data: { movies: YtsMovie[] } }>()
            if (!json || !json.data || !Array.isArray(json.data.movies)) return []
            const ret: AnimeTorrent[] = []
            for (const m of json.data.movies) {
                for (const t of m.torrents) ret.push(this.toAnimeTorrent(m, t))
            }
            return ret
        } catch (err) {
            return []
        }
    }
}
