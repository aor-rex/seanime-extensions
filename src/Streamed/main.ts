/// <reference path="../custom-source.d.ts" />
/// <reference path="../app.d.ts" />
/// <reference path="../core.d.ts" />

// Streamed (Sports) - Custom Source
// Presents Streamed's live/upcoming sports matches as browseable "anime" media
// so they can be watched through the Streamed online-stream provider.

const API_BASES = [
    "https://streamed.pk",
    "https://streamed.st",
]

type StreamedMatch = {
    id: string
    title: string
    category: string
    date: number // unix ms
    poster?: string
    popular: boolean
    teams?: {
        home?: { name?: string; badge?: string }
        away?: { name?: string; badge?: string }
    }
    sources?: { source: string; id: string }[]
}

type StreamedSport = {
    id: string
    name: string
}

const ID_MAX = 2 ** 31 - 1

function hashCode(str: string): number {
    let h = 0
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0
    }
    return Math.abs(h) || 1
}

// generate a stable pseudo-AniList id for a match (keep within int32)
function matchId(match: StreamedMatch): number {
    return hashCode(match.id) % ID_MAX
}

class Provider implements CustomSource {
    private base = API_BASES[0]

    getSettings(): Settings {
        return {
            supportsAnime: true,
            supportsManga: false,
        }
    }

    // ---------------------------------------------------------------- helpers

    private async _api<T>(path: string): Promise<T | null> {
        for (const base of API_BASES) {
            try {
                const res = await fetch(`${base}${path}`, {
                    headers: { "User-Agent": "Seanime/1.0" },
                })
                if (res.ok) {
                    this.base = base
                    return (await res.json()) as T
                }
            } catch (err) {
                // try next host
            }
        }
        return null
    }

    private _abs(url?: string): string | undefined {
        if (!url) return undefined
        if (url.startsWith("http")) return url
        return `${this.base}${url}`
    }

    // fetch the match within a given list by id
    private async _findMatch(id: string): Promise<StreamedMatch | null> {
        const lists = [
            await this._api<StreamedMatch[]>("/api/matches/live"),
            await this._api<StreamedMatch[]>("/api/matches/all-today"),
            await this._api<StreamedMatch[]>("/api/matches/all/popular"),
        ]
        for (const list of lists) {
            if (!list) continue
            const found = list.find((m) => m && m.id === id)
            if (found) return found
        }
        return null
    }

    private _toBaseAnime(match: StreamedMatch): $app.AL_BaseAnime {
        const id = matchId(match)
        const title = match.teams?.home?.name && match.teams?.away?.name
            ? `${match.teams.home.name} vs ${match.teams.away.name}`
            : match.title

        const startDate = new Date(match.date)
        const genre = (match.category || "sports").split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")

        const media: $app.AL_BaseAnime = {
            id: id,
            status: match.date > Date.now() ? "NOT_YET_RELEASED" : "RELEASING",
            format: "MOVIE",
            type: "ANIME",
            title: {
                english: title,
                romaji: title,
            },
            synonyms: [match.id, title],
            description: `${title}\n\nUses the Streamed embedded player. Streams are live and availability varies by broadcast.`,
            coverImage: {
                extraLarge: this._abs(match.poster),
                large: this._abs(match.poster),
                medium: this._abs(match.poster),
            },
            episodes: 1,
            duration: 0,
            season: "WINTER",
            seasonYear: startDate.getFullYear(),
            startDate: {
                year: startDate.getFullYear(),
                month: startDate.getMonth() + 1,
                day: startDate.getDate(),
            },
            genres: [genre],
            countryOfOrigin: "US",
            meanScore: 0,
            isAdult: false,
            siteUrl: `${this.base}/match/${match.id}`,
        }
        return media
    }

    private _toMetadata(match: StreamedMatch): $app.Metadata_AnimeMetadata {
        const title = match.teams?.home?.name && match.teams?.away?.name
            ? `${match.teams.home.name} vs ${match.teams.away.name}`
            : match.title

        const ep: $app.Metadata_EpisodeMetadata = {
            anidbId: 0,
            tvdbId: matchId(match),
            title: title,
            image: this._abs(match.poster) ?? "",
            airDate: new Date(match.date).toISOString().split("T")[0],
            length: 0,
            summary: title,
            overview: title,
            episodeNumber: 1,
            episode: "1",
            seasonNumber: 1,
            absoluteEpisodeNumber: 1,
            anidbEid: 0,
            hasImage: !!match.poster,
        }

        return {
            titles: { en: title },
            episodes: { "1": ep },
            episodeCount: 1,
            specialCount: 0,
        }
    }

    private async _listMatches(search: string): Promise<StreamedMatch[]> {
        const [live, today, popular] = await Promise.all([
            this._api<StreamedMatch[]>("/api/matches/live"),
            this._api<StreamedMatch[]>("/api/matches/all-today"),
            this._api<StreamedMatch[]>("/api/matches/all/popular"),
        ])

        const seen: Record<string, boolean> = {}
        const matches: StreamedMatch[] = []
        const push = (m?: StreamedMatch) => {
            if (!m || !m.id) return
            if (seen[m.id]) return
            seen[m.id] = true
            matches.push(m)
        }

        for (const list of [live, today, popular]) {
            if (Array.isArray(list)) list.forEach(push)
        }

        if (search && search.trim().length > 0) {
            const q = search.trim().toLowerCase()
            return matches.filter((m) => m.title.toLowerCase().includes(q))
        }

        // sort: live first, then by date
        matches.sort((a, b) => {
            const aLive = a.date <= Date.now() ? 0 : 1
            const bLive = b.date <= Date.now() ? 0 : 1
            if (aLive !== bLive) return aLive - bLive
            return a.date - b.date
        })

        return matches
    }

    // ---------------------------------------------------------------- CustomSource

    async listAnime(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseAnime>> {
        const currentPage = page && page > 0 ? page : 1
        const limit = Math.max(1, Math.min(perPage || 20, 20))

        const matches = await this._listMatches(search)
        const start = (currentPage - 1) * limit
        const slice = matches.slice(start, start + limit)

        const media = slice.map((m) => this._toBaseAnime(m))

        return {
            media,
            page: currentPage,
            totalPages: Math.max(1, Math.ceil(matches.length / limit)),
            total: matches.length,
        }
    }

    async getAnime(ids: number[]): Promise<$app.AL_BaseAnime[]> {
        const unique = Array.from(new Set(ids.filter((x) => x > 0)))
        if (unique.length === 0) return []

        const matches = await this._listMatches("")
        const ret: $app.AL_BaseAnime[] = []
        for (const m of matches) {
            if (unique.includes(matchId(m))) {
                ret.push(this._toBaseAnime(m))
            }
            if (ret.length === unique.length) break
        }
        return ret
    }

    async getAnimeMetadata(id: number): Promise<$app.Metadata_AnimeMetadata | null> {
        const matches = await this._listMatches("")
        const match = matches.find((m) => matchId(m) === id)
        if (!match) return null
        return this._toMetadata(match)
    }

    async getAnimeDetails(id: number): Promise<$app.AL_AnimeDetailsById_Media | null> {
        const matches = await this._listMatches("")
        const match = matches.find((m) => matchId(m) === id)
        if (!match) return null

        const base = this._toBaseAnime(match)
        const genre = (match.category || "sports").split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")

        return {
            ...base,
            meanScore: 0,
            popularity: 0,
            averageScore: 0,
            genres: [genre],
            studios: [],
            isAdult: false,
            relations: { edges: [] },
            recommendations: { edges: [] },
            startDate: base.startDate,
            endDate: base.startDate,
        } as $app.AL_AnimeDetailsById_Media
    }

    async getAnimeWithRelations(id: number): Promise<$app.AL_CompleteAnime> {
        const matches = await this._listMatches("")
        const match = matches.find((m) => matchId(m) === id)
        if (!match) throw new Error("Match not found.")

        const base = this._toBaseAnime(match)
        return {
            ...base,
            relations: { edges: [] },
        } as $app.AL_CompleteAnime
    }

    // ---------------------------------------------------------------- Manga (unsupported)

    async getManga(ids: number[]): Promise<$app.AL_BaseManga[]> {
        return []
    }

    async getMangaDetails(id: number): Promise<$app.AL_MangaDetailsById_Media | null> {
        return null
    }

    async listManga(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseManga>> {
        return {
            media: [],
            total: 0,
            page: 1,
            totalPages: 1,
        }
    }
}

export = new Provider() as CustomSource