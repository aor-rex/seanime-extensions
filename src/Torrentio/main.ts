/// <reference path="../anime-torrent-provider.d.ts" />
/// <reference path="../core.d.ts" />

const TORRENTIO_BASE = "https://torrentio.strem.fun"
const DEFAULT_CONFIG = "sort=qualitysize|qualityfilter=cam,scr,unknown"
const ARM_API = "https://arm.haglund.dev/api/v2/ids"
const YUNA_API = "https://relations.yuna.moe/api/ids"
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"

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
                timeout: 15,
                headers: { Accept: "application/sparql-results+json", "User-Agent": "seanime-torrentio/0.1.3" },
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

class Provider {
    private cache: { [anilistId: number]: ResolvedIds } = {}

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
        if (this.cache[media.id]) return this.cache[media.id]
        let resolved: ResolvedIds = {}

        try {
            const res = await fetch(ARM_API + "?source=anilist&id=" + media.id, { timeout: 15 })
            if (res.ok) {
                const d = res.json<any>()
                if (d) {
                    resolved = {
                        kitsuId: d.kitsu || undefined,
                        imdbId: d.imdb || undefined,
                        malId: d.myanimelist || undefined,
                    }
                }
            }
        } catch (e) {
            console.error("Torrentio: ARM lookup failed: " + errMsg(e))
        }

        if (!resolved.kitsuId) {
            try {
                const res = await fetch(YUNA_API + "?source=anilist&id=" + media.id, { timeout: 15 })
                if (res.ok) {
                    const d = res.json<any>()
                    if (d && d.kitsu) resolved.kitsuId = d.kitsu
                }
            } catch (e) {
                console.error("Torrentio: yuna lookup failed: " + errMsg(e))
            }
        }

        // Fallback for TMDB custom-source media: ARM/YUNA can't resolve the
        // synthetic encoded ID, so decode it to a TMDB ID and map to IMDb.
        if (!resolved.kitsuId && !resolved.imdbId) {
            const decoded = decodeTmdbId(unwrapRuntimeId(media.id))
            if (decoded) {
                const imdb = await tmdbToImdb(decoded.tmdbId, decoded.isMovie)
                if (imdb) {
                    resolved.imdbId = imdb
                    if (!decoded.isMovie) resolved.tmdbSeason = decoded.season
                }
            }
        }

        if (resolved.kitsuId || resolved.imdbId) {
            this.cache[media.id] = resolved
        }
        return resolved
    }

    private getConfigSegment(): string {
        const preset = ($getUserPreference("torrentioPreset") || "").trim()
        if (preset === "__none__") return ""
        const custom = ($getUserPreference("torrentioConfig") || "").trim()
        let seg = preset
        if (!seg) seg = custom
        if (!seg) seg = DEFAULT_CONFIG
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
        const res = await fetch(url, { timeout: 30 })
        if (!res.ok) return []
        const data = res.json<{ streams?: TorrentioStream[] }>()
        return (data && data.streams) ? data.streams : []
    }

    private isMovieOrSingle(media: Media): boolean {
        return media.format === "MOVIE" || media.episodeCount === 1
    }

    private async fetchForMedia(ids: ResolvedIds, media: Media, ep: number): Promise<TorrentioStream[]> {
        const movieOrSingle = this.isMovieOrSingle(media)
        if (ids.kitsuId) {
            if (movieOrSingle) {
                const streams = await this.fetchStreams(this.movieUrl(ids.kitsuId))
                return streams.length > 0 ? streams : this.fetchStreams(this.seriesUrl(ids.kitsuId, 1))
            }
            return this.fetchStreams(this.seriesUrl(ids.kitsuId, ep))
        }
        if (ids.imdbId) {
            if (movieOrSingle) {
                const streams = await this.fetchStreams(this.imdbMovieUrl(ids.imdbId))
                return streams.length > 0 ? streams : this.fetchStreams(this.imdbSeriesUrl(ids.imdbId, 1, 1))
            }
            const season = (ids.tmdbSeason && ids.tmdbSeason > 0) ? ids.tmdbSeason : 1
            return this.fetchStreams(this.imdbSeriesUrl(ids.imdbId, season, ep))
        }
        return []
    }

    async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const media = opts.media
            const ids = await this.resolveIds(media)
            const streams = await this.fetchForMedia(ids, media, 1)
            return dedupeByHash(streams.map(s => this.streamToTorrent(s, !!(ids.kitsuId || ids.imdbId))))
        } catch (e) {
            console.error("Torrentio: search error: " + errMsg(e))
            return []
        }
    }

    async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const media = opts.media
            const ids = await this.resolveIds(media)
            const movieOrSingle = this.isMovieOrSingle(media)
            const ep = opts.episodeNumber > 0 ? opts.episodeNumber : 1

            const streams = await this.fetchForMedia(ids, media, ep)
            let torrents = streams.map(s => this.streamToTorrent(s, !!(ids.kitsuId || ids.imdbId)))

            if (!movieOrSingle && opts.batch) {
                torrents = torrents.filter(t => t.isBatch)
            }

            if (opts.resolution) {
                torrents = torrents.filter(t => resolutionMatches(t.resolution || "", opts.resolution))
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
