/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

class Provider {
    private api = "https://knaben.org"

    // Knaben category codes (from the browse/category select):
    // Audio=1000000, TV=2000000, Movies=3000000, PC=4000000,
    // XXX=5000000, Anime=6000000, Console=7000000, Mobile=8000000,
    // Books=9000000, Other=10000000. Sub-categories refine the code
    // (e.g. Anime/Subbed=6001000) but the top-level code already scopes
    // results well enough for provider searches.
    private catAnime = "6000000"
    private catTv = "2000000"
    private catMovies = "3000000"

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
        const single = name.match(/(?:^|[.\s\-_])E(\d{1,3})(?:[.\s\-_]|$)/i)
        return single ? Number(single[1]) : -1
    }

    private seasonOf(name: string): number {
        const m = name.match(/\bS(\d{1,2})E\d{1,3}\b/i)
        return m ? Number(m[1]) : 0
    }

    private isBatchName(name: string): boolean {
        if (/(^|\b)(batch|complete|collection|complete series|boxset)(\b|$)/i.test(name)) return true
        if (/(^|\b)S\d{1,2}(-|$)/i.test(name) && !/E\d/i.test(name)) return true
        if (/\bseason\s+\d{1,2}\b/i.test(name) && !this.hasEpisodeMarker(name)) return true
        if (/\b\d{1,4}\s*[-–—~]\s*\d{1,4}\b/.test(name)) return true
        return false
    }

    // True when the name carries a single-episode marker (SxxEyy, "EP n", "E n", "- NNN").
    private hasEpisodeMarker(name: string): boolean {
        if (/\bS\d{1,2}E\d{1,3}\b/i.test(name)) return true
        if (/\b(?:Episode|EP)\s*#?\s*\d{1,3}\b/i.test(name)) return true
        if (/(?:^|[.\s\-_])E\d{1,3}(?:[.\s\-_]|$)/i.test(name)) return true
        return /(?:^|[\s\-_\[])(\d{1,3})(?:[\s\-_\].]|$)/.test(name) && /\b\d{3,4}p\b/i.test(name)
    }

    // Tokens that describe the file (codec, quality, site tags) rather than the
    // media itself. Used so they don't count as "foreign" title tokens.
    private isTechToken(t: string): boolean {
        if (/^(s\d{1,2}e\d{1,3}|s\d{1,2}|e\d{1,3}|ep\d{1,3})$/i.test(t)) return true
        if (/^\d{1,4}$/.test(t)) return true
        if (/^\d{3,4}p$/.test(t) || /^[248]k$/i.test(t)) return true
        if (/^(web|webrip|webdl|hdtv|hdrip|dvdrip|bluray|blu|bdrip|bdr|bd|remux|x264|x265|x264|x265|h264|h265|hevc|avc|hdr|hdr10|dolby|vision|atmos|dts|truehd|aac|ac3|eac3|flac|multi|dual|dualaudio|sub|subs|subbed|dub|dubbed|eng|en|fr|french|truefrench|esp|spa|ger|deu|ita|kor|jpn|jap|chi|pol|por|rus|tur|10bit|8bit)$/i.test(t)) return true
        if (/^(complete|collection|boxset|series|season|pack|batch|mini|miniseries|part|parts|vol|volume|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|final|full|remaster|restored|extended|uncut|director|directors|cut|theatrical|proper|repack|internal|criterion|anniversary|edition|atvp|appletv|amzn|amazon|nf|netflix|dsnp|disney|hbo|hulu|hmax|max|peacock|paramount|showtime|nyaa|subsplease|erai|judas|ryujin)$/i.test(t)) return true
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

    // True when the torrent name matches the requested episode number for the
    // given season. Torrents without an explicit season marker only need to
    // match the episode number.
    private matchesEpisode(name: string, episodeNumber: number, season: number, offset: number): boolean {
        const ep = this.episodeOf(name)
        if (ep !== episodeNumber) {
            if (!(offset > 0 && episodeNumber > offset && ep === episodeNumber - offset)) {
                // Absolute-numbered releases ("Naruto - 129") carry the raw
                // episode number without an SxxEyy marker.
                const abs = name.match(/(?:^|[\s\-_\[]v?\d*\s?)(\d{1,4})(?:[\s\-_\].]|$)/)
                if (!abs || Number(abs[1]) !== episodeNumber) return false
            }
        }
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

    // Map a media format to a Knaben category code.
    private categoryFor(media: Media): string {
        if (this.isMovie(media)) return this.catMovies
        if (media.format === "ANIME" || media.format === "ONA" || media.format === "OVA" || media.format === "SPECIAL") return this.catAnime
        return this.catTv
    }

    // Parses a Knaben date cell into RFC3339. Cells carry a full
    // "YYYY-MM-DD HH:MM:SS" datetime in the title attribute and a
    // "YYYY-MM-DD" short date as text.
    private parseDate(value: string, title: string): string {
        const src = (title || value || "").trim()
        if (!src) return new Date().toISOString()
        const m = src.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
        if (m) {
            const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)))
            if (!isNaN(d.getTime())) return d.toISOString()
        }
        return new Date().toISOString()
    }

    // Parses a single result table row into an AnimeTorrent. Knaben rows carry
    // the magnet link and the info hash directly (tr[data-id], the title link
    // href and span.copy-to-clipboard[data-copy-to-clipboard-content]), so no
    // detail-page scrape is needed.
    private toAnimeTorrent(el: DocSelection, searchUrl: string): AnimeTorrent | null {
        const cells = el.find("td")
        if (cells.length() < 6) return null

        const titleLink = cells.eq(1).find("a[href^='magnet:']").first()
        const magnet = titleLink.attr("href") || ""
        const title = (titleLink.attr("title") || titleLink.text() || "").trim()
        if (!title || !magnet) return null

        let infoHash = (el.attr("data-id") || "").trim().toLowerCase()
        if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
            const spanHash = cells.eq(1).find("span.copy-to-clipboard").first().attr("data-copy-to-clipboard-content") || ""
            if (/^[a-f0-9]{40}$/i.test(spanHash.trim())) infoHash = spanHash.trim().toLowerCase()
        }
        if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
            const btih = magnet.match(/btih:([a-fA-F0-9]{40})/)
            infoHash = btih ? btih[1].toLowerCase() : ""
        }

        const sizeCell = cells.eq(2)
        const sizeTitle = sizeCell.attr("title") || ""
        let size = 0
        const byteMatch = sizeTitle.match(/([\d.]+)\s*Bytes/i)
        if (byteMatch) size = Math.round(parseFloat(byteMatch[1]))
        if (!size) size = this.sizeToBytes(sizeCell.text().trim())

        const dateCell = cells.eq(3)
        const date = this.parseDate(dateCell.text().trim(), dateCell.attr("title") || "")

        const seeders = parseInt(cells.eq(4).text().trim(), 10) || 0
        const leechers = parseInt(cells.eq(5).text().trim(), 10) || 0

        return {
            name: title,
            date: date,
            size: size,
            formattedSize: size ? this.formatBytes(size) : "",
            seeders: seeders,
            leechers: leechers,
            downloadCount: 0,
            link: searchUrl,
            downloadUrl: "",
            magnetLink: magnet,
            infoHash: infoHash || null,
            resolution: this.extractResolution(title),
            isBatch: this.isBatchName(title),
            episodeNumber: this.episodeOf(title),
            releaseGroup: "",
            isBestRelease: false,
            confirmed: true,
        }
    }

    private async scrape(query: string, category: string): Promise<AnimeTorrent[]> {
        const searchUrl = `${this.api}/search/${encodeURIComponent(query)}/${category}/1/-seeders`
        try {
            const res = await fetch(searchUrl, {
                headers: { Referer: `${this.api}/` },
            })
            if (!res.ok) return []
            const $ = LoadDoc(res.text())
            const ret: AnimeTorrent[] = []
            $("table.table tbody tr").each((_, el) => {
                const t = this.toAnimeTorrent(el, searchUrl)
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
        return torrents.filter((t) => this.belongsTo(t.name, aliases, isMovie, season, mediaYear))
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        const split = this.splitSeason(this.baseTitle(opts))
        const base = split.base
        const season = split.season
        const isMovie = this.isMovie(opts.media)
        const mediaYear = opts.media.seasonYear || opts.media.startDate?.year || 0
        const aliases = this.buildAliasTokens(opts.query, opts.media.englishTitle, opts.media.romajiTitle, ...(opts.media.synonyms ?? []))
        const offset = opts.media.absoluteSeasonOffset || 0
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

        // Title-only fallback query (optionally constrained by resolution), used
        // whenever the precise query comes back empty or is fully filtered out.
        const fallback = async (): Promise<AnimeTorrent[]> => {
            let fb = base
            if (opts.resolution) fb += ` ${opts.resolution}`
            return query(fb)
        }

        // Batch search: fall back to a title-only query and keep anything that
        // looks like a batch. If the provider has no batch torrents for this
        // media, fall through to the single-episode search below.
        if (!isMovie && opts.batch) {
            let torrents = await query(q)
            if (torrents.length === 0) {
                torrents = (await fallback()).filter((t) => t.isBatch)
            }
            const batches = torrents
                .filter((t) => t.isBatch && this.belongsTo(t.name, aliases, false, season, mediaYear))
            if (batches.length > 0) {
                return batches
            }
            // No batches found: continue into single-episode search.
        }

        // Single-episode search: retry with a title-only query and keep batches
        // + torrents that parse to the requested season/episode whenever the
        // precise query yields nothing. Movies skip this branch entirely.
        if (!isMovie && opts.episodeNumber > 0) {
            const keep = (t: AnimeTorrent) =>
                t.isBatch || this.matchesEpisode(t.name, opts.episodeNumber, season, offset)

            let torrents = opts.batch ? await fallback() : await query(q)
            let filtered = torrents.filter((t) =>
                this.belongsTo(t.name, aliases, isMovie, season, mediaYear) && keep(t),
            )
            if (filtered.length === 0) {
                torrents = await fallback()
                filtered = torrents.filter((t) =>
                    this.belongsTo(t.name, aliases, isMovie, season, mediaYear) && keep(t),
                )
            }
            return filtered
        }

        // Generic path: plain (movie / no-episode) search, possibly following a
        // batch-mode fallthrough with no episode number.
        let torrents = await query(q)
        if (torrents.length === 0) {
            torrents = await fallback()
        }
        return torrents.filter((t) => this.belongsTo(t.name, aliases, isMovie, season, mediaYear))
    }

    // Knaben rows already carry the magnet link, so this is a passthrough.
    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }

    // Knaben rows already carry the info hash (tr[data-id]).
    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    // Knaben has no "latest torrents" endpoint consumed here.
    async getLatest(): Promise<AnimeTorrent[]> {
        return []
    }
}
