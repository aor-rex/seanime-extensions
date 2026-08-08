/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

class Provider {
    private api = "https://1337x.to"

    getSettings(): AnimeProviderSettings {
        return {
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
            type: "main",
        }
    }

    // ------------------------------------------------------------------ utils

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

    private extractResolution(name: string): string {
        const m = name.match(/(\b\d{3,4}p\b|\b[48]K\b)/i)
        return m ? m[1] : ""
    }

    private episodeOf(name: string): number {
        const m = name.match(/\bS\d{1,2}E(\d{1,3})\b/i)
        if (m) return Number(m[1])
        const single = name.match(/(?:^|[.\s-])E(\d{1,3})(?:[.\s-]|$)/i)
        return single ? Number(single[1]) : -1
    }

    private isBatchName(name: string): boolean {
        if (/(^|\b)(batch|complete|season pack)(\b|$)/i.test(name)) return true
        if (/(^|\b)S\d{1,2}(-|$)/i.test(name) && !/E\d/i.test(name)) return true
        return false
    }

    private sizeToBytes(sizeStr: string): number {
        if (!sizeStr) return 0
        const m = sizeStr.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i)
        if (!m) return 0
        const val = parseFloat(m[1])
        const unit = m[2].toUpperCase()
        const mult: Record<string, number> = {
            B: 1,
            KB: 1024,
            MB: 1024 ** 2,
            GB: 1024 ** 3,
            TB: 1024 ** 4,
            KIB: 1024,
            MIB: 1024 ** 2,
            GIB: 1024 ** 3,
            TIB: 1024 ** 4,
        }
        return Math.round(val * (mult[unit] ?? 1))
    }

    // Parses a 1337x date cell into RFC3339. Cells show relative text like
    // "today", "yesterday", "3 hours ago" or an absolute "Aug-07-2026".
    private parseDate(value: string): string {
        if (!value) return new Date().toISOString()
        const t = value.trim().toLowerCase()

        if (/^today$/.test(t)) return new Date(Date.now()).toISOString()
        if (/^yesterday$/.test(t)) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

        const abs = t.match(/^([a-z]{3})-(\d{2})-(\d{4})$/)
        if (abs) {
            const months: Record<string, number> = {
                jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
            }
            const mon = months[abs[1]]
            if (mon !== undefined) {
                const d = new Date(Date.UTC(Number(abs[3]), mon, Number(abs[2])))
                if (!isNaN(d.getTime())) return d.toISOString()
            }
        }

        const rel = t.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/)
        if (rel) {
            const mult: Record<string, number> = {
                second: 1000,
                minute: 60 * 1000,
                hour: 60 * 60 * 1000,
                day: 24 * 60 * 60 * 1000,
                week: 7 * 24 * 60 * 60 * 1000,
                month: 30 * 24 * 60 * 60 * 1000,
                year: 365 * 24 * 60 * 60 * 1000,
            }
            const ms = mult[rel[2]]
            if (ms) return new Date(Date.now() - Number(rel[1]) * ms).toISOString()
        }

        return new Date().toISOString()
    }

    private toAnimeTorrent(el: DocSelection): AnimeTorrent | null {
        const links = el.find("td.coll-1.name a")
        if (links.length() < 2) return null

        const title = links.eq(1).text().trim()
        const href = links.eq(1).attr("href") || ""
        if (!title || !href) return null

        const seeders = parseInt(el.find("td.coll-2").text().trim(), 10) || 0
        const leechers = parseInt(el.find("td.coll-3").text().trim(), 10) || 0
        const size = this.sizeToBytes(el.find("td.coll-4").text().trim())
        const pageUrl = `${this.api}${href}`

        return {
            name: title,
            date: this.parseDate(el.find("td.coll-5").text().trim()),
            size: size,
            formattedSize: "",
            seeders: seeders,
            leechers: leechers,
            downloadCount: 0,
            link: pageUrl,
            downloadUrl: "",
            magnetLink: null,
            infoHash: null,
            resolution: this.extractResolution(title),
            isBatch: this.isBatchName(title),
            episodeNumber: this.episodeOf(title),
            releaseGroup: "",
            isBestRelease: false,
            confirmed: true,
        }
    }

    private async scrape(query: string, category: string): Promise<AnimeTorrent[]> {
        const path = category === "all"
            ? `/search/${encodeURIComponent(query)}/1/`
            : `/category-search/${encodeURIComponent(query)}/${category}/1/`
        try {
            const res = await fetch(`${this.api}${path}`, {
                headers: { Referer: `${this.api}/` },
            })
            if (!res.ok) return []
            const html = res.text()
            const $ = LoadDoc(html)
            const ret: AnimeTorrent[] = []
            $("table tbody tr").each((_, el) => {
                const t = this.toAnimeTorrent(el)
                if (t) ret.push(t)
            })
            return ret
        } catch (err) {
            return []
        }
    }

    // ------------------------------------------------------------------ API

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        const q = this.splitSeason(opts.query || opts.media.englishTitle || opts.media.romajiTitle || "").base
        if (q.trim() === "") return []
        return this.scrape(q, "all")
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const split = this.splitSeason(this.baseTitle(opts))
        let q = split.base
        const category = this.isMovie(opts.media) ? "movies" : "tv"

        if (this.isMovie(opts.media)) {
            if (opts.media.seasonYear) q += ` ${opts.media.seasonYear}`
        } else if (opts.batch) {
            q += " complete"
        } else if (opts.episodeNumber > 0) {
            const s = split.season > 0 ? split.season : 1
            q += ` S${String(s).padStart(2, "0")}E${String(opts.episodeNumber).padStart(2, "0")}`
        }

        if (opts.resolution) q += ` ${opts.resolution}`
        if (q.trim() === "") return []

        return this.scrape(q, category)
    }

    // Scrapes the torrent page to get the magnet link.
    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        try {
            const res = await fetch(torrent.link, { headers: { Referer: `${this.api}/` } })
            if (!res.ok) return ""
            const $ = LoadDoc(res.text())
            const magnet = $("a[href^='magnet:']").first().attr("href")
            return magnet || ""
        } catch (err) {
            return ""
        }
    }

    // 1337x doesn't expose info hashes without scraping the torrent page.
    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    // Latest torrents from the recent page.
    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(`${this.api}/recent/`, { headers: { Referer: `${this.api}/` } })
            if (!res.ok) return []
            const $ = LoadDoc(res.text())
            const ret: AnimeTorrent[] = []
            $("table tbody tr").each((_, el) => {
                const t = this.toAnimeTorrent(el)
                if (t) ret.push(t)
            })
            return ret
        } catch (err) {
            return []
        }
    }
}
