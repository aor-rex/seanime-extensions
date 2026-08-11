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
        // Full-season packs written out as "Season 2", but only when no episode
        // marker follows ("Season 2 Episode 5" is not a batch).
        if (/\bseason\s+\d{1,2}\b/i.test(name) && !this.hasEpisodeMarker(name)) return true
        return false
    }

    // True when the name carries a single-episode marker (SxxEyy, "EP n", "E n").
    private hasEpisodeMarker(name: string): boolean {
        if (/\bS\d{1,2}E\d{1,3}\b/i.test(name)) return true
        if (/\b(?:Episode|EP)\s*#?\s*\d{1,3}\b/i.test(name)) return true
        return /(?:^|[.\s-])E\d{1,3}(?:[.\s-]|$)/i.test(name)
    }

    // Tokens that describe the file (codec, quality, site tags) rather than the
    // media itself. Used so they don't count as "foreign" title tokens.
    private isTechToken(t: string): boolean {
        if (/^(s\d{1,2}e\d{1,3}|s\d{1,2}|e\d{1,3}|ep\d{1,3})$/i.test(t)) return true
        if (/^\d{3,4}p$/.test(t) || /^[248]k$/i.test(t)) return true
        if (/^(web|webrip|webdl|hdtv|hdrip|dvdrip|bluray|blu|bdrip|remux|x264|x265|h264|h265|hevc|avc|hdr|hdr10|dolby|vision|atmos|dts|truehd|aac|ac3|eac3|multi|dual|dualaudio|sub|subs|subbed|eng|en|fr|french|truefrench|esp|spa|ger|deu|ita|kor|jpn|jap|chi|pol|por|rus|tur|10bit)$/i.test(t)) return true
        if (/^(complete|collection|boxset|series|season|pack|batch|mini|miniseries|part|parts|vol|volume|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|final|full|remaster|restored|extended|uncut|director|directors|cut|theatrical|proper|repack|internal|criterion|anniversary|edition|atvp|appletv|amzn|amazon|nf|netflix|dsnp|disney|hbo|hulu|hmax|max|peacock|paramount|showtime)$/i.test(t)) return true
        return false
    }

    private isYearToken(t: string): boolean {
        return /^(19|20)\d{2}$/.test(t)
    }

    // Tokens that separate the title from the episode/season/batch metadata.
    private isBoundaryToken(t: string): boolean {
        if (/^(s\d{1,2}e\d{0,3}|s\d{1,2}|e\d{1,3}|ep\d{1,3})$/i.test(t)) return true
        if (/^(season|series|complete|collection|pack|batch|volume|vol|boxset)$/i.test(t)) return true
        return /^(19|20)\d{2}$/.test(t)
    }

    // Builds the set of tokens that may legitimately appear in a torrent title
    // for this media. Uses seanime's own normalizer so "the/an" noise and
    // " — Season 2" suffixes don't pollute the comparison.
    private buildAliasTokens(...titles: Array<string | undefined>): Set<string> {
        const set = new Set<string>()
        for (const title of titles) {
            if (!title) continue
            const base = this.splitSeason(title).base
            const norm = $scannerUtils.normalizeTitle(base)
            for (const t of norm?.tokens ?? []) set.add(t)
            // Release names often drop the apostrophe/possessive ("Man's" ->
            // "Mans"), so also add tokens from a de-punctuated form to keep
            // those results passing belongsTo.
            const dequoted = base.replace(/[''":]/g, "")
            if (dequoted !== base) {
                const altNorm = $scannerUtils.normalizeTitle(dequoted)
                for (const t of altNorm?.tokens ?? []) set.add(t)
            }
        }
        return set
    }

    // Returns significant tokens (seanime strips noise words and 1-char tokens).
    private significantTokens(tokens: string[]): string[] {
        return $scannerUtils.getSignificantTokens(tokens.join(" "))
    }

    // True when the torrent name actually belongs to the searched media.
    private belongsTo(name: string, aliases: Set<string>, isMovie: boolean, expectedSeason: number, mediaYear: number): boolean {
        const norm = $scannerUtils.normalizeTitle(name)
        const toks = norm?.tokens ?? []
        const nameYear = norm?.year ?? -1

        if (isMovie) {
            if (this.hasEpisodeMarker(name)) return false
            // Only evaluate the title stem (up to the first year/resolution/tech
            // token) so release groups and audio/container tags like "RBG",
            // "UHD" or "BDRemux" don't cause false drops.
            const boundaryIdx = toks.findIndex((t) => this.isYearToken(t) || this.isTechToken(t))
            const stem = boundaryIdx === -1 ? toks : toks.slice(0, boundaryIdx)
            const foreign = this.significantTokens(stem).filter(
                (t) => !aliases.has(t) && !this.isTechToken(t) && !this.isYearToken(t),
            )
            if (foreign.length > 0) return false
            if (nameYear > 0 && mediaYear > 0 && Math.abs(nameYear - mediaYear) > 1) return false
            return true
        }

        // Series results must structurally be series items
        if (!this.isBatchName(name) && !this.hasEpisodeMarker(name)) return false

        // Only evaluate the title stem (up to the first marker) so appended
        // episode titles like "From.S01E01.The.Longer.Day" don't cause false drops
        const boundaryIdx = toks.findIndex((t) => this.isBoundaryToken(t))
        const stem = boundaryIdx === -1 ? toks : toks.slice(0, boundaryIdx)
        const foreign = this.significantTokens(stem).filter((t) => !aliases.has(t) && !this.isTechToken(t))
        if (foreign.length > 0) return false

        if (expectedSeason > 0) {
            const s = this.seasonOf(name)
            if (s > 0 && s !== expectedSeason) return false
        }

        if (nameYear > 0 && mediaYear > 0 && Math.abs(nameYear - mediaYear) > 1) return false

        return true
    }

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

    private formatBytes(size: number): string {
        if (!size) return ""
        const i = Math.floor(Math.log(size) / Math.log(1024))
        const units = ["B", "KB", "MB", "GB", "TB"]
        return (size / Math.pow(1024, i)).toFixed(2) + " " + (units[i] || "B")
    }

    // Map a media format to an EXT category id.
    private categoryFor(media: Media): string {
        if (this.isMovie(media)) return "1" // Movies
        if (media.format === "ANIME" || media.format === "ONA" || media.format === "OVA" || media.format === "SPECIAL") return "7" // Anime
        return "2" // TV
    }

    // Parses a search row date into RFC3339. EXT renders dates either as an
    // absolute "07 August 2026" string (in the Age cell title) or as relative
    // text like "22 hours ago" on rows that lack the attribute.
    private parseDate(value: string): string {
        if (!value) return new Date().toISOString()
        const t = value.trim()

        const abs = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/)
        if (abs) {
            const months: Record<string, number> = {
                january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
                july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
            }
            const mon = months[abs[2].toLowerCase()]
            if (mon !== undefined) {
                const d = new Date(Date.UTC(Number(abs[3]), mon, Number(abs[1])))
                if (!isNaN(d.getTime())) return d.toISOString()
            }
        }

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
            const ms = mult[rel[2].toLowerCase()] ?? 0
            return new Date(Date.now() - Number(rel[1]) * ms).toISOString()
        }

        if (/^today$/i.test(t)) return new Date(Date.now()).toISOString()
        if (/^yesterday$/i.test(t)) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

        return new Date().toISOString()
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
            date: this.parseDate(cells.date),
            size: cells.size,
            formattedSize: cells.size ? this.formatBytes(cells.size) : "",
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

    // Pure-JS SHA-256 over UTF-8 bytes, returned as a lowercase hex string.
    // Seanime's goja runtime only exposes CryptoJS.AES/enc, so hashes like
    // CryptoJS.SHA256 are unavailable and must be computed here instead.
    private sha256Hex(input: string): string {
        const K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ]
        const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

        // Encode the input as UTF-8 bytes.
        const bytes: number[] = []
        for (let i = 0; i < input.length; i++) {
            let c = input.charCodeAt(i)
            if (c < 0x80) {
                bytes.push(c)
            } else if (c < 0x800) {
                bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
            } else if (c >= 0xd800 && c <= 0xdbff) {
                const c2 = input.charCodeAt(++i) || 0
                const v = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000
                bytes.push(0xf0 | (v >> 18), 0x80 | ((v >> 12) & 0x3f), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f))
            } else {
                bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
            }
        }

        const bitLen = bytes.length * 8
        bytes.push(0x80)
        while (bytes.length % 64 !== 56) bytes.push(0)
        const hi = Math.floor(bitLen / 0x100000000)
        const lo = bitLen >>> 0
        bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
        bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)

        let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
        let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
        const w: number[] = new Array(64)

        for (let i = 0; i < bytes.length; i += 64) {
            for (let j = 0; j < 16; j++) {
                const o = i + j * 4
                w[j] = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0
            }
            for (let j = 16; j < 64; j++) {
                const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3)
                const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10)
                w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0
            }

            let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
            for (let j = 0; j < 64; j++) {
                const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                const ch = (e & f) ^ (~e & g)
                const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0
                const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                const maj = (a & b) ^ (a & c) ^ (b & c)
                const t2 = (S0 + maj) >>> 0
                h = g; g = f; f = e; e = (d + t1) >>> 0
                d = c; c = b; b = a; a = (t1 + t2) >>> 0
            }

            h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
            h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
        }

        const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0")
        return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7)
    }

    // Reads the Size / Seeds / Leeches / Age values from the row's add-block cells.
    private readCells(el: DocSelection): { size: number; seeders: number; leechers: number; date: string } {
        let size = 0
        let seeders = 0
        let leechers = 0
        let date = ""
        el.find("div.add-block-wrapper").each((_, cell) => {
            const label = cell.find("span.add-block").text().trim().toLowerCase()
            const valueEl = cell.find("span").eq(1)
            const value = valueEl.text().trim()
            if (label === "size") size = this.sizeToBytes(value)
            else if (label === "seeds") seeders = parseInt(value, 10) || 0
            else if (label === "leechs") leechers = parseInt(value, 10) || 0
            else if (label === "age") date = valueEl.attr("title") || value
        })
        return { size, seeders, leechers, date }
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
        const split = this.splitSeason(opts.query || opts.media.englishTitle || opts.media.romajiTitle || "")
        const q = split.base
        if (q.trim() === "") return []
        const aliases = this.buildAliasTokens(opts.query, opts.media.englishTitle, opts.media.romajiTitle, ...(opts.media.synonyms ?? []))
        const isMovie = this.isMovie(opts.media)
        const mediaYear = opts.media.seasonYear || opts.media.startDate?.year || 0
        const season = split.season
        const torrents = await this.scrape(q, this.categoryFor(opts.media))
        return torrents
            .filter((t) => this.belongsTo(t.name, aliases, isMovie, season, mediaYear))
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const split = this.splitSeason(this.baseTitle(opts))
        const base = split.base
        const season = split.season
        const isMovie = this.isMovie(opts.media)
        const mediaYear = opts.media.seasonYear || opts.media.startDate?.year || 0
        const aliases = this.buildAliasTokens(opts.query, opts.media.englishTitle, opts.media.romajiTitle, ...(opts.media.synonyms ?? []))
        let q = base

        if (isMovie) {
            if (opts.media.seasonYear) q += ` ${opts.media.seasonYear}`
        } else if (opts.batch) {
            q += " complete"
        } else if (opts.episodeNumber > 0) {
            const s = season > 0 ? season : 1
            q += ` S${String(s).padStart(2, "0")}E${String(opts.episodeNumber).padStart(2, "0")}`
        }

        if (opts.resolution) q += ` ${opts.resolution}`
        if (q.trim() === "") return []

        const query = async (searchQuery: string) => this.scrape(searchQuery, this.categoryFor(opts.media))

        let torrents = await query(q)

        // Batch search: extto.com often doesn't index the literal word "complete"
        // in batch torrent titles, so the precise query can come back empty. Fall
        // back to a title-only query and keep anything that looks like a batch.
        if (!isMovie && opts.batch) {
            if (torrents.length === 0) {
                let fb = base
                if (opts.resolution) fb += ` ${opts.resolution}`
                torrents = (await query(fb)).filter((t) => t.isBatch)
            }
            return torrents
                .filter((t) => t.isBatch && this.belongsTo(t.name, aliases, false, season, mediaYear))
        }

        // Single-episode search: the query "SxxEyy" suffix rarely matches real
        // torrent names (season offsets, absolute episode numbers, etc.). Fall
        // back to a title-only query and keep batches + torrents that parse to
        // the requested season/episode. Movies always arrive with episodeNumber=1
        // from the frontend, so skip this branch entirely for them.
        if (!isMovie && opts.episodeNumber > 0) {
            if (torrents.length === 0) {
                let fb = base
                if (opts.resolution) fb += ` ${opts.resolution}`
                torrents = (await query(fb)).filter(
                    (t) => t.isBatch || this.matchesEpisode(t.name, opts.episodeNumber, season),
                )
            }
            return torrents
                .filter((t) =>
                    this.belongsTo(t.name, aliases, isMovie, season, mediaYear)
                    && (t.isBatch || this.matchesEpisode(t.name, opts.episodeNumber, season)),
                )
        }

        return torrents
            .filter((t) => this.belongsTo(t.name, aliases, isMovie, season, mediaYear))
    }

    // EXT's magnet links are signed per-request. We scrape the torrent detail
    // page for the page/csrf tokens and the session cookie, then POST the
    // signed form to the magnet endpoint.
    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        if (torrent.magnetLink) return torrent.magnetLink
        try {
            const id = this.idFromHref(torrent.link)
            if (!id) return ""

            // The magnet endpoint only accepts sessions established from the
            // homepage. Fetch it first to get a valid PHPSESSID cookie, then
            // reuse it for the detail page and the magnet request.
            const sessRes = await fetch(`${this.api}/`, {
                headers: { Referer: `${this.api}/` },
            })
            if (!sessRes.ok) return ""
            const session = sessRes.cookies?.PHPSESSID || ""
            if (!session) return ""

            const res = await fetch(torrent.link, {
                headers: { Referer: `${this.api}/`, Cookie: `PHPSESSID=${session}` },
            })
            if (!res.ok) return ""
            const html = res.text()

            const pageToken = (html.match(/window\.pageToken\s*=\s*'([^']+)'/) || [])[1] || ""
            const csrfToken = (html.match(/window\.csrfToken\s*=\s*'([^']+)'/) || [])[1] || ""
            if (!pageToken || !csrfToken) return ""

            const timestamp = Math.floor(Date.now() / 1000)
            const hmac = this.sha256Hex(`${id}|${timestamp}|${pageToken}`)
            const body = `torrent_id=${encodeURIComponent(id)}&download_type=magnet&timestamp=${timestamp}&hmac=${hmac}&sessid=${encodeURIComponent(csrfToken)}`

            const post = await fetch(`${this.api}/ajax/getTorrentMagnet.php`, {
                method: "POST",
                headers: {
                    Referer: torrent.link,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest",
                    Cookie: `PHPSESSID=${session}`,
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
            date: this.parseDate(cells.date),
            size: cells.size,
            formattedSize: cells.size ? this.formatBytes(cells.size) : "",
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
