/// <reference path="../custom-source.d.ts" />
/// <reference path="../core.d.ts" />

interface SimklIds {
    simkl?: number
    simkl_id?: number
    slug?: string
    imdb?: string
    tvdb?: string
    tmdb?: string
}

interface SimklRatingSource {
    rating?: number
    votes?: number
}

interface SimklRatings {
    simkl?: SimklRatingSource
    imdb?: SimklRatingSource
}

interface SimklItem {
    title?: string
    en_title?: string
    title_en?: string
    year?: number
    type?: string
    endpoint_type?: string
    anime_type?: string
    ids?: SimklIds
    poster?: string
    fanart?: string
    overview?: string
    genres?: string[]
    all_titles?: string[]
    total_episodes?: number
    ep_count?: number
    status?: string
    ratings?: SimklRatings
    runtime?: number
    first_aired?: string
    last_aired?: string
    rank?: number
    country?: string
    network?: string
    director?: string
    trailers?: SimklTrailer[]
    studios?: { name?: string }[]
    relations?: SimklRelation[]
    users_recommendations?: SimklRelation[]
    watching_details?: {
        watched_episodes?: number
        total_episodes?: number
    }
    adult?: boolean
}

interface SimklTrailer {
    name?: string
    youtube?: string
    size?: number
}

interface SimklRelation {
    title?: string
    url?: string
    year?: number
    type?: string
    poster?: string
}

interface SimklEpisode {
    season?: number
    episode?: number
    type?: string
    title?: string
    date?: string
    img?: string
    description?: string
    runtime?: number
    tvdb?: {
        season?: number
        episode?: number
    }
}

interface SimklWatchlistSeason {
    number?: number
    episodes?: { number?: number }[]
}

interface SimklWatchlistItem {
    status?: string
    show?: SimklItem
    movie?: SimklItem
    seasons?: SimklWatchlistSeason[]
}

interface SimklWatchlist {
    movies?: SimklWatchlistItem[]
    shows?: SimklWatchlistItem[]
    anime?: SimklWatchlistItem[]
}

interface SimklSeasonInfo {
    counts: Record<number, number>
}

type SimklMediaType = "movie" | "tv" | "anime"

const API_BASE = "https://api.simkl.com"

const MOVIE_OFFSET = 1000000000
const TV_OFFSET = 2000000000
const ANIME_OFFSET = 3000000000

class Provider implements CustomSource {
    private clientId = "{{client-id}}"
    private accessToken = "{{access-token}}"
    private hideAnime = String("{{hide-anime}}") === "true"

    getSettings(): Settings {
        return {
            supportsAnime: true,
            supportsManga: false,
        }
    }

    // ---------------------------------------------------------------- helpers

    private buildUrl(path: string, params: Record<string, string> = {}): string {
        const qs: string[] = [`client_id=${encodeURIComponent(this.clientId)}`]
        for (const key of Object.keys(params)) {
            qs.push(`${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
        }
        return `${API_BASE}${path}?${qs.join("&")}`
    }

    private headers(auth: boolean): Record<string, string> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            "simkl-api-key": this.clientId,
        }
        if (auth && this.accessToken) {
            h["Authorization"] = `Bearer ${this.accessToken}`
        }
        return h
    }

    private async get<T>(path: string, params: Record<string, string> = {}, auth = false): Promise<T | null> {
        try {
            const res = await fetch(this.buildUrl(path, params), { headers: this.headers(auth) })
            if (!res.ok) return null
            return res.json<T>()
        } catch (err) {
            return null
        }
    }

    private hasClientId(): boolean {
        const key = String(this.clientId || "").trim()
        return key.length > 0 && !key.includes("{{")
    }

    private idOf(item: SimklItem): number | undefined {
        return item?.ids?.simkl ?? item?.ids?.simkl_id
    }

    private posterUrl(poster: string | undefined): string {
        if (typeof poster !== "string" || !poster) return ""
        if (poster.startsWith("http")) return poster
        return `https://simkl.in/posters/${poster}_m.webp`
    }

    private posterUrlBanner(poster: string | undefined): string {
        if (typeof poster !== "string" || !poster) return ""
        if (poster.startsWith("http")) return poster
        return `https://simkl.in/posters/${poster}_w.jpg`
    }

    private typeOf(item: SimklItem): SimklMediaType {
        const t = String(item?.type ?? item?.endpoint_type ?? "").toLowerCase()
        if (t === "movie" || t === "movies") return "movie"
        if (t === "anime" || t === "animes" || t === "ona") return "anime"
        if (item?.anime_type) return "anime"
        return "tv"
    }

    private detailEndpoint(type: SimklMediaType): string {
        return type === "movie" ? "/movies" : type === "anime" ? "/anime" : "/tv"
    }

    private format(type: SimklMediaType): string {
        return type === "movie" ? "MOVIE" : "TV"
    }

    private airStatus(item: SimklItem): string {
        const s = (item?.status ?? "").toUpperCase()
        if (s === "AIRING") return "RELEASING"
        if (s === "TBA") return "NOT_YET_RELEASED"
        return "FINISHED"
    }

    private num(v: any): number | undefined {
        if (v === null || v === undefined || v === "") return undefined
        const n = Number(v)
        return isNaN(n) ? undefined : n
    }

    private str(v: any): string {
        return v === null || v === undefined ? "" : String(v)
    }

    private strArray(v: any): string[] {
        if (!Array.isArray(v)) return []
        return v.filter((x) => typeof x === "string")
    }

    private bool(v: any): boolean {
        return v === true || String(v).toLowerCase() === "true"
    }

    private meanScore(item: SimklItem): number {
        const r = this.num(item?.ratings?.simkl?.rating)
        return r ? Math.round(r * 10) : 0
    }

    private parseDate(dateStr: string | undefined, year: number): { year: number; month?: number; day?: number } {
        const y = this.num(year) ?? 0
        if (!dateStr) return { year: y }
        const d = new Date(dateStr)
        if (isNaN(d.getTime())) return { year: y }
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
    }

    private siteUrlOf(item: SimklItem, type: SimklMediaType): string {
        if (item?.ids?.slug) {
            const seg = type === "movie" ? "movies" : "shows"
            return `https://simkl.com/${seg}/${this.idOf(item)}/${item.ids.slug}`
        }
        return `https://simkl.com/${this.idOf(item)}`
    }

    private trailerOf(item: SimklItem): $app.AL_BaseAnime_Trailer | undefined {
        const yt = item?.trailers?.[0]?.youtube
        if (!yt) return undefined
        return {
            id: yt,
            site: "youtube",
            thumbnail: `https://img.youtube.com/vi/${yt}/mqdefault.jpg`,
        }
    }

    private parseSimklUrl(url: string): { type: SimklMediaType; simklId: number } | null {
        const m = String(url || "").match(/\/(movies|movie|shows|show|tv|anime)\/(\d+)/i)
        if (!m) return null
        const seg = m[1].toLowerCase()
        let type: SimklMediaType
        if (seg === "movies" || seg === "movie") type = "movie"
        else if (seg === "anime") type = "anime"
        else type = "tv"
        const simklId = Number(m[2])
        if (!simklId) return null
        return { type, simklId }
    }

    private hashCode(str: string): number {
        let h = 0
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) - h + str.charCodeAt(i)) | 0
        }
        return Math.abs(h) || 1
    }

    // ---------------------------------------------------------------- ID scheme
    // movie  -> 1000000000 + simklId
    // tv     -> 2000000000 + simklId * 1000 + seasonNumber
    // anime  -> 3000000000 + simklId * 1000 + seasonNumber

    private encodeId(type: SimklMediaType, simklId: number, season: number): number {
        const id = Number(simklId)
        if (type === "movie") return MOVIE_OFFSET + id
        const s = Math.max(1, Math.min(season || 1, 999))
        const base = type === "anime" ? ANIME_OFFSET : TV_OFFSET
        return base + id * 1000 + s
    }

    private decodeId(id: number): { type: SimklMediaType; simklId: number; season: number } | null {
        const n = Number(id)
        if (!n || isNaN(n)) return null

        if (n >= ANIME_OFFSET) {
            const rest = n - ANIME_OFFSET
            return { type: "anime", simklId: Math.floor(rest / 1000), season: (rest % 1000) || 1 }
        }
        if (n >= TV_OFFSET) {
            const rest = n - TV_OFFSET
            return { type: "tv", simklId: Math.floor(rest / 1000), season: (rest % 1000) || 1 }
        }
        if (n >= MOVIE_OFFSET) {
            return { type: "movie", simklId: n - MOVIE_OFFSET, season: 1 }
        }

        return null
    }

    // ---------------------------------------------------------------- season info

    private seasonCountsFromEpisodes(episodes: SimklEpisode[], type: "tv" | "anime"): Record<number, number> {
        const counts: Record<number, number> = {}
        for (const ep of episodes) {
            if (!ep || ep.type === "special") continue
            const season = type === "anime"
                ? (ep.tvdb?.season ?? ep.season ?? 1)
                : (ep.season ?? 1)
            if (season <= 0) continue
            counts[season] = (counts[season] || 0) + 1
        }
        return counts
    }

    private async seasonInfo(simklId: number, type: "tv" | "anime"): Promise<SimklSeasonInfo | null> {
        const cache = $store.get<Record<string, SimklSeasonInfo>>("simkl.seasons") ?? {}
        const key = `${type}:${simklId}`
        if (cache[key]) return cache[key]

        const path = type === "anime" ? "/anime/episodes/" : "/tv/episodes/"
        const params = type === "anime" ? { extended: "full_anime_seasons" } : { extended: "full" }
        const eps = await this.get<SimklEpisode[]>(`${path}${simklId}`, params)

        if (!eps || !Array.isArray(eps) || eps.length === 0) return null

        const counts = this.seasonCountsFromEpisodes(eps, type)
        if (Object.keys(counts).length === 0) return null

        const info: SimklSeasonInfo = { counts }
        cache[key] = info
        $store.set("simkl.seasons", cache)
        return info
    }

    // ---------------------------------------------------------------- media conversion

    private toALBaseAnime(item: SimklItem, opts: { type: SimklMediaType; season: number; episodeCount: number }): $app.AL_BaseAnime | null {
        const simklId = this.idOf(item)
        if (!simklId) return null

        const baseTitle = this.str(item.title)
        const season = opts.season
        const title = season > 1 ? `${baseTitle} — Season ${season}` : baseTitle
        const type = opts.type
        const isMovie = type === "movie"

        return {
            id: this.encodeId(type, simklId, season),
            siteUrl: this.siteUrlOf(item, type),
            title: {
                userPreferred: title,
                romaji: title,
                english: this.str(item.title_en ?? item.en_title ?? title),
                native: baseTitle,
            },
            coverImage: {
                large: this.posterUrl(item.poster),
                medium: this.posterUrl(item.poster),
                extraLarge: this.posterUrl(item.poster),
                color: "",
            },
            bannerImage: this.posterUrlBanner(item.poster),
            description: this.str(item.overview),
            genres: this.strArray(item.genres),
            meanScore: this.meanScore(item),
            synonyms: this.strArray(item.all_titles),
            status: this.airStatus(item) as $app.AL_MediaStatus,
            episodes: isMovie ? 1 : (this.num(opts.episodeCount) ?? 1),
            type: "ANIME",
            format: this.format(type) as $app.AL_MediaFormat,
            seasonYear: this.num(item.year),
            isAdult: this.bool(item.adult),
            countryOfOrigin: this.str(item.country),
            duration: this.num(item.runtime),
            trailer: this.trailerOf(item),
            startDate: this.parseDate(item.first_aired, this.num(item.year) ?? 0),
            endDate: this.parseDate(item.last_aired, this.num(item.year) ?? 0),
        }
    }

    private pushMedia(media: $app.AL_BaseAnime[], seen: Set<number>, m: $app.AL_BaseAnime | null | undefined): void {
        if (m && !seen.has(m.id)) {
            seen.add(m.id)
            media.push(m)
        }
    }

    private async itemToCards(item: SimklItem, type: SimklMediaType): Promise<$app.AL_BaseAnime[]> {
        if (this.hideAnime && type === "anime") return []
        const simklId = this.idOf(item)
        if (!simklId) return []

        if (type === "movie") {
            const m = this.toALBaseAnime(item, { type, season: 1, episodeCount: 1 })
            return m ? [m] : []
        }

        const info = await this.seasonInfo(simklId, type)
        if (!info) {
            const m = this.toALBaseAnime(item, { type, season: 1, episodeCount: this.episodeCount(item) })
            return m ? [m] : []
        }

        const cards: $app.AL_BaseAnime[] = []
        for (const [seasonStr, count] of Object.entries(info.counts)) {
            const m = this.toALBaseAnime(item, { type, season: Number(seasonStr), episodeCount: count })
            this.pushMedia(cards, new Set(), m)
        }
        return cards
    }

    private async itemsToMedia(items: SimklItem[], forcedType?: SimklMediaType): Promise<$app.AL_BaseAnime[]> {
        const media: $app.AL_BaseAnime[] = []
        const seen = new Set<number>()
        for (const item of items) {
            const type = forcedType ?? this.typeOf(item)
            if (this.hideAnime && type === "anime") continue
            const cards = await this.itemToCards(item, type)
            for (const m of cards) this.pushMedia(media, seen, m)
        }
        return media
    }

    private toIdMap(media: $app.AL_BaseAnime[]): Record<number, $app.AL_BaseAnime> {
        const map: Record<number, $app.AL_BaseAnime> = {}
        for (const m of media) map[m.id] = m
        return map
    }

    private titleOf(id: number): string {
        const mediaCache = $store.get<Record<number, $app.AL_BaseAnime>>("simkl.media") ?? {}
        return mediaCache[id]?.title?.english ?? mediaCache[id]?.title?.native ?? mediaCache[id]?.title?.userPreferred ?? ""
    }

    private episodeCount(item: SimklItem): number {
        const c = this.num(item?.total_episodes ?? item?.ep_count ?? item?.watching_details?.total_episodes)
        return c && c > 0 ? c : 1
    }

    private makeConfigRequiredCard(): $app.AL_BaseAnime {
        const title = "SIMKL API key required"
        const now = new Date()
        return {
            id: 999999002,
            siteUrl: "https://simkl.com/settings/developer/",
            title: {
                userPreferred: title,
                romaji: title,
                english: title,
                native: title,
            },
            coverImage: {
                large: "",
                medium: "",
                extraLarge: "",
                color: "",
            },
            bannerImage: "",
            description: "Add your SIMKL Client ID in this extension's settings.",
            genres: ["SIMKL"],
            meanScore: 0,
            synonyms: [],
            status: "FINISHED",
            episodes: 1,
            type: "ANIME",
            format: "TV",
            seasonYear: now.getUTCFullYear(),
            isAdult: false,
            startDate: {
                year: now.getUTCFullYear(),
                month: now.getUTCMonth() + 1,
                day: now.getUTCDate(),
            },
            endDate: undefined,
        }
    }

    // ---------------------------------------------------------------- detail helpers

    private async getDetail(type: SimklMediaType, simklId: number): Promise<SimklItem | null> {
        const cache = $store.get<Record<string, SimklItem>>("simkl.details") ?? {}
        const key = `${type}:${simklId}`
        if (cache[key]) return cache[key]

        const item = await this.get<SimklItem>(`${this.detailEndpoint(type)}/${simklId}`, { extended: "full" })
        if (!item || !item.ids) return null

        cache[key] = item
        $store.set("simkl.details", cache)
        return item
    }

    private buildRankings(item: SimklItem, type: SimklMediaType): $app.AL_AnimeDetailsById_Media_Rankings[] {
        const rank = this.num(item.rank)
        if (!rank) return []
        return [{
            allTime: true,
            context: "SIMKL",
            format: this.format(type) as $app.AL_MediaFormat,
            rank: rank,
            type: "RATED",
            year: this.num(item.year),
        }]
    }

    private buildStudios(item: SimklItem, type: SimklMediaType): $app.AL_AnimeDetailsById_Media_Studios | undefined {
        const names: string[] = []
        if (type === "anime") {
            for (const s of item.studios ?? []) if (s?.name) names.push(s.name)
        } else if (type === "tv") {
            if (item.network) names.push(item.network)
        } else {
            if (item.director) names.push(item.director)
        }
        if (names.length === 0) return undefined
        return { nodes: names.map((name, i) => ({ id: 100000 + i, name })) }
    }

    private relationTypeOf(rel: SimklRelation, type: SimklMediaType): $app.AL_MediaRelation {
        const r = String(rel?.type ?? "").toLowerCase()
        if (r.includes("prequel")) return "PREQUEL"
        if (r.includes("sequel")) return "SEQUEL"
        if (r.includes("side") || r.includes("spin")) return "SIDE_STORY"
        if (r.includes("manga") || r.includes("novel") || r.includes("source") || r.includes("book")) return "SOURCE"
        if (r.includes("alternative") || r.includes("reboot") || r.includes("version")) return "ALTERNATIVE"
        if (r.includes("compilation") || r.includes("recap")) return "COMPILATION"
        if (r.includes("summary")) return "SUMMARY"
        if (r.includes("parent")) return "PARENT"
        if (r.includes("character")) return "CHARACTER"
        return "OTHER"
    }

    private relationToBase(rel: SimklRelation): $app.AL_BaseAnime | null {
        const parsed = rel?.url ? this.parseSimklUrl(rel.url) : null
        if (!parsed) return null
        const title = this.str(rel.title)
        const cover = this.posterUrl(rel.poster)
        return {
            id: this.encodeId(parsed.type, parsed.simklId, 1),
            siteUrl: rel.url,
            title: {
                userPreferred: title,
                romaji: title,
                english: title,
                native: title,
            },
            coverImage: {
                large: cover,
                medium: cover,
                extraLarge: cover,
                color: "",
            },
            bannerImage: "",
            description: "",
            genres: [],
            meanScore: 0,
            synonyms: [],
            status: "FINISHED",
            episodes: parsed.type === "movie" ? 1 : undefined,
            type: "ANIME",
            format: this.format(parsed.type) as $app.AL_MediaFormat,
            seasonYear: this.num(rel.year),
            isAdult: false,
            startDate: { year: this.num(rel.year) ?? 0 },
            endDate: undefined,
        }
    }

    private async buildRelations(item: SimklItem, type: SimklMediaType): Promise<$app.AL_AnimeDetailsById_Media_Relations | undefined> {
        const rels = type === "anime" ? (item.relations ?? []) : (item.users_recommendations ?? [])
        if (rels.length === 0) return undefined
        const edges: $app.AL_AnimeDetailsById_Media_Relations_Edges[] = []
        for (const rel of rels.slice(0, 12)) {
            const node = this.relationToBase(rel)
            if (node) edges.push({ node, relationType: this.relationTypeOf(rel, type) })
        }
        if (edges.length === 0) return undefined
        return { edges }
    }

    private async buildRecommendations(item: SimklItem, type: SimklMediaType): Promise<$app.AL_AnimeDetailsById_Media_Recommendations | undefined> {
        const recs = item.users_recommendations ?? []
        if (recs.length === 0) return undefined
        const edges: $app.AL_AnimeDetailsById_Media_Recommendations_Edges[] = []
        for (const rec of recs.slice(0, 10)) {
            const parsed = rec?.url ? this.parseSimklUrl(rec.url) : null
            if (!parsed) continue
            const recId = this.encodeId(parsed.type, parsed.simklId, 1)
            const cover = this.posterUrl(rec.poster)
            edges.push({
                node: {
                    mediaRecommendation: {
                        id: recId,
                        siteUrl: rec.url,
                        title: {
                            userPreferred: this.str(rec.title),
                            romaji: this.str(rec.title),
                            english: this.str(rec.title),
                            native: this.str(rec.title),
                        },
                        coverImage: {
                            large: cover,
                            medium: cover,
                            extraLarge: cover,
                            color: "",
                        },
                        format: this.format(parsed.type) as $app.AL_MediaFormat,
                        startDate: { year: this.num(rec.year) ?? 0 },
                        isAdult: false,
                        meanScore: 0,
                        status: "FINISHED",
                        type: "ANIME",
                    },
                },
            })
        }
        if (edges.length === 0) return undefined
        return { edges }
    }

    private parsePeople(data: any): $app.AL_AnimeDetailsById_Media_Characters_Edges[] | undefined {
        if (!data) return undefined
        let list: any[] = []
        if (Array.isArray(data)) {
            list = data
        } else if (Array.isArray(data.cast)) {
            list = data.cast
        } else if (Array.isArray(data.people)) {
            list = data.people
        } else if (Array.isArray(data.characters)) {
            list = data.characters
        }
        if (list.length === 0) return undefined

        const edges: $app.AL_AnimeDetailsById_Media_Characters_Edges[] = []
        for (const entry of list) {
            const actor = entry?.actor ?? entry
            const character = entry?.character ?? entry
            const img = actor?.image?.large ?? actor?.image ?? actor?.poster ?? character?.image?.large ?? character?.image
            const name = actor?.name ?? character?.name
            if (!img || !name) continue
            const id = this.hashCode(String(name) + String(img))
            edges.push({
                id,
                name: String(name),
                node: {
                    id,
                    isFavourite: false,
                    name: { full: String(name), native: String(name) },
                    image: { large: String(img) },
                },
                role: "SUPPORTING",
            })
        }
        return edges.length > 0 ? edges : undefined
    }

    private async getCharacters(simklId: number, type: SimklMediaType): Promise<$app.AL_AnimeDetailsById_Media_Characters | undefined> {
        const people = await this.get<any>(`${this.detailEndpoint(type)}/${simklId}/people`, {}, false)
        const parsed = this.parsePeople(people)
        if (parsed) return { edges: parsed }

        // Fallback: scrape the site's cast page (guest-gated; may fail, then we omit characters)
        try {
            const base = type === "movie" ? "movies" : "shows"
            const res = await fetch(`https://simkl.com/${base}/${simklId}/cast/`)
            if (!res.ok) return undefined
            const $ = LoadDoc(String(res.text()))
            const edges: $app.AL_AnimeDetailsById_Media_Characters_Edges[] = []
            $("[class*='cast'] [class*='item'], [class*='cast-list'] [class*='item'], [class*='person']").each((_, el) => {
                const name = el.find("a[href*='/actor/']").first().text().trim() || el.find("[class*='name']").first().text().trim()
                const img = el.find("img").first().attr("src")
                if (!name || !img) return
                const id = this.hashCode(name + img)
                edges.push({
                    id,
                    name,
                    node: {
                        id,
                        isFavourite: false,
                        name: { full: name, native: name },
                        image: { large: img },
                    },
                    role: "SUPPORTING",
                })
            })
            return edges.length > 0 ? { edges } : undefined
        } catch {
            return undefined
        }
    }

    // ---------------------------------------------------------------- metadata builders

    private buildSeasonMetadata(episodes: SimklEpisode[], type: "tv" | "anime", season: number, title: string): $app.Metadata_AnimeMetadata {
        const out: Record<string, $app.Metadata_EpisodeMetadata> = {}
        let rel = 0

        for (const ep of episodes) {
            if (!ep || ep.type === "special") continue
            const s = type === "anime"
                ? (ep.tvdb?.season ?? ep.season ?? 1)
                : (ep.season ?? 1)
            if (s !== season) continue

            rel++
            const image = ep.img ? `https://simkl.in/episodes/${ep.img}_w.jpg` : ""
            out[String(rel)] = {
                anidbId: 0,
                tvdbId: 0,
                anidbEid: 0,
                title: this.str(ep.title) || `Episode ${rel}`,
                image: image,
                airDate: ep.date ? new Date(ep.date).toISOString().split("T")[0] : "",
                length: this.num(ep.runtime) ?? 0,
                summary: ep.description ?? "",
                overview: ep.description ?? "",
                episodeNumber: rel,
                episode: String(rel),
                seasonNumber: season,
                absoluteEpisodeNumber: rel,
                hasImage: !!ep.img,
            }
        }

        const ordered: Record<string, $app.Metadata_EpisodeMetadata> = {}
        const keys = Object.keys(out).map(Number).sort((a, b) => a - b)
        for (const k of keys) ordered[k.toString()] = out[k.toString()]

        return {
            titles: { en: title },
            episodes: ordered,
            episodeCount: keys.length,
            specialCount: 0,
        }
    }

    private buildMovieMetadata(movie: SimklItem): $app.Metadata_AnimeMetadata {
        const title = this.str(movie.title) || "Movie"
        const overview = this.str(movie.overview)
        const airDate = movie.first_aired ? new Date(movie.first_aired).toISOString().split("T")[0] : ""
        const ep: $app.Metadata_EpisodeMetadata = {
            anidbId: 0,
            tvdbId: 0,
            anidbEid: 0,
            title: title,
            image: this.posterUrl(movie.poster),
            airDate: airDate,
            length: this.num(movie.runtime) ?? 90,
            summary: overview,
            overview: overview,
            episodeNumber: 1,
            episode: "1",
            seasonNumber: 1,
            absoluteEpisodeNumber: 1,
            hasImage: !!movie.poster,
        }
        return {
            titles: { en: title },
            episodes: { "1": ep },
            episodeCount: 1,
            specialCount: 0,
        }
    }

    // ---------------------------------------------------------------- CustomSource

    async getAnime(ids: number[]): Promise<$app.AL_BaseAnime[]> {
        const ret: $app.AL_BaseAnime[] = []
        const unique = Array.from(new Set(ids.filter((x) => x > 0)))
        if (unique.length === 0) return ret

        const mediaCache = $store.get<Record<number, $app.AL_BaseAnime>>("simkl.media") ?? {}

        const promises = unique.map(async (id) => {
            const decoded = this.decodeId(id)
            if (!decoded) return null
            if (this.hideAnime && decoded.type === "anime") return null

            const cached = mediaCache[id]

            // Detail-fetch first (cached in simkl.details) so cards carry trailer/dates; fall back to cache on failure
            const item = await this.getDetail(decoded.type, decoded.simklId)
            if (item && item.ids) {
                let epCount = this.episodeCount(item)
                if (decoded.type !== "movie") {
                    const info = await this.seasonInfo(decoded.simklId, decoded.type)
                    epCount = info?.counts?.[decoded.season] ?? epCount
                }

                const base = this.toALBaseAnime(item, {
                    type: decoded.type,
                    season: decoded.season,
                    episodeCount: decoded.type === "movie" ? 1 : epCount,
                })
                if (base) {
                    mediaCache[id] = base
                    return base
                }
            }

            return cached ?? null
        })

        const results = await Promise.all(promises)
        for (const r of results) {
            if (r) ret.push(r)
        }
        if (Object.keys(mediaCache).length > 0) {
            $store.set("simkl.media", mediaCache)
        }
        return ret
    }

    async getAnimeDetails(id: number): Promise<$app.AL_AnimeDetailsById_Media | null> {
        const decoded = this.decodeId(id)
        if (!decoded) return null
        if (this.hideAnime && decoded.type === "anime") return null

        const item = await this.getDetail(decoded.type, decoded.simklId)
        if (!item || !item.ids) return null

        const score = this.meanScore(item)
        const relations = await this.buildRelations(item, decoded.type)
        const recommendations = await this.buildRecommendations(item, decoded.type)

        const details: $app.AL_AnimeDetailsById_Media = {
            id: id,
            siteUrl: this.siteUrlOf(item, decoded.type),
            description: item.overview ?? "",
            genres: item.genres ?? [],
            meanScore: score,
            averageScore: score,
            popularity: item.ratings?.simkl?.votes,
            duration: item.runtime,
            startDate: this.parseDate(item.first_aired, item.year ?? 0),
            endDate: this.parseDate(item.last_aired, item.year ?? 0),
            trailer: this.trailerOf(item),
            rankings: this.buildRankings(item, decoded.type),
            studios: this.buildStudios(item, decoded.type),
            relations: relations ?? { edges: [] },
            recommendations: recommendations ?? { edges: [] },
        }

        const characters = await this.getCharacters(decoded.simklId, decoded.type)
        if (characters) details.characters = characters

        return details
    }

    async getAnimeMetadata(id: number): Promise<$app.Metadata_AnimeMetadata | null> {
        const metadataCache = $store.get<Record<number, $app.Metadata_AnimeMetadata>>("simkl.metadata") ?? {}
        const cached = metadataCache[id]
        if (cached) return cached

        const decoded = this.decodeId(id)
        if (!decoded) return null
        if (this.hideAnime && decoded.type === "anime") return null

        const title = this.titleOf(id)

        if (decoded.type === "movie") {
            const movie = await this.get<SimklItem>(`${this.detailEndpoint("movie")}/${decoded.simklId}`, { extended: "full" })
            if (movie && movie.ids) {
                const metadata = this.buildMovieMetadata(movie)
                metadataCache[id] = metadata
                $store.set("simkl.metadata", metadataCache)
                return metadata
            }
            return null
        }

        const path = decoded.type === "anime" ? "/anime/episodes/" : "/tv/episodes/"
        const params = decoded.type === "anime" ? { extended: "full_anime_seasons" } : { extended: "full" }
        const eps = await this.get<SimklEpisode[]>(`${path}${decoded.simklId}`, params)

        if (eps && Array.isArray(eps) && eps.length > 0) {
            const metadata = this.buildSeasonMetadata(eps, decoded.type, decoded.season, title)
            if (metadata.episodeCount > 0) {
                metadataCache[id] = metadata
                $store.set("simkl.metadata", metadataCache)
                return metadata
            }
        }

        return null
    }

    async getAnimeWithRelations(id: number): Promise<$app.AL_CompleteAnime> {
        const decoded = this.decodeId(id)
        if (!decoded) throw new Error("not found.")
        if (this.hideAnime && decoded.type === "anime") throw new Error("not found.")

        const item = await this.getDetail(decoded.type, decoded.simklId)
        if (!item || !item.ids) throw new Error("not found.")

        let epCount = this.episodeCount(item)
        if (decoded.type !== "movie") {
            const info = await this.seasonInfo(decoded.simklId, decoded.type)
            epCount = info?.counts?.[decoded.season] ?? epCount
        }

        const base = this.toALBaseAnime(item, {
            type: decoded.type,
            season: decoded.season,
            episodeCount: decoded.type === "movie" ? 1 : epCount,
        })
        if (!base) throw new Error("not found.")

        const relations = await this.buildRelations(item, decoded.type)

        const mediaCache = $store.get<Record<number, $app.AL_BaseAnime>>("simkl.media") ?? {}
        mediaCache[id] = base
        $store.set("simkl.media", mediaCache)

        return {
            ...base,
            relations: relations ?? { edges: [] },
        } as $app.AL_CompleteAnime
    }

    async listAnime(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseAnime>> {
        if (!this.hasClientId()) {
            const media = [this.makeConfigRequiredCard()]
            return { media: media, total: media.length, page: 1, totalPages: 1 }
        }

        // Prefer the user's SIMKL watchlist when an access token is configured and no search is active
        if (this.accessToken && search.trim() === "") {
            const wl = await this.get<SimklWatchlist>("/sync/all-items/", { extended: "full" }, true)
            if (wl) {
                const media: $app.AL_BaseAnime[] = []
                const seen = new Set<number>()

                for (const entry of wl.movies ?? []) {
                    const item = entry?.movie ?? entry?.show
                    if (!item) continue
                    const m = this.toALBaseAnime(item, { type: "movie", season: 1, episodeCount: 1 })
                    this.pushMedia(media, seen, m)
                }

                for (const entry of wl.shows ?? []) {
                    const item = entry?.show
                    if (!item) continue
                    const simklId = this.idOf(item)
                    if (!simklId) continue
                    if (this.hideAnime && this.typeOf(item) === "anime") continue

                    const seasons = entry?.seasons ?? []
                    if (seasons.length > 0) {
                        for (const s of seasons) {
                            const seasonNum = Number(s?.number)
                            if (!seasonNum || seasonNum <= 0) continue
                            const count = s?.episodes?.length || this.episodeCount(item)
                            const m = this.toALBaseAnime(item, { type: "tv", season: seasonNum, episodeCount: count })
                            this.pushMedia(media, seen, m)
                        }
                    } else {
                        const cards = await this.itemToCards(item, "tv")
                        for (const m of cards) this.pushMedia(media, seen, m)
                    }
                }

                if (!this.hideAnime) {
                    for (const entry of wl.anime ?? []) {
                        const item = entry?.show
                        if (!item) continue
                        const cards = await this.itemToCards(item, "anime")
                        for (const m of cards) this.pushMedia(media, seen, m)
                    }
                }

                $store.set("simkl.media", this.toIdMap(media))
                return { media: media, total: media.length, page: 1, totalPages: 1 }
            }
        }

        // Fallback: trending (anime unless hidden, else tv + movies)
        if (search.trim() === "") {
            const media = this.hideAnime
                ? await (async () => {
                    const [tv, movies] = await Promise.all([
                        this.get<SimklItem[]>("/tv/trending/", { extended: "overview,metadata,tmdb,genres,trailer" }),
                        this.get<SimklItem[]>("/movies/trending/", { extended: "overview,metadata,tmdb,genres,trailer" }),
                    ])
                    return this.itemsToMedia([...(tv ?? []), ...(movies ?? [])])
                })()
                : await this.itemsToMedia((await this.get<SimklItem[]>("/anime/trending/", { extended: "overview,metadata,tmdb,genres,trailer" })) ?? [], "anime")
            $store.set("simkl.media", this.toIdMap(media))
            return { media: media, total: media.length, page: 1, totalPages: 1 }
        }

        // Search across anime (unless hidden), tv and movie
        const types = this.hideAnime ? ["tv", "movie"] : ["anime", "tv", "movie"]
        const queries: Promise<SimklItem[] | null>[] = types.map((t) =>
            this.get<SimklItem[]>(`/search/${t}`, {
                q: search,
                page: String(page),
                limit: String(perPage),
                extended: "full",
            }),
        )
        const results = await Promise.all(queries)
        const items = results
            .filter((r): r is SimklItem[] => Array.isArray(r) && r.length > 0)
            .reduce((acc: SimklItem[], r) => acc.concat(r), [] as SimklItem[])
        const media = await this.itemsToMedia(items)
        $store.set("simkl.media", this.toIdMap(media))
        return {
            media: media,
            total: media.length,
            page: page,
            totalPages: Math.max(1, Math.ceil(media.length / perPage)),
        }
    }

    async getManga(ids: number[]): Promise<$app.AL_BaseManga[]> {
        return Promise.resolve([])
    }

    async getMangaDetails(id: number): Promise<$app.AL_MangaDetailsById_Media | null> {
        return null
    }

    async listManga(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseManga>> {
        return { media: [], total: 0, page: 1, totalPages: 1 }
    }
}
