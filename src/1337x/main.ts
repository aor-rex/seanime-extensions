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
                headers: this.buildHeaders(`${this.api}/`),
            })
            if (!res.ok) {
                if (res.status === 403) console.error("1337x: Cloudflare challenge blocked the request (403) — update the cf-cookie/user-agent settings with fresh values")
                return []
            }
            const html = res.text()
            if (this.isCfBlock(res.status, html)) {
                console.error("1337x: Cloudflare challenge page received — update the cf-cookie/user-agent settings with fresh values")
                return []
            }
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

    // Cloudflare bypass: accepts a bare cf_clearance value, a full Cookie
    // header from DevTools, or a JSON-style paste from the Request Cookies
    // viewer (e.g. cf_clearance:"<token>" or {"cf_clearance":"<token>"}).
    // The clearance is UA-bound, so the solving browser's exact User-Agent
    // must be sent verbatim too (see customUa()).
    private cleanCookieValue(v: string): string {
        let s = v.trim()
        // Strip surrounding quotes/braces left over from JSON-style pastes.
        s = s.replace(/^[{"]+/, "").replace(/[}"]+$/, "").trim()
        const q = s.match(/^"(.*)"$/)
        if (q) s = q[1].trim()
        return s
    }

    private cfCookies(): string {
        let raw = ""
        try {
            raw = ($getUserPreference("cf-cookie") || "").trim()
        } catch (err) {
            raw = ""
        }
        if (!raw) return ""
        // Strip a wrapping JSON object so pastes like
        // {"cf_clearance":"<token>","__dark-mode":"1"} parse as pairs.
        const unwrapped = raw.replace(/^\{+/, "").replace(/\}+$/, "").trim()
        if (unwrapped !== raw) raw = unwrapped
        // JSON-style paste from the Request Cookies viewer uses a colon
        // (cf_clearance:"<token>", "cf_clearance":"<token>"). Extract just
        // the token; a full Cookie header (with "=") is handled below so
        // companion cookies are preserved.
        const colonStyle = raw.match(/["']?cf_clearance["']?\s*:\s*"?([^";\s}]+)/i)
        if (colonStyle && colonStyle[1]) {
            const token = this.cleanCookieValue(colonStyle[1])
            if (token) return `cf_clearance=${token}`
        }
        if (raw.indexOf("=") === -1) {
            // Bare value (possibly quoted) -> treat as cf_clearance.
            const token = this.cleanCookieValue(raw.replace(/^cf_clearance\s*:\s*/i, ""))
            return token ? `cf_clearance=${token}` : ""
        }
        const pairs = raw.split(";")
        const kept: string[] = []
        for (const p of pairs) {
            const t = p.trim()
            if (!t) continue
            const eq = t.indexOf("=")
            if (eq === -1) continue
            const name = this.cleanCookieValue(t.slice(0, eq)).replace(/[^a-zA-Z0-9_-]/g, "")
            const value = this.cleanCookieValue(t.slice(eq + 1))
            if (!name || !value) continue
            kept.push(`${name}=${value}`)
        }
        return kept.join("; ")
    }

    private customUa(): string {
        try {
            return ($getUserPreference("user-agent") || "").trim()
        } catch (err) {
            return ""
        }
    }

    // Builds request headers, forwarding user-supplied CF cookies and
    // applying the user's User-Agent when set.
    private buildHeaders(referer: string): Record<string, string> {
        const h: Record<string, string> = { Referer: referer }
        const ua = this.customUa()
        if (ua) h["User-Agent"] = ua
        const cf = this.cfCookies()
        if (cf) h["Cookie"] = cf
        return h
    }

    private isCfBlock(status: number, body: string): boolean {
        if (status === 403) return true
        if (!body) return false
        return body.indexOf("Just a moment") !== -1 || body.indexOf("cf-turnstile") !== -1 || body.indexOf("challenges.cloudflare.com") !== -1
    }

    // Scrapes the torrent page to get the magnet link.
    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        try {
            const res = await fetch(torrent.link, { headers: this.buildHeaders(`${this.api}/`) })
            if (!res.ok) return ""
            const text = res.text()
            if (this.isCfBlock(res.status, text)) {
                console.error("1337x: Cloudflare challenge blocked the torrent page — update the cf-cookie/user-agent settings with fresh values")
                return ""
            }
            const $ = LoadDoc(text)
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
            const res = await fetch(`${this.api}/recent/`, { headers: this.buildHeaders(`${this.api}/`) })
            if (!res.ok) return []
            const text = res.text()
            if (this.isCfBlock(res.status, text)) return []
            const $ = LoadDoc(text)
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
