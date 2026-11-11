/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

const TORRENTIO_BASE = "https://torrentio.strem.fun"
const ARM_API = "https://arm.haglund.dev/api/v2/ids"
const YUNA_API = "https://relations.yuna.moe/api/ids"
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
const TMDB_API = "https://api.themoviedb.org/3"

// Public TMDB v3 key used as the default so the query-based fallback works
// with zero configuration (user key overrides it). Query-based resolution is
// what makes free-text searches of non-AniList series ("Marvel's Daredevil")
// return results: Seanime sends an empty media for those, so there are no
// titles to match with unless the query itself is used.
const EMBEDDED_TMDB_KEY = "8476a7ab80ad76f0936744df0430e67c"

interface TorrentioStream {
    name: string
    title: string
    infoHash: string
    fileIdx?: number
    behaviorHints?: { bingeGroup?: string; filename?: string }
    sources?: string[]
}

interface ResolvedIds {
    kitsuId?: number
    imdbId?: string
    malId?: number
    tmdbSeason?: number
    // Set by the query-based fallback (media is empty then, so format can't
    // be read from it). Drives the movie-vs-series endpoint choice.
    isMovie?: boolean
}

function parseSizeToBytes(text: string): number {
    const m = text.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i)
    if (!m) return 0
    const value = parseFloat(m[1])
    const unit = m[2].toUpperCase()
    const mult: { [u: string]: number } = {
        B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776,
    }
    return Math.round(value * (mult[unit] || 1))
}

function parseStreamMeta(title: string): { seeders: number; sizeBytes: number; source: string } {
    const seedM = title.match(/👤\s*(\d+)/)
    const sizeM = title.match(/💾\s*([\d.]+\s*(?:B|KB|MB|GB|TB))/i)
    const srcM = title.match(/⚙️\s*([^\n]+)/)
    return {
        seeders: seedM ? parseInt(seedM[1], 10) : 0,
        sizeBytes: sizeM ? parseSizeToBytes(sizeM[1]) : 0,
        source: srcM ? srcM[1].trim() : "",
    }
}

function buildMagnet(infoHash: string, displayName: string, sources: string[]): string {
    let magnet = "magnet:?xt=urn:btih:" + infoHash
    if (displayName) magnet += "&dn=" + encodeURIComponent(displayName)
    const list = sources || []
    for (let i = 0; i < list.length; i++) {
        const s = list[i]
        if (s.indexOf("tracker:") === 0) {
            magnet += "&tr=" + encodeURIComponent(s.slice("tracker:".length))
        }
    }
    return magnet
}

function detectBatch(name: string): boolean {
    const n = name.toLowerCase()
    if (/\b(batch|complete|collection)\b/.test(n)) return true
    if (/s\d{1,2}\s*[-~]\s*s\d{1,2}/i.test(name)) return true
    const range = name.match(/\b(\d{1,3})\s*[-~]\s*(\d{1,3})\b/)
    if (range && parseInt(range[2], 10) > parseInt(range[1], 10)) return true
    return false
}

function detectStreamBatch(s: TorrentioStream): boolean {
    if (typeof s.fileIdx === "number" && s.fileIdx > 0) return true
    const lines = (s.title || "").split("\n")
    if (lines.length > 1 && lines[1].indexOf("/") !== -1) return true
    return detectBatch(firstLine(s.title) || s.name || "")
}

function errMsg(e: any): string {
    return e instanceof Error ? e.message : String(e)
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function parseResolution(name: string): string {
    const m = name.match(/(2160p|1080p|720p|480p|360p|4k)/i)
    return m ? m[1].toLowerCase() : ""
}

function resolutionMatches(resolution: string, wanted: string): boolean {
    if (!wanted) return true
    const w = wanted.toLowerCase().replace("p", "")
    const r = resolution.toLowerCase().replace("4k", "2160")
    return r.indexOf(w) !== -1
}

function firstLine(s: string): string {
    return (s || "").split("\n")[0].trim()
}

function dedupeByHash(list: AnimeTorrent[]): AnimeTorrent[] {
    const seen: { [k: string]: boolean } = {}
    const out: AnimeTorrent[] = []
    for (let i = 0; i < list.length; i++) {
        const t = list[i]
        const key = (t.infoHash || t.magnetLink || t.name).toLowerCase()
        if (seen[key]) continue
        seen[key] = true
        out.push(t)
    }
    return out
}

// Torrentio only reports the size of the single matched FILE per stream request
// (record.size). For season-pack torrents this is one episode's file, not the
// torrent total. We reconstruct the total by scanning each episode of the pack's
// season(s): Torrentio returns the same infoHash per episode with a distinct
// fileIdx, so summing distinct file sizes equals the torrent total.

// Detect the season range encoded in a pack title: "S01-S07", "S1-S2",
// "Season 1-4", "Seasons 1-3", "S1.S2.S3", "Season 1-2-3", "Season 1 & 2",
// "S01 to S07" -> {1,7}. Single-season: "S03", "Season 3" -> {3,3}.
// Returns null when no season info is found. The S/Season marker must be
// preceded by a separator (or string start) so "Episodes 1-13" or the
// trailing "s" of "Revengers" is never mistaken for a season marker.
function parseSeasonRange(title: string): { start: number; end: number } | null {
    const t = title || ""
    // "(?:seasons?|s) N" must be preceded by a separator (or string start) so
    // the trailing "s" of "Revengers" or "Episodes" is never a season marker.
    // A number immediately followed by "E<digit>" is an episode marker
    // ("S01E05"), not a season — excluded via lookahead.
    const pre = "(?:^|[\\s_.,|:—–-])(?:seasons?|s)\\s*s?\\s*"
    const num = "(\\d{1,2})(?![\\dEe])"
    const sep = "\\s*(?:[-–—~.&+]|to)\\s*(?:seasons?)?\\s*(?:s)?\\s*"
    const multi = t.match(new RegExp(pre + num + "((?:" + sep + num + ")*)", "ig"))
    if (multi) {
        // Collect every number inside all matched markers, take min/max.
        const nums: number[] = []
        const token = new RegExp("(\\d{1,2})", "g")
        let m: RegExpExecArray | null
        while ((m = token.exec(multi[0])) !== null) nums.push(parseInt(m[1], 10))
        if (nums.length >= 2) {
            const start = Math.min.apply(null, nums)
            const end = Math.max.apply(null, nums)
            if (end >= start) return { start: start, end: end }
        }
    }
    const single = t.match(new RegExp(pre + num, "i"))
    if (single) {
        const v = parseInt(single[1], 10)
        if (!isNaN(v)) return { start: v, end: v }
    }
    return null
}

function formatSizeBytes(size: number): string {
    if (!size) return "0 B"
    const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024))
    const units = ["B", "KB", "MB", "GB", "TB"]
    return (size / Math.pow(1024, i)).toFixed(2) + " " + (units[i] || "B")
}

// Whether a batch torrent's name encodes a season range that covers (or is the
// requested season). Multi-season packs ("S01-S07") are allowed as long as they
// include the season. Torrents with no parseable season info are kept, since we
// can't disprove they cover the season.
function coversSeason(name: string, season: number): boolean {
    const range = parseSeasonRange(name)
    if (!range) return true
    return season >= range.start && season <= range.end
}

// TMDB custom sources (like the bundled TMDB source) encode their media IDs:
//   movie: 1000000000 + tmdbId
//   tv:    2000000000 + tmdbId * 1000 + season
// These aren't AniList IDs, so ARM/YUNA can't resolve them. Decode them so we
// can map TMDB -> IMDb and query Torrentio directly with an IMDb ID.
function decodeTmdbId(id: number): { tmdbId: number; season: number; isMovie: boolean } | null {
    const numericId = Number(id)
    if (!numericId || isNaN(numericId)) return null

    if (numericId >= 2000000000) {
        const rest = numericId - 2000000000
        return {
            tmdbId: Math.floor(rest / 1000),
            season: rest % 1000,
            isMovie: false,
        }
    }

    if (numericId >= 1000000000) {
        return {
            tmdbId: numericId - 1000000000,
            season: 0,
            isMovie: true,
        }
    }

    return null
}

// Seanime re-encodes custom-source media IDs before handing them to torrent
// providers (internal/customsource/customsource.go GenerateMediaId):
//   runtimeId = 2^31 + (extensionIdentifier << 40) + localId
// The localId is the ID the custom source actually returned (e.g. a TMDB
// encoded ID). Unwrap it so the TMDB fallback can decode it.
const EXTENSION_ID_OFFSET = Math.pow(2, 31) // 2^31
const MAX_LOCAL_ID = Math.pow(2, 40) - 1    // 40 bits
function unwrapRuntimeId(id: number): number {
    const numericId = Number(id)
    if (!numericId || isNaN(numericId)) return numericId
    if (numericId < EXTENSION_ID_OFFSET) return numericId
    const offset = numericId - EXTENSION_ID_OFFSET
    return offset % (MAX_LOCAL_ID + 1)
}

// Resolve a TMDB ID to an IMDb ID via Wikidata (free, keyless). P4947 = TMDB
// movie ID, P4983 = TMDB TV series ID, P345 = IMDb ID.
async function tmdbToImdb(tmdbId: number, isMovie: boolean): Promise<string> {
    const prop = isMovie ? "P4947" : "P4983"
    const query = "SELECT ?imdb WHERE { ?item wdt:" + prop + " '" + tmdbId + "'; wdt:P345 ?imdb. }"
    try {
        const res = await fetch(
            WIKIDATA_SPARQL + "?query=" + encodeURIComponent(query) + "&format=json",
            {
                timeout: 5,
                headers: { Accept: "application/sparql-results+json", "User-Agent": "seanime-torrentio/0.1.9" },
            }
        )
        if (!res.ok) return ""
        const data = res.json<any>()
        if (!data || !data.results || !Array.isArray(data.results.bindings)) return ""
        for (let i = 0; i < data.results.bindings.length; i++) {
            const b = data.results.bindings[i]
            if (b && b.imdb && b.imdb.value) return b.imdb.value
        }
        return ""
    } catch (e) {
        console.error("Torrentio: Wikidata lookup failed: " + errMsg(e))
        return ""
    }
}

// Seanime runs "new Provider()" on every search/smartSearch call
// (extension_repo/goja_base.go callClassMethod), so instance-level caches are
// wiped between calls. The VM itself persists, so module-scope caches survive.
const idCache: { [anilistId: number]: ResolvedIds } = {}
// infoHash + config segment -> estimated total size in bytes
const batchSizeCache: { [key: string]: number } = {}

class Provider {
    getSettings(): AnimeProviderSettings {
        return {
            type: "special",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution"],
            supportsAdult: false,
        }
    }

    private streamToTorrent(s: TorrentioStream, confirmed: boolean): AnimeTorrent {
        const name = firstLine(s.title) || (s.behaviorHints && s.behaviorHints.filename) || s.name || "Unknown"
        const meta = parseStreamMeta(s.title || "")
        const resolution = parseResolution(s.name || name)
        return {
            name: name,
            date: "",
            size: meta.sizeBytes,
            formattedSize: "",
            seeders: meta.seeders,
            leechers: 0,
            downloadCount: 0,
            link: TORRENTIO_BASE + "/#" + s.infoHash,
            downloadUrl: "",
            magnetLink: buildMagnet(s.infoHash, name, s.sources || []),
            infoHash: s.infoHash,
            resolution: resolution,
            isBatch: detectStreamBatch(s),
            episodeNumber: -1,
            releaseGroup: "",
            isBestRelease: false,
            confirmed: confirmed,
        }
    }

    private async resolveIds(media: Media): Promise<ResolvedIds> {
        if (idCache[media.id]) return idCache[media.id]
        if (!media.id) return {}
        let resolved: ResolvedIds = {}

        // TMDB custom-source media: the ID is a synthetic runtime ID that
        // ARM/YUNA (AniList-keyed) can never resolve. Decode it and map the
        // TMDB ID to IMDb directly, skipping ARM/YUNA entirely.
        const decoded = decodeTmdbId(unwrapRuntimeId(media.id))
        if (decoded) {
            const imdb = await this.tmdbIdToImdb(decoded.tmdbId, decoded.isMovie)
            if (imdb) {
                resolved.imdbId = imdb
                if (!decoded.isMovie) resolved.tmdbSeason = decoded.season || 1
            }
        } else {
            // ARM and YUNA are independent and both keyed on the AniList id, so
            // query them in parallel. Prefer ARM (it also returns imdb/mal).
            const armPromise = (async () => {
                try {
                    const res = await fetch(ARM_API + "?source=anilist&id=" + media.id, { timeout: 5 })
                    if (res.ok) {
                        const d = res.json<any>()
                        if (d) {
                            return {
                                kitsuId: d.kitsu || undefined,
                                imdbId: d.imdb || undefined,
                                malId: d.myanimelist || undefined,
                            }
                        }
                    }
                } catch (e) {
                    console.error("Torrentio: ARM lookup failed: " + errMsg(e))
                }
                return null
            })()

            const yunaPromise = (async () => {
                try {
                    const res = await fetch(YUNA_API + "?source=anilist&id=" + media.id, { timeout: 5 })
                    if (res.ok) {
                        const d = res.json<any>()
                        if (d && d.kitsu) return { kitsuId: d.kitsu as number }
                    }
                } catch (e) {
                    console.error("Torrentio: yuna lookup failed: " + errMsg(e))
                }
                return null
            })()

            const [armResolved, yunaResolved] = await Promise.all([armPromise, yunaPromise])
            if (armResolved) resolved = armResolved
            if (!resolved.kitsuId && yunaResolved && yunaResolved.kitsuId) {
                resolved.kitsuId = yunaResolved.kitsuId
            }
        }

        // Fallback for brand-new series/movies that no mapping API has indexed
        // yet (ARM/YUNA/AniZip/Wikidata all return nothing for them). When the
        // user supplies an optional TMDB API key, search TMDB by title and map
        // the best hit to its IMDb ID so Torrentio can be queried directly.
        if (!resolved.kitsuId && !resolved.imdbId) {
            const tmdbResolved = await this.resolveViaTmdb(media)
            if (tmdbResolved.imdbId) {
                resolved.imdbId = tmdbResolved.imdbId
                if (tmdbResolved.tmdbSeason && tmdbResolved.tmdbSeason > 0) {
                    resolved.tmdbSeason = tmdbResolved.tmdbSeason
                }
            }
        }

        if (resolved.kitsuId || resolved.imdbId) {
            idCache[media.id] = resolved
        }
        return resolved
    }

    // Resolves a free-text query to a TMDB/IMDb entry. Used when the media is
    // empty (Seanime sends no media for free-text searches of titles that
    // aren't on AniList, e.g. "Marvel's Daredevil") or when media-based
    // resolution fails. Parses "Season N" / "S2" / "— Season 2" suffixes out
    // of the query so multi-season series resolve to the right season.
    private async resolveQueryToIds(query: string): Promise<ResolvedIds> {
        const parsed = this.parseQueryTitle(query)
        const q = (query || "").trim()
        if (!q) return {}
        const key = this.tmdbKey()
        if (!key) return {}

        const base = parsed.base
        const season = parsed.season

        // Try TV first (multi-season series are the common case), then movie.
        const types: Array<"tv" | "movie"> = ["tv", "movie"]
        for (const type of types) {
            let url = TMDB_API + "/search/" + type + "?api_key=" + encodeURIComponent(key) +
                "&language=en-US&query=" + encodeURIComponent(base)
            try {
                const res = await fetch(url, { timeout: 8 })
                if (!res.ok) continue
                const data = res.json<any>()
                const results = (data && Array.isArray(data.results)) ? data.results : []
                if (results.length === 0) continue

                // Rank: exact title match > title contains query > popularity.
                const ql = base.toLowerCase()
                let best = results[0]
                let bestScore = -1
                for (let j = 0; j < results.length; j++) {
                    const r = results[j]
                    const hitTitle = ((r && (r.name || r.title)) || "").toLowerCase()
                    let score = 0
                    if (hitTitle === ql) score += 4
                    else if (hitTitle.indexOf(ql) !== -1) score += 2
                    else if (ql.indexOf(hitTitle) !== -1 && hitTitle.length > 2) score += 1
                    if (score > bestScore) { bestScore = score; best = r }
                }
                if (!best || !best.id) continue

                const extUrl = TMDB_API + "/" + type + "/" + best.id +
                    "/external_ids?api_key=" + encodeURIComponent(key)
                const extRes = await fetch(extUrl, { timeout: 8 })
                if (!extRes.ok) continue
                const ext = extRes.json<any>()
                if (!ext || !ext.imdb_id) continue

                const out: ResolvedIds = { imdbId: ext.imdb_id }
                if (type === "tv") out.tmdbSeason = season > 0 ? season : 1
                else out.isMovie = true
                return out
            } catch (e) {
                console.error("Torrentio: query TMDB search failed: " + errMsg(e))
            }
        }
        return {}
    }

    // Effective TMDB key: user preference if set, else the embedded public key.
    private tmdbKey(): string {
        const userKey = ($getUserPreference("torrentioTmdbApiKey") || "").trim()
        return userKey || EMBEDDED_TMDB_KEY
    }

    // Splits a query into base title + season number. Handles every common
    // written form, with any separator (space, hyphen, dot, underscore,
    // em/en dash, colon):
    //   "Title Season 2"      "Title - Season 2"    "Title: Season 2"
    //   "Title S02"           "Title-S02"           "title-season-2"
    //   "Title season.2"      "Title_Season_2"
    //   "Title 2nd Season"    "Title 3rd Season"    "Title II" (roman)
    //   "Title Season Two"    "Title Second Season" (word numbers/ordinals)
    // Returns season 0 when no marker is present.
    private parseQueryTitle(query: string): { base: string; season: number } {
        const q = (query || "").trim()
        if (!q) return { base: "", season: 0 }

        // The marker must be preceded by a separator (or string start) so the
        // trailing "s" of words like "Revengers" is never mistaken for "S2".
        const PRE = "(?:^|[\\s_.,|:—–-])"
        const POST = "[\\s_.,|:—–-]*$"
        const pats: Array<{ re: RegExp; kind: string; grp: number }> = [
            { re: new RegExp(PRE + "seasons?" + "([\\s_.,|:—–-]*)" + "(\\d{1,2})" + POST, "i"), kind: "num", grp: 3 },
            { re: new RegExp(PRE + "(\\d{1,2})(?:st|nd|rd|th)" + "([\\s_.,|:—–-]*)" + "seasons?" + POST, "i"), kind: "num", grp: 2 },
            { re: new RegExp(PRE + "seasons?" + "([\\s_.,|:—–-]*)" + "(one|two|three|four|five|six|seven|eight|nine|ten)" + POST, "i"), kind: "word", grp: 3 },
            { re: new RegExp(PRE + "(first|second|third|fourth|fifth)" + "([\\s_.,|:—–-]*)" + "seasons?" + POST, "i"), kind: "wordord", grp: 2 },
            { re: new RegExp(PRE + "s" + "([\\s_.,|:—–-]*)" + "(\\d{1,2})" + POST, "i"), kind: "num", grp: 3 },
            { re: new RegExp(PRE + "(ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)" + POST, "i"), kind: "roman", grp: 2 },
        ]

        const wordToNum: { [k: string]: number } = {
            one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
            eight: 8, nine: 9, ten: 10,
            first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
        }
        const romanToNum: { [k: string]: number } = {
            ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
        }

        for (const p of pats) {
            const m = q.match(p.re)
            if (!m || m.index === undefined) continue
            let season = 0
            const val = m[p.grp - 1]
            if (p.kind === "roman") season = romanToNum[(val || "").toLowerCase()] || 0
            else if (p.kind === "word" || p.kind === "wordord") season = wordToNum[(val || "").toLowerCase()] || 0
            else season = parseInt(val, 10) || 0
            if (season <= 0) continue
            // Strip the marker (and the preceding separator char, if any).
            let base = q.slice(0, m.index)
            if (base && /[\s_.,|:—–-]/.test(base.charAt(base.length - 1))) {
                base = base.slice(0, base.length - 1)
            }
            base = base.trim()
            if (!base) continue
            return { base: base, season: season }
        }
        return { base: q, season: 0 }
    }

    // Map a TMDB ID to an IMDb ID. Prefers TMDB external_ids (one fast call)
    // and falls back to Wikidata (free, keyless).
    private async tmdbIdToImdb(tmdbId: number, isMovie: boolean): Promise<string> {
        const key = this.tmdbKey()
        if (key) {
            try {
                const type = isMovie ? "movie" : "tv"
                const res = await fetch(
                    TMDB_API + "/" + type + "/" + tmdbId +
                    "/external_ids?api_key=" + encodeURIComponent(key),
                    { timeout: 5 }
                )
                if (res.ok) {
                    const ext = res.json<any>()
                    if (ext && ext.imdb_id) return ext.imdb_id
                }
            } catch (e) {
                console.error("Torrentio: TMDB external_ids lookup failed: " + errMsg(e))
            }
        }
        return tmdbToImdb(tmdbId, isMovie)
    }

    // Title-based TMDB fallback used when ARM/YUNA and the encoded-ID path all
    // fail to resolve a media. Returns {} (with no IMDb id) when nothing matches.
    private async resolveViaTmdb(media: Media): Promise<ResolvedIds> {
        const key = this.tmdbKey()
        if (!key) return {}

        const isMovie = media.format === "MOVIE"
        const titles: string[] = []
        if (media.englishTitle) titles.push(media.englishTitle)
        if (media.romajiTitle) titles.push(media.romajiTitle)
        if (media.synonyms && Array.isArray(media.synonyms)) {
            for (let i = 0; i < media.synonyms.length; i++) titles.push(media.synonyms[i])
        }
        const unique: string[] = []
        const seenTitles: { [k: string]: boolean } = {}
        for (let i = 0; i < titles.length; i++) {
            const t = (titles[i] || "").trim()
            if (!t || seenTitles[t]) continue
            seenTitles[t] = true
            unique.push(t)
        }

        const type = isMovie ? "movie" : "tv"
        for (let i = 0; i < unique.length; i++) {
            const title = unique[i]
            let url = TMDB_API + "/search/" + type + "?api_key=" + encodeURIComponent(key) +
                "&language=en-US&query=" + encodeURIComponent(title)
            if (media.seasonYear && !isMovie) {
                url += "&first_air_date_year=" + media.seasonYear
            }
            if (isMovie && media.seasonYear) {
                url += "&year=" + media.seasonYear
            }
            try {
                const res = await fetch(url, { timeout: 5 })
                if (!res.ok) continue
                const data = res.json<any>()
                const results = (data && Array.isArray(data.results)) ? data.results : []
                if (results.length === 0) continue

                // Pick the best result: prefer a year match, else the first hit.
                let best = results[0]
                let bestScore = -1
                for (let j = 0; j < results.length; j++) {
                    const r = results[j]
                    let score = 0
                    if (media.seasonYear) {
                        const aired = r && (r.first_air_date || r.release_date || "")
                        const year = aired ? parseInt(aired.slice(0, 4), 10) : 0
                        if (year === media.seasonYear) score += 3
                    }
                    const hitTitle = (r && (r.name || r.title || "") || "").toLowerCase()
                    const q = title.toLowerCase()
                    if (hitTitle === q) score += 2
                    else if (hitTitle.indexOf(q) !== -1) score += 1
                    if (score > bestScore) {
                        bestScore = score
                        best = r
                    }
                }
                if (!best || !best.id) continue

                // Map TMDB id -> IMDb id via external_ids (no Wikidata needed).
                const extUrl = TMDB_API + "/" + type + "/" + best.id +
                    "/external_ids?api_key=" + encodeURIComponent(key)
                const extRes = await fetch(extUrl, { timeout: 5 })
                if (!extRes.ok) continue
                const ext = extRes.json<any>()
                if (!ext || !ext.imdb_id) continue

                const out: ResolvedIds = { imdbId: ext.imdb_id }

                // Determine the season number from the TMDB detail page by
                // matching the anime's season year to a season's air date.
                if (!isMovie) {
                    let season = 1
                    try {
                        const detUrl = TMDB_API + "/tv/" + best.id +
                            "?api_key=" + encodeURIComponent(key) + "&language=en-US"
                        const detRes = await fetch(detUrl, { timeout: 5 })
                        if (detRes.ok) {
                            const det = detRes.json<any>()
                            const seasons = det && Array.isArray(det.seasons) ? det.seasons : []
                            let yearMatch: number | null = null
                            let firstReal: number | null = null
                            for (let k = 0; k < seasons.length; k++) {
                                const s = seasons[k]
                                if (!s || !s.season_number || s.season_number === 0) continue
                                if (!firstReal) firstReal = s.season_number
                                if (s.air_date && media.seasonYear) {
                                    const sy = parseInt(String(s.air_date).slice(0, 4), 10)
                                    if (sy === media.seasonYear) {
                                        yearMatch = s.season_number
                                        break
                                    }
                                }
                            }
                            if (yearMatch !== null) season = yearMatch
                            else if (firstReal !== null) season = firstReal
                        }
                    } catch (e) {
                        console.error("Torrentio: TMDB season lookup failed: " + errMsg(e))
                    }
                    out.tmdbSeason = season
                }

                return out
            } catch (e) {
                console.error("Torrentio: TMDB search failed: " + errMsg(e))
            }
        }
        return {}
    }

    private getConfigSegment(): string {
        // Mirrors Torrentio's generateLink() (landingTemplate.js): emits
        // key=value pairs in the official order, dropping empty/default values.
        const split = (v: string | undefined): string[] => (v || "").split(",").map(x => x.trim()).filter(x => x.length > 0)

        const sort = ($getUserPreference("torrentioSort") || "").trim()
        const limit = ($getUserPreference("torrentioLimit") || "").trim()
        const language = split($getUserPreference("torrentioLanguage")).join(",")
        const qualityfilter = split($getUserPreference("torrentioQualityfilter")).join(",")
        const sizefilter = ($getUserPreference("torrentioSizefilter") || "").trim()
        const providers = split($getUserPreference("torrentioProviders")).join(",")
        const debrid = ($getUserPreference("torrentioDebrid") || "none").trim()
        const debridKey = ($getUserPreference("torrentioDebridKey") || "").trim()

        const configMap: Array<[string, string]> = [
            ["providers", providers],
            ["sort", sort !== "quality" ? sort : ""],
            ["language", language],
            ["qualityfilter", qualityfilter],
            ["limit", /^[1-9][0-9]{0,2}$/.test(limit) ? limit : ""],
            ["sizefilter", sizefilter],
            ["debridoptions", ""],
        ]
        if (debrid === "putio") {
            if (debridKey.includes("@")) configMap.push(["putio", debridKey])
        } else if (debrid !== "none" && debridKey) {
            configMap.push([debrid, debridKey])
        }

        const seg = configMap
            .filter(([k, v]) => v && v.length > 0 && k !== "none")
            .map(([k, v]) => k + "=" + v)
            .join("|")
        return seg.replace(/\|/g, "%7C")
    }

    private base(): string {
        const cfg = this.getConfigSegment()
        return cfg ? TORRENTIO_BASE + "/" + cfg : TORRENTIO_BASE
    }

    private seriesUrl(kitsuId: number, ep: number): string {
        return this.base() + "/stream/series/kitsu:" + kitsuId + ":" + ep + ".json"
    }

    private movieUrl(kitsuId: number): string {
        return this.base() + "/stream/movie/kitsu:" + kitsuId + ".json"
    }

    private imdbSeriesUrl(imdb: string, season: number, ep: number): string {
        return this.base() + "/stream/series/" + imdb + ":" + season + ":" + ep + ".json"
    }

    private imdbMovieUrl(imdb: string): string {
        return this.base() + "/stream/movie/" + imdb + ".json"
    }

    private async fetchStreams(url: string): Promise<TorrentioStream[]> {
        console.log("Torrentio: fetching " + url)
        let res = await fetch(url, { timeout: 30 })
        if (!res.ok && res.status >= 500) {
            // One-shot retry so a transient 502/504 doesn't zero out a response
            // and mislead the batch-size early-exit heuristic.
            await delay(500)
            res = await fetch(url, { timeout: 30 })
        }
        if (!res.ok) return []
        const data = res.json<{ streams?: TorrentioStream[] }>()
        return (data && data.streams) ? data.streams : []
    }

    private isMovieOrSingle(media: Media, ids?: ResolvedIds): boolean {
        if (media.format === "MOVIE") return true
        if (ids && ids.isMovie) return true
        // Empty media (free-text search of a non-AniList title): only the
        // resolved ids know the type. Default to series so episodes resolve.
        return media.episodeCount === 1
    }

    private async fetchForMedia(ids: ResolvedIds, media: Media, ep: number): Promise<TorrentioStream[]> {
        const movieOrSingle = this.isMovieOrSingle(media, ids)
        if (ids.kitsuId) {
            if (movieOrSingle) {
                const [movie, series] = await Promise.all([
                    this.fetchStreams(this.movieUrl(ids.kitsuId)),
                    this.fetchStreams(this.seriesUrl(ids.kitsuId, 1)),
                ])
                return movie.length > 0 ? movie : series
            }
            return this.fetchStreams(this.seriesUrl(ids.kitsuId, ep))
        }
        if (ids.imdbId) {
            if (movieOrSingle) {
                const [movie, series] = await Promise.all([
                    this.fetchStreams(this.imdbMovieUrl(ids.imdbId)),
                    this.fetchStreams(this.imdbSeriesUrl(ids.imdbId, 1, 1)),
                ])
                return movie.length > 0 ? movie : series
            }
            const season = (ids.tmdbSeason && ids.tmdbSeason > 0) ? ids.tmdbSeason : 1
            return this.fetchStreams(this.imdbSeriesUrl(ids.imdbId, season, ep))
        }
        return []
    }

    // Reconstruct total torrent sizes for batch torrents. Two strategies:
    //   1. Fast path: Torrentio's movie endpoint lists every file of a pack in a
    //      single response, so true totals need only one request per hash.
    //   2. Fallback: for hashes the movie endpoint didn't cover, scan the series
    //      episode endpoints in parallel (bounded concurrency) and sum the
    //      distinct file sizes, matching the old per-episode behavior.
    // Sizes from the fast path are exact; fallback sizes are the searched
    // season's total (extrapolated by the season range when known).
    private async estimateBatchSizes(
        torrents: AnimeTorrent[],
        ids: ResolvedIds,
        media: Media,
        alreadyFetched?: TorrentioStream[],
    ): Promise<void> {
        const batch = torrents.filter(t => t.isBatch && t.infoHash)
        if (batch.length === 0) return

        const cfg = this.getConfigSegment()
        const season = (ids.tmdbSeason && ids.tmdbSeason > 0) ? ids.tmdbSeason : 1
        const useKitsu = !!ids.kitsuId

        // Group per infoHash
        const nfo: { [k: string]: AnimeTorrent } = {}
        for (const t of batch) {
            if (!nfo[t.infoHash!]) nfo[t.infoHash!] = t
        }
        const hashes = Object.keys(nfo)
        const uncached: string[] = hashes.filter(
            h => !(batchSizeCache[cfg + "|" + h]) && !(batchSizeCache[cfg + "|" + h + "#true"])
        )

        if (uncached.length > 0) {
            const perHashFiles: { [k: string]: { [fileIdx: number]: number } } = {}
            const wanted = new Set(uncached)

            // Seed with file entries already returned by the caller's query so
            // the searched episode is never double-fetched.
            if (alreadyFetched) {
                for (const s of alreadyFetched) {
                    if (!wanted.has(s.infoHash)) continue
                    const size = parseStreamMeta(s.title || "").sizeBytes
                    if (!size) continue
                    const idx = typeof s.fileIdx === "number" ? s.fileIdx : 0
                    if (!perHashFiles[s.infoHash]) perHashFiles[s.infoHash] = {}
                    perHashFiles[s.infoHash][idx] = size
                }
            }

            // Fast path: one movie-endpoint request lists every file of a pack.
            const trueTotals = new Set<string>()
            const movieFiles: { [k: string]: { [fileIdx: number]: number } } = {}
            const movieUrl = useKitsu ? this.movieUrl(ids.kitsuId!) : this.imdbMovieUrl(ids.imdbId!)
            const movieStreams = await this.fetchStreams(movieUrl)
            for (const s of movieStreams) {
                if (!wanted.has(s.infoHash)) continue
                const size = parseStreamMeta(s.title || "").sizeBytes
                if (!size) continue
                const idx = typeof s.fileIdx === "number" ? s.fileIdx : 0
                if (!movieFiles[s.infoHash]) movieFiles[s.infoHash] = {}
                movieFiles[s.infoHash][idx] = size
                if (!perHashFiles[s.infoHash]) perHashFiles[s.infoHash] = {}
                perHashFiles[s.infoHash][idx] = size
            }
            // Trust the fast path only when the movie endpoint itself returned
            // multiple files for a hash (a batch is multi-file by definition);
            // single-file hits are likely a partial response, so let the episode
            // scan refine them.
            for (const h of uncached) {
                const set = movieFiles[h]
                if (set && Object.keys(set).length >= 2) trueTotals.add(h)
            }

            // Fallback: parallel episode scan for hashes the fast path missed.
            const missing = uncached.filter(h => !trueTotals.has(h))
            if (missing.length > 0) {
                const scanWanted = new Set(missing)
                const cap = Math.min(media.episodeCount && media.episodeCount > 0 ? media.episodeCount : 100, 100)
                const CONCURRENCY = 6
                let emptyRuns = 0
                let matched = false
                for (let start = 1; start <= cap; start += CONCURRENCY) {
                    const end = Math.min(start + CONCURRENCY - 1, cap)
                    const eps: number[] = []
                    for (let ep = start; ep <= end; ep++) eps.push(ep)
                    const results = await Promise.all(eps.map(ep => {
                        const url = useKitsu
                            ? this.seriesUrl(ids.kitsuId!, ep)
                            : this.imdbSeriesUrl(ids.imdbId!, season, ep)
                        return this.fetchStreams(url)
                    }))
                    for (let i = 0; i < eps.length; i++) {
                        const streams = results[i]
                        let foundAny = false
                        for (const s of streams) {
                            if (!scanWanted.has(s.infoHash)) continue
                            foundAny = true
                            const size = parseStreamMeta(s.title || "").sizeBytes
                            if (!size) continue
                            const idx = typeof s.fileIdx === "number" ? s.fileIdx : 0
                            if (!perHashFiles[s.infoHash]) perHashFiles[s.infoHash] = {}
                            perHashFiles[s.infoHash][idx] = size
                        }
                        // Stop after 2 consecutive episodes that produced no streams
                        // we care about, but only once we've matched at least one
                        // (kitsu packs may start at high absolute episode numbers).
                        if (foundAny) {
                            matched = true
                            emptyRuns = 0
                        } else if (matched) {
                            emptyRuns++
                            if (emptyRuns >= 2) break
                        }
                    }
                    if (emptyRuns >= 2 && matched) break
                }
            }

            // Cache: fast-path sums are true totals; scan sums are season totals.
            for (const h of uncached) {
                const set = perHashFiles[h]
                if (!set) continue
                let total = 0
                for (const k in set) total += set[k]
                if (total > 0) {
                    const key = trueTotals.has(h) ? cfg + "|" + h + "#true" : cfg + "|" + h
                    batchSizeCache[key] = total
                }
            }
        }

        // Apply estimates
        for (const h of hashes) {
            const t = nfo[h]
            const trueTotal = batchSizeCache[cfg + "|" + h + "#true"]
            if (trueTotal) {
                t.size = trueTotal
                t.formattedSize = formatSizeBytes(trueTotal)
                continue
            }
            const searchedSeasonTotal = batchSizeCache[cfg + "|" + h]
            if (!searchedSeasonTotal) continue
            const range = parseSeasonRange(t.name)
            if (range && range.end > range.start) {
                const seasons = range.end - range.start + 1
                const estimated = searchedSeasonTotal * seasons
                t.size = estimated
                t.formattedSize = "≈ " + formatSizeBytes(estimated)
            } else {
                t.size = searchedSeasonTotal
                // Exact total for the searched season: no "≈", but the UI
                // displays formattedSize, so it must still be populated.
                t.formattedSize = formatSizeBytes(searchedSeasonTotal)
            }
        }

        // Name-twin fallback: the same pack is often uploaded more than once
        // (different hash), and the scan sometimes only finds sizes for one
        // copy. Copy the known total onto its size-less twin, marked as an
        // estimate.
        const sizeByName: { [k: string]: number } = {}
        for (const h of hashes) {
            const t = nfo[h]
            if (!t.size) continue
            const key = (t.name || "").toLowerCase().replace(/\s+/g, " ").trim()
            if (key && !sizeByName[key]) sizeByName[key] = t.size
        }
        for (const h of hashes) {
            const t = nfo[h]
            if (t.size || t.formattedSize) continue
            const key = (t.name || "").toLowerCase().replace(/\s+/g, " ").trim()
            const twin = key ? sizeByName[key] : 0
            if (twin) {
                t.size = twin
                t.formattedSize = "≈ " + formatSizeBytes(twin)
            }
        }
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const media = opts.media
            let ids = await this.resolveIds(media)
            // Free-text search fallback: when the media is empty or unresolvable
            // (titles not on AniList, e.g. "Marvel's Daredevil"), resolve the
            // query text itself to an IMDb entry.
            if (!ids.kitsuId && !ids.imdbId && opts.query && opts.query.trim()) {
                ids = await this.resolveQueryToIds(opts.query)
            }
            const streams = await this.fetchForMedia(ids, media, 1)
            const torrents = dedupeByHash(streams.map(s => this.streamToTorrent(s, !!(ids.kitsuId || ids.imdbId))))
            if (!this.isMovieOrSingle(media, ids)) {
                await this.estimateBatchSizes(torrents, ids, media, streams)
            }
            return torrents
        } catch (e) {
            console.error("Torrentio: search error: " + errMsg(e))
            return []
        }
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const media = opts.media
            let ids = await this.resolveIds(media)
            if (!ids.kitsuId && !ids.imdbId && opts.query && opts.query.trim()) {
                ids = await this.resolveQueryToIds(opts.query)
            }
            const movieOrSingle = this.isMovieOrSingle(media, ids)
            const ep = opts.episodeNumber > 0 ? opts.episodeNumber : 1

            const streams = await this.fetchForMedia(ids, media, ep)
            let torrents = streams.map(s => this.streamToTorrent(s, !!(ids.kitsuId || ids.imdbId)))
            const unfiltered = torrents

            if (!movieOrSingle && opts.batch) {
                torrents = torrents.filter(t => t.isBatch)
            }

            if (!movieOrSingle && !opts.batch) {
                // Single-episode search: drop packs so the user only sees
                // releases for that exact episode, not whole-season batches.
                torrents = torrents.filter(t => !t.isBatch)
            }

            if (!movieOrSingle && opts.batch && ids.tmdbSeason && ids.tmdbSeason > 0) {
                // Season batch: keep packs whose season range covers the
                // requested season (e.g. an "S01-S07" pack is valid for S2, but
                // a "S05-S06" pack is not).
                const season = ids.tmdbSeason
                torrents = torrents.filter(t => coversSeason(t.name, season))
            }

            if (opts.resolution) {
                torrents = torrents.filter(t => resolutionMatches(t.resolution || "", opts.resolution))
            }

            // Fail-safe: if the smart-search filters emptied the list but the
            // upstream query DID return streams, show the unfiltered list
            // instead of nothing (over-aggressive batch detection or a filter
            // mismatch should never zero out a search).
            if (torrents.length === 0 && unfiltered.length > 0) {
                console.log("Torrentio: smart search filters removed all results — falling back to unfiltered list")
                torrents = unfiltered
            }

            if (!movieOrSingle) {
                await this.estimateBatchSizes(torrents, ids, media, streams)
            }

            return dedupeByHash(torrents)
        } catch (e) {
            console.error("Torrentio: smartSearch error: " + errMsg(e))
            return []
        }
    }

    async getLatest(): Promise<AnimeTorrent[]> {
        return []
    }

    async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        return torrent.infoHash || ""
    }

    async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        return torrent.magnetLink || ""
    }
}
