/// <reference path="../online-streaming-provider.d.ts" />
/// <reference path="../core.d.ts" />

// Cinejoy (cinejoy.pk) - Online Streaming Provider
//
// How it works (traced 2026-11-04 against the live SvelteKit app):
// - cinejoy.pk is a JS-only SPA: plain HTTP fetches return an empty app shell,
//   so there is no server-rendered search/watch HTML to scrape.
// - Title matching + episode lists come from TMDB. The site itself calls
//   api.themoviedb.org client-side with an embedded public key, so the
//   provider uses that same key by default (user may override via settings).
// - Result links are /movie/{tmdb}-{slug} and /series/{tmdb}-{slug};
//   watch pages are /watch/movie/{tmdb} and /watch/tv/{tmdb}/{s}/{e}.
// - Streams are resolved by the wing.st backend family (observed in-page):
//     api.wing.st/info?type=movie&tmdb={id}
//     api.wing.st/info?type=tv&tmdb={id}&season={s}&episode={e}
//   (votes/comments/trailer live on sibling server.wing.st / trailer.wing.st
//   hosts). The /info payload is parsed flexibly (see collectFiles) because
//   the site JS is obfuscated and the endpoint was flaky at trace time.

const TMDB_API = "https://api.themoviedb.org/3"

// Public key the cinejoy.pk frontend itself uses (seen in live page traffic).
// A user-supplied key (extension settings) takes precedence when set.
const EMBEDDED_TMDB_KEY = "8476a7ab80ad76f0936744df0430e67c"

const WING_INFO = "https://api.wing.st/info"

interface TmdbResult {
    id?: number
    media_type?: string
    title?: string
    name?: string
    original_title?: string
    original_name?: string
    release_date?: string
    first_air_date?: string
}

interface TmdbSearchResponse {
    results?: TmdbResult[]
}

interface TmdbSeason {
    season_number?: number
    episode_count?: number
    name?: string
}

interface TmdbTvDetails {
    id?: number
    name?: string
    seasons?: TmdbSeason[]
}

interface TmdbSeasonDetails {
    episodes?: { episode_number?: number; name?: string }[]
}

class Provider implements AnimeProvider {
    private tmdbKey = "{{tmdb-api-key}}"
    private baseUrl = "{{base-url}}"

    getSettings(): Settings {
        return {
            episodeServers: ["cinejoy"],
            supportsDub: false,
        }
    }

    // ---------------------------------------------------------------- helpers

    private str(v: any): string {
        return v === null || v === undefined ? "" : String(v)
    }

    private base(): string {
        const b = this.str((() => { try { return $getUserPreference("base-url") } catch { return "" } })() || this.baseUrl).trim()
        if (b && !b.includes("{{")) return b.replace(/\/+$/, "")
        return "https://cinejoy.pk"
    }

    private key(): string {
        try {
            const k = this.str($getUserPreference("tmdb-api-key") || this.tmdbKey).trim()
            if (k && !k.includes("{{")) return k
        } catch { /* fall through */ }
        // Fall back to the public key the cinejoy.pk frontend uses itself.
        return EMBEDDED_TMDB_KEY
    }

    private hasKey(): boolean {
        return this.key().length > 0
    }

    private vidsrcType(mediaFormat: string | undefined): "tv" | "movie" {
        const f = String(mediaFormat || "").toUpperCase()
        if (f === "MOVIE" || f === "SPECIAL") return "movie"
        return "tv"
    }

    private yearOf(r: TmdbResult): number {
        const d = this.str(r.release_date || r.first_air_date)
        const m = d.match(/^(\d{4})/)
        return m ? Number(m[1]) : 0
    }

    private titleOf(r: TmdbResult): string {
        return this.str(r.title || r.name || r.original_title || r.original_name)
    }

    private levenshtein(a: string, b: string): number {
        const m = a.length
        const n = b.length
        if (m === 0) return n
        if (n === 0) return m
        const dp = new Array<number>(n + 1)
        for (let j = 0; j <= n; j++) dp[j] = j
        for (let i = 1; i <= m; i++) {
            let prev = dp[0]
            dp[0] = i
            for (let j = 1; j <= n; j++) {
                const cur = dp[j]
                dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
                prev = cur
            }
        }
        return dp[n]
    }

    private async tmdb<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
        const key = this.key()
        if (!key) return null
        const qs = Object.entries({ api_key: key, ...params })
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&")
        try {
            const res = await fetch(`${TMDB_API}${path}?${qs}`)
            if (!res.ok) return null
            return res.json() as unknown as T
        } catch {
            return null
        }
    }

    private async fetchText(url: string, referer?: string): Promise<string | null> {
        try {
            const headers: Record<string, string> = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
            }
            if (referer) headers["Referer"] = referer
            const res = await fetch(url, { headers })
            if (!res.ok) return null
            return res.text()
        } catch {
            return null
        }
    }

    // ---------------------------------------------------------------- search

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = String(opts.query || "").trim()
        if (!query) return []

        const want = this.vidsrcType(opts.media?.format)
        const data = await this.tmdb<TmdbSearchResponse>("/search/multi", {
            query,
            include_adult: "false",
            language: "en-US",
            page: "1",
        })
        const results = (data?.results || []).filter((r) => {
            const mt = String(r.media_type || "")
            if (want === "movie") return mt === "movie"
            return mt === "tv" || mt === "movie"
        })
        if (results.length === 0) return []

        const q = query.toLowerCase()
        const ranked = [...results].sort((a, b) => {
            // Prefer correct media type first.
            const am = String(a.media_type || "") === (want === "movie" ? "movie" : "tv") ? 0 : 1
            const bm = String(b.media_type || "") === (want === "movie" ? "movie" : "tv") ? 0 : 1
            if (am !== bm) return am - bm
            return this.levenshtein(this.titleOf(a).toLowerCase(), q) - this.levenshtein(this.titleOf(b).toLowerCase(), q)
        })

        let best = ranked[0]
        const year = opts.year
        if (year) {
            const byYear = ranked.filter((r) => this.yearOf(r) === year)
            if (byYear.length > 0) best = byYear[0]
        }
        if (!best?.id) return []

        const isMovie = String(best.media_type || "") === "movie"
        if (isMovie || want === "movie") {
            return [{
                id: `movie:${best.id}`,
                title: this.titleOf(best),
                url: `movie:${best.id}`,
                subOrDub: "sub",
            }]
        }

        const season = await this.determineSeason(best.id, opts)
        const id = season > 0 ? `tv:${best.id}:${season}` : `tv:${best.id}`
        return [{
            id,
            title: this.titleOf(best),
            url: id,
            subOrDub: "sub",
        }]
    }

    // Match the AniList entry's episode count against TMDB season sizes so a
    // multi-season show resolves to the right season (same idea as vidsrc).
    private async determineSeason(tmdbId: number, opts: SearchOptions): Promise<number> {
        const details = await this.tmdb<TmdbTvDetails>(`/tv/${tmdbId}`, { language: "en-US" })
        const seasons = (details?.seasons || []).filter((s) => (s.season_number ?? 0) > 0)
        if (seasons.length === 0) return 0
        if (seasons.length === 1) return seasons[0].season_number ?? 1
        const ec = opts.media?.episodeCount
        if (ec && ec > 0) {
            const matches = seasons.filter((s) => s.episode_count === ec)
            if (matches.length === 1) return matches[0].season_number ?? 0
        }
        return 0
    }

    // ---------------------------------------------------------------- findEpisodes

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const parsed = this.parseId(id)
        if (!parsed) return []

        if (parsed.type === "movie") {
            return [{
                id: `movie:${parsed.tmdb}:1`,
                number: 1,
                url: "1:1",
                title: "Movie",
            }]
        }

        const details = await this.tmdb<TmdbTvDetails>(`/tv/${parsed.tmdb}`, { language: "en-US" })
        const seasons = (details?.seasons || [])
            .map((s) => s.season_number ?? 0)
            .filter((n) => n > 0)
            .sort((a, b) => a - b)
        if (seasons.length === 0) return []

        const wanted = parsed.season > 0 ? [parsed.season] : seasons
        const episodes: EpisodeDetails[] = []
        let number = 0
        for (const s of wanted) {
            const sd = await this.tmdb<TmdbSeasonDetails>(`/tv/${parsed.tmdb}/season/${s}`, { language: "en-US" })
            const eps = (sd?.episodes || [])
                .map((e) => e.episode_number ?? 0)
                .filter((n) => n > 0)
                .sort((a, b) => a - b)
            if (parsed.season > 0) {
                for (let i = 0; i < eps.length; i++) {
                    episodes.push({
                        id: `tv:${parsed.tmdb}:${s}:${eps[i]}`,
                        number: i + 1,
                        url: `${s}:${eps[i]}`,
                        title: `Episode ${i + 1}`,
                    })
                }
                return episodes
            }
            for (const e of eps) {
                number++
                episodes.push({
                    id: `tv:${parsed.tmdb}:${s}:${e}`,
                    number,
                    url: `${s}:${e}`,
                    title: `Episode ${number}`,
                })
            }
        }
        return episodes
    }

    // ---------------------------------------------------------------- findEpisodeServer

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta = this.metaFromEpisode(episode)
        if (!meta) throw new Error("cinejoy: could not determine media from episode")

        // Query the wing.st stream-info backend the site itself uses.
        // TV takes season/episode; try the canonical shape then alternates.
        const queries: string[] =
            meta.type === "movie"
                ? [`type=movie&tmdb=${encodeURIComponent(meta.tmdb)}`]
                : [
                    `type=tv&tmdb=${encodeURIComponent(meta.tmdb)}&season=${meta.season}&episode=${meta.epNum}`,
                    `type=tv&tmdb=${encodeURIComponent(meta.tmdb)}&s=${meta.season}&e=${meta.epNum}`,
                ]

        let payload: any = null
        let lastErr = ""
        for (const q of queries) {
            try {
                const res = await fetch(`${WING_INFO}?${q}`, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
                        "Accept": "application/json",
                        "Referer": `${this.base()}/watch/${meta.type}/${meta.tmdb}`,
                    },
                })
                if (!res.ok) {
                    lastErr = `HTTP ${res.status}`
                    continue
                }
                const text = res.text()
                if (!text || /^\s*error code:/i.test(text)) {
                    lastErr = "backend error"
                    continue
                }
                try {
                    payload = JSON.parse(text)
                } catch {
                    lastErr = "non-JSON response"
                    continue
                }
                if (this.collectFiles(payload).length > 0) break
                lastErr = "no playable file in response"
                payload = null
            } catch (e) {
                lastErr = String(e)
            }
        }
        if (!payload) {
            throw new Error(`cinejoy: no stream resolved for this title (${lastErr})`)
        }

        const files = this.collectFiles(payload)
        if (files.length === 0) throw new Error("cinejoy: no playable mp4/m3u8 found in stream info")

        // Prefer m3u8 master playlists, then highest labeled quality.
        files.sort((a, b) => {
            const at = a.url.toLowerCase().includes("m3u8") ? 0 : 1
            const bt = b.url.toLowerCase().includes("m3u8") ? 0 : 1
            if (at !== bt) return at - bt
            return (b.weight || 0) - (a.weight || 0)
        })
        const best = files[0]
        const type = best.url.toLowerCase().split("?")[0].endsWith(".mp4") ? "mp4" : "m3u8"
        const subtitles = this.collectSubtitles(payload)

        return {
            server: "cinejoy",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
                "Referer": `${this.base()}/`,
            },
            videoSources: [{
                url: best.url,
                type,
                quality: best.quality || "auto",
                subtitles,
            }],
        }
    }

    private parseId(id: string): { type: "tv" | "movie"; tmdb: string; season: number } | null {
        const m = String(id || "").match(/^(tv|movie):(\d+)(?::(\d+))?$/)
        if (!m) return null
        const season = m[3] ? Number(m[3]) : 0
        return { type: m[1] === "movie" ? "movie" : "tv", tmdb: m[2], season: Number.isFinite(season) && season > 0 ? season : 0 }
    }

    private metaFromEpisode(episode: EpisodeDetails): { type: "tv" | "movie"; tmdb: string; season: number; epNum: number } | null {
        const idParts = String(episode?.id || "").split(":")
        if (idParts[0] === "movie" && idParts[1]) {
            return { type: "movie", tmdb: idParts[1], season: 1, epNum: 1 }
        }
        if (idParts[0] === "tv" && idParts[1]) {
            const season = Number(idParts[2])
            const epNum = Number(idParts[3])
            return {
                type: "tv",
                tmdb: idParts[1],
                season: Number.isFinite(season) && season > 0 ? season : 1,
                epNum: Number.isFinite(epNum) && epNum > 0 ? epNum : 1,
            }
        }
        return null
    }

    private async tmdbTitle(meta: { type: "tv" | "movie"; tmdb: string }): Promise<string> {
        const path = meta.type === "movie" ? `/movie/${meta.tmdb}` : `/tv/${meta.tmdb}`
        const d = await this.tmdb<{ title?: string; name?: string }>(path, { language: "en-US" })
        return this.str(d?.title || d?.name)
    }

    // Recursively collects playable file URLs from the wing.st info payload.
    // The payload shape is not pinned (obfuscated frontend), so anything
    // that looks like an mp4/m3u8 URL counts; iframe/embed pages do not.
    private collectFiles(node: any): { url: string; quality: string; weight: number }[] {
        const out: { url: string; quality: string; weight: number }[] = []
        const seen = new Set<string>()
        const visit = (v: any, quality: string): void => {
            if (typeof v === "string") {
                const m = v.match(/https?:[^\s"'<>\\]+?\.(m3u8|mp4)(\?[^\s"'<>\\]*)?/i)
                if (m) {
                    const url = m[0].replace(/\\\//g, "/")
                    const key = url.toLowerCase()
                    if (!seen.has(key)) {
                        seen.add(key)
                        out.push({ url, quality, weight: this.qualityWeight(quality) })
                    }
                }
                return
            }
            if (Array.isArray(v)) {
                for (const item of v) visit(item, quality)
                return
            }
            if (v && typeof v === "object") {
                const q = this.str(v.quality || v.label || v.name || quality)
                for (const k of Object.keys(v)) {
                    if (/^(iframe|embed|frame)$/i.test(k)) continue
                    visit(v[k], q)
                }
            }
        }
        visit(node, "")
        return out
    }

    private qualityWeight(q: string): number {
        const m = String(q || "").match(/(\d{3,4})\s*p?/i)
        if (m) return Number(m[1])
        if (/auto|original|source/i.test(q)) return 9999
        return 0
    }

    private collectSubtitles(node: any): VideoSubtitle[] {
        const out: VideoSubtitle[] = []
        const seen = new Set<string>()
        let n = 0
        const visit = (v: any): void => {
            if (Array.isArray(v)) {
                for (const item of v) visit(item)
                return
            }
            if (v && typeof v === "object") {
                const url = this.str(v.file || v.url || v.src || v.uri)
                const lang = this.str(v.lang || v.language || v.srclang || v.label || v.name)
                if (url && /\.(vtt|srt|ass)$/i.test(url.split("?")[0]) && !seen.has(url)) {
                    seen.add(url)
                    out.push({ id: `sub-${n}`, url, language: lang || `sub-${n}`, isDefault: n === 0 })
                    n++
                    return
                }
                for (const k of Object.keys(v)) visit(v[k])
            }
        }
        visit(node)
        return out
    }

}
