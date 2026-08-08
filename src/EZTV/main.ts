/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

class Provider {
    private api = "https://eztvx.to"

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
        return -1
    }

    private sizeToBytes(sizeStr: string): number {
        if (!sizeStr) return 0
        const m = sizeStr.match(/([\d.,]+)\s*(B|KB|MB|GB|TB)/i)
        if (!m) return 0
        const val = parseFloat(m[1].replace(/,/g, ""))
        const unit = m[2].toUpperCase()
        const mult: Record<string, number> = {
            B: 1,
            KB: 1024,
            MB: 1024 ** 2,
            GB: 1024 ** 3,
            TB: 1024 ** 4,
        }
        return Math.round(val * (mult[unit] ?? 1))
    }

    // ------------------------------------------------------------------ parsing

    // Parses an EZTV date into RFC3339. Result rows show relative text like
    // "3 hours ago" or absolute forms such as "Aug-07-2026".
    private parseDate(value: string): string {
        if (!value) return new Date().toISOString()
        const t = value.trim()

        const abs = t.match(/^([a-z]{3})[.\s-]+\s*(\d{1,2})[,.\s-]+\s*(\d{4})$/i)
        if (abs) {
            const months: Record<string, number> = {
                jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
            }
            const mon = months[abs[1].toLowerCase()]
            if (mon !== undefined) {
                const d = new Date(Date.UTC(Number(abs[3]), mon, Number(abs[2])))
                if (!isNaN(d.getTime())) return d.toISOString()
            }
        }

        if (/^today$/i.test(t)) return new Date(Date.now()).toISOString()
        if (/^yesterday$/i.test(t)) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

        const rel = t.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i)
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
            const ms = mult[rel[2].toLowerCase()]
            if (ms) return new Date(Date.now() - Number(rel[1]) * ms).toISOString()
        }

        return new Date().toISOString()
    }

    private parseBlock(html: string): AnimeTorrent | null {
        const magnetM = html.match(/href="(magnet:\?[^"]+)"/i)
        const titleM = html.match(/<a href="(\/ep\/[^"]+)">\s*([\s\S]*?)\s*<\/a>/i)
        if (!magnetM || !titleM || !magnetM[1]) return null

        const magnet = magnetM[1]

        const title = titleM[2].replace(/<[^>]+>/g, "").trim()
        const seedM = html.match(/Seeders<\/span><br>\s*<span[^>]*>([\d,.]+)<\/span>/i)
        const leechM = html.match(/Leechers<\/span><br>\s*<span[^>]*>([\d,.]+)<\/span>/i)
        const sizeM = html.match(/Size<\/span><br>\s*<span[^>]*>([^<]+)<\/span>/i)
        const dateM = html.match(/Date<\/span><br>\s*<span[^>]*>([^<]+)<\/span>/i)

        const infoHash = (magnet.match(/btih:([a-fA-F0-9]{40})/i) || [])[1] || null

        return {
            name: title,
            date: this.parseDate(dateM ? dateM[1] : ""),
            size: this.sizeToBytes(sizeM ? sizeM[1] : ""),
            formattedSize: sizeM ? sizeM[1].trim() : "",
            seeders: seedM ? parseInt(seedM[1].replace(/,/g, ""), 10) : 0,
            leechers: leechM ? parseInt(leechM[1].replace(/,/g, ""), 10) : 0,
            downloadCount: 0,
            link: `${this.api}${titleM[1]}`,
            downloadUrl: "",
            magnetLink: magnet,
            infoHash: infoHash,
            resolution: this.extractResolution(title),
            isBatch: /(^|\b)(batch|complete|season pack)(\b|$)/i.test(title) || /(^|\b)S\d{1,2}(-|$)/i.test(title) && !/E\d/i.test(title),
            episodeNumber: this.episodeOf(title),
            releaseGroup: "",
            isBestRelease: false,
            confirmed: true,
        }
    }

    private async scrape(query: string): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(`${this.api}/search/${encodeURIComponent(query)}`, {
                headers: { Referer: `${this.api}/` },
            })
            if (!res.ok) return []
            const html = res.text()
            const $ = LoadDoc(html)
            const ret: AnimeTorrent[] = []
            $(".result_item").each((_, el) => {
                // Only blocks that carry a magnet button are torrent results.
                if (el.find("div.result_magnet_button").length() === 0) return
                const html = el.html()
                if (!html) return
                const t = this.parseBlock(html)
                if (t && t.seeders > 0) ret.push(t)
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
        return this.scrape(q)
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const split = this.splitSeason(this.baseTitle(opts))
        let q = split.base

        if (this.isMovie(opts.media)) {
            // EZTV is series-focused; for movies, add the year.
            if (opts.media.seasonYear) q += ` ${opts.media.seasonYear}`
        } else if (opts.batch) {
            q += " complete"
        } else if (opts.episodeNumber > 0) {
            const s = split.season > 0 ? split.season : 1
            q += ` S${String(s).padStart(2, "0")}E${String(opts.episodeNumber).padStart(2, "0")}`
        }

        if (opts.resolution) q += ` ${opts.resolution}`
        if (q.trim() === "") return []

        return this.scrape(q)
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(`${this.api}/`, { headers: { Referer: `${this.api}/` } })
            if (!res.ok) return []
            const $ = LoadDoc(res.text())
            const ret: AnimeTorrent[] = []
            $(".result_item").each((_, el) => {
                if (el.find("div.result_magnet_button").length() === 0) return
                const html = el.html()
                if (!html) return
                const t = this.parseBlock(html)
                if (t) ret.push(t)
            })
            return ret
        } catch (err) {
            return []
        }
    }
}
