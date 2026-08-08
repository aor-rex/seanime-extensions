/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

class Provider {
    private api = "https://extto.com"

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

    // Map a media format to an EXT category id.
    private categoryFor(media: Media): string {
        if (this.isMovie(media)) return "1" // Movies
        if (media.format === "ANIME" || media.format === "ONA" || media.format === "OVA" || media.format === "SPECIAL") return "7" // Anime
        return "2" // TV
    }

    // Parses a single search table row into an AnimeTorrent.
    private toAnimeTorrent(el: DocSelection): AnimeTorrent | null {
        const titleEl = el.find("a.torrent-title-link").first()
        const href = titleEl.attr("href") || ""
        const title = titleEl.text().trim()
        if (!title || !href) return null

        const cells = this.readCells(el)

        return {
            name: title,
            date: new Date().toISOString(),
            size: cells.size,
            formattedSize: "",
            seeders: cells.seeders,
            leechers: cells.leechers,
            downloadCount: 0,
            link: `${this.api}${href}`,
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

    // Extracts the numeric torrent id from a detail page href like "/slug-8078925/".
    private idFromHref(href: string): string {
        const m = href.match(/-(\d+)\/?$/)
        return m ? m[1] : ""
    }

    // Reads the Size / Seeds / Leeches values from the row's add-block cells.
    private readCells(el: DocSelection): { size: number; seeders: number; leechers: number } {
        let size = 0
        let seeders = 0
        let leechers = 0
        el.find("div.add-block-wrapper").each((_, cell) => {
            const label = cell.find("span.add-block").text().trim().toLowerCase()
            const value = cell.find("span").eq(1).text().trim()
            if (label === "size") size = this.sizeToBytes(value)
            else if (label === "seeds") seeders = parseInt(value, 10) || 0
            else if (label === "leechs") leechers = parseInt(value, 10) || 0
        })
        return { size, seeders, leechers }
    }

    private async scrape(query: string, category: string): Promise<AnimeTorrent[]> {
        const url = `${this.api}/browse/?q=${encodeURIComponent(query)}&cat=${category}&page_size=100`
        try {
            const res = await fetch(url, {
                headers: { Referer: `${this.api}/` },
            })
            if (!res.ok) return []
            const $ = LoadDoc(res.text())
            const ret: AnimeTorrent[] = []
            $("table.search-table tbody tr").each((_, el) => {
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
        return this.scrape(q, this.categoryFor(opts.media))
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const split = this.splitSeason(this.baseTitle(opts))
        let q = split.base

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

        return this.scrape(q, this.categoryFor(opts.media))
    }

    // EXT's magnet links are signed per-request. We scrape the torrent detail
    // page for the page/csrf tokens and the session cookie, then POST the
    // signed form to the magnet endpoint.
    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        try {
            const id = this.idFromHref(torrent.link)
            if (!id) return ""

            const res = await fetch(torrent.link, {
                headers: { Referer: `${this.api}/` },
            })
            if (!res.ok) return ""
            const html = res.text()

            const pageToken = (html.match(/window\.pageToken\s*=\s*'([^']+)'/) || [])[1] || ""
            const csrfToken = (html.match(/window\.csrfToken\s*=\s*'([^']+)'/) || [])[1] || ""
            if (!pageToken || !csrfToken) return ""

            const timestamp = Math.floor(Date.now() / 1000)
            const hmac = CryptoJS.enc.Hex.stringify(CryptoJS.SHA256(`${id}|${timestamp}|${pageToken}`))
            const body = `torrent_id=${encodeURIComponent(id)}&download_type=magnet&timestamp=${timestamp}&hmac=${hmac}&sessid=${encodeURIComponent(csrfToken)}`

            const post = await fetch(`${this.api}/ajax/getTorrentMagnet.php`, {
                method: "POST",
                headers: {
                    Referer: torrent.link,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest",
                    Cookie: `PHPSESSID=${res.cookies.PHPSESSID || ""}`,
                },
                body: body,
            })
            if (!post.ok) return ""
            const data = post.json<{ success: boolean; url?: string; hash?: string }>()
            if (!data || !data.success) return ""
            if (data.url) return data.url
            if (data.hash) return `magnet:?xt=urn:btih:${data.hash}`
            return ""
        } catch (err) {
            return ""
        }
    }

    // EXT doesn't expose info hashes without a magnet request.
    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    // Parses a homepage "latest" row, which carries a direct magnet link.
    private toLatestAnimeTorrent(el: DocSelection): AnimeTorrent | null {
        const titleEl = el.find("td.text-left a[href^='/']").first()
        const href = titleEl.attr("href") || ""
        const title = titleEl.text().trim()
        if (!title || !href) return null

        const magnetEl = el.find("a.torrent-dwn[data-id]").first()
        const magnet = magnetEl.attr("href") || ""
        const infoHash = magnet.startsWith("magnet:")
            ? ((magnet.match(/btih:([a-fA-F0-9]{40})/) || [])[1] || "")
            : ""

        const cells = this.readCells(el)

        return {
            name: title,
            date: new Date().toISOString(),
            size: cells.size,
            formattedSize: "",
            seeders: cells.seeders,
            leechers: cells.leechers,
            downloadCount: 0,
            link: `${this.api}${href}`,
            downloadUrl: "",
            magnetLink: magnet || null,
            infoHash: infoHash || null,
            resolution: this.extractResolution(title),
            isBatch: this.isBatchName(title),
            episodeNumber: this.episodeOf(title),
            releaseGroup: "",
            isBestRelease: false,
            confirmed: true,
        }
    }

    // Latest torrents from the homepage's day-1 tab.
    async getLatest(): Promise<AnimeTorrent[]> {
        try {
            const res = await fetch(`${this.api}/`, {
                headers: { Referer: `${this.api}/` },
            })
            if (!res.ok) return []
            const $ = LoadDoc(res.text())
            const ret: AnimeTorrent[] = []
            $("div#torrents-day-1 table tbody tr").each((_, el) => {
                const t = this.toLatestAnimeTorrent(el)
                if (t) ret.push(t)
            })
            return ret
        } catch (err) {
            return []
        }
    }
}
