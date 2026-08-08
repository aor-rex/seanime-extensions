/// <reference path="../custom-source.d.ts" />
/// <reference path="../core.d.ts" />

// TMDB custom source (ported from eepyboba's community source), reworked so
// that each TV season is its own media entry with relative episode numbering.
//
// ID scheme:
//   movie -> 1000000000 + tmdbId
//   tv    -> 2000000000 + tmdbId * 1000 + seasonNumber
//
// Per-season entries make metadata episodes relative (1..N) within the
// season, so per-episode torrent search and streaming work with providers
// that build queries like "S02E05".

// Bump to invalidate cached media (e.g. when status computation changes).
const MEDIA_CACHE_VERSION = 3

function errMsg(e: any): string {
    return e instanceof Error ? e.message : String(e)
}

class Provider implements CustomSource {
    api_key = "{{api-key}}"

    language = "en-US"
    include_adult = "false"

    getSettings(): Settings {
        return {
            supportsAnime: true,
            supportsManga: false,
        }
    }

    // ---------------------------------------------------------------- CustomSource

    async getAnime(ids: number[]): Promise<$app.AL_BaseAnime[]> {
        const ret: $app.AL_BaseAnime[] = []
        const mediaCache = this._getMediaCache()

        for (const id of ids) {
            const cached = mediaCache[id]

            if (cached?.media) {
                ret.push(cached.media)
                continue
            }

            const decoded = this._decodeId(id)
            if (!decoded) continue

            if (decoded.mediaType === "movie") {
                const details = await this._getDetails("movie", decoded.tmdbId)
                if (!details) continue
                const stored = this._movieDetailsToStoredMedia(details)
                mediaCache[stored.media.id] = stored
                ret.push(stored.media)
                continue
            }

            const details = await this._getDetails("tv", decoded.tmdbId)
            if (!details) continue

            const season = this._detailsToSeasonCards(details)
                .find(s => s.season === decoded.season)

            if (season) {
                mediaCache[season.media.id] = season
                ret.push(season.media)
            }
        }

        this._setMediaCache(mediaCache)

        return ret
    }

    async getAnimeDetails(id: number): Promise<$app.AL_AnimeDetailsById_Media | null> {
        return null
    }

    async getAnimeMetadata(id: number): Promise<$app.Metadata_AnimeMetadata | null> {
        const mediaCache = this._getMediaCache()
        const cached = mediaCache[id]

        // Only trust cached metadata that was genuinely built (per-episode
        // overviews/stills for TV, or real movie metadata). The eager fallback
        // metadata from listing is never valid to return here because it only
        // contains a single placeholder episode.
        if (cached?.metadata && cached.realMetadata) {
            return cached.metadata
        }

        const decoded = cached
            ? { mediaType: cached.mediaType, tmdbId: cached.tmdbId, season: cached.season }
            : this._decodeId(id)

        if (!decoded) {
            return null
        }

        let metadata: $app.Metadata_AnimeMetadata | null = null
        let builtReal = false

        try {
            if (decoded.mediaType === "movie") {
                const details = await this._getDetails("movie", decoded.tmdbId)
                if (details) {
                    metadata = this._movieDetailsToMetadata(details)
                    builtReal = true
                }
            } else {
                metadata = await this._tvSeasonToMetadata(decoded.tmdbId, decoded.season)
                if (metadata) {
                    builtReal = true
                }
            }
        } catch (e) {
            console.error("TMDB: metadata build failed: " + errMsg(e))
        }

        // Last resort: if the real metadata could not be built, use the media
        // card's fallback so the episode list still has something to show.
        if (!metadata && cached?.media) {
            metadata = this._fallbackMetadata(cached.media, cached.mediaType, cached.media)
        }

        if (!metadata) {
            return null
        }

        const stored = cached || null
        if (stored) {
            stored.metadata = metadata
            stored.realMetadata = builtReal
            mediaCache[stored.media.id] = stored
            this._setMediaCache(mediaCache)
        }

        return metadata
    }

    async getAnimeWithRelations(id: number): Promise<$app.AL_CompleteAnime> {
        const mediaCache = this._getMediaCache()
        let cached = mediaCache[id]

        if (!cached) {
            const media = await this.getAnime([id])
            if (!media || media.length === 0) {
                throw new Error("not found.")
            }

            cached = this._getMediaCache()[id]
        }

        if (!cached?.media) {
            throw new Error("not found.")
        }

        return {
            ...(cached.media as any),
            relations: { edges: [] },
        } as $app.AL_CompleteAnime
    }

    async listAnime(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseAnime>> {
        const query = String(search || "").trim()
        const currentPage = page && page > 0 ? page : 1
        const limit = Math.max(1, Math.min(perPage || 20, 20))

        if (!this._hasApiKey()) {
            const media = [this._makeConfigRequiredCard()]
            return {
                media,
                total: media.length,
                page: 1,
                totalPages: 1,
            }
        }

        let response: TMDBListResponse<TMDBSearchItem> | null = null

        if (query.length > 0) {
            response = await this._tmdbGet<TMDBListResponse<TMDBSearchItem>>("/search/multi", {
                query,
                page: String(currentPage),
                include_adult: this._includeAdult() ? "true" : "false",
            })
        } else {
            response = await this._tmdbGet<TMDBListResponse<TMDBSearchItem>>("/trending/all/day", {
                page: String(currentPage),
            })
        }

        const results = (response?.results || [])
            .filter(item => item && (item.media_type === "movie" || item.media_type === "tv"))
            .slice(0, limit)

        const mediaCache = this._getMediaCache()
        const media: $app.AL_BaseAnime[] = []

        // TV results need a details fetch to know their seasons; resolve in parallel.
        const jobs = results.map(async (item) => {
            return (await this._searchItemToStoredMedia(item)) || []
        })

        const allStored = await Promise.all(jobs)

        for (const stored of allStored) {
            for (const s of stored) {
                mediaCache[s.media.id] = s
                media.push(s.media)
            }
        }

        this._setMediaCache(mediaCache)

        return {
            media,
            total: response?.total_results || media.length,
            page: currentPage,
            totalPages: response?.total_pages || Math.max(1, Math.ceil(media.length / limit)),
        }
    }

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

    // ---------------------------------------------------------------- TMDB helpers

    private async _getDetails(mediaType: TMDBMediaType, tmdbId: number): Promise<TMDBDetails | null> {
        if (!this._hasApiKey()) return null

        const path = mediaType === "movie"
            ? `/movie/${tmdbId}`
            : `/tv/${tmdbId}`

        return await this._tmdbGet<TMDBDetails>(path, {
            append_to_response: "videos,external_ids",
        })
    }

    private async _tmdbGet<T>(path: string, params?: Record<string, string>): Promise<T | null> {
        const key = this._apiKey()
        if (!key) return null

        const query: Record<string, string> = {
            api_key: key,
            language: this._language(),
            ...(params || {}),
        }

        const parts: string[] = []

        for (const k of Object.keys(query)) {
            const value = query[k]
            if (value === undefined || value === null || value === "") continue
            parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`)
        }

        const url = `https://api.themoviedb.org/3${path}?${parts.join("&")}`

        try {
            const res = await fetch(url, {
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
            })

            if (!res.ok) {
                console.error("TMDB error:", res.status, url)
                return null
            }

            return await res.json()
        } catch (err) {
            console.error("TMDB fetch failed:", err)
            return null
        }
    }

    // Turns a search result into stored media. Movies produce one entry; TV
    // shows produce one entry per season.
    private async _searchItemToStoredMedia(item: TMDBSearchItem): Promise<StoredTMDBMedia[] | null> {
        const mediaType = item.media_type

        if (mediaType !== "movie" && mediaType !== "tv") {
            return null
        }

        const tmdbId = Number(item.id)
        if (!tmdbId) return null

        if (mediaType === "movie") {
            const stored = this._searchMovieToStoredMedia(item)
            return stored ? [stored] : null
        }

        const details = await this._getDetails("tv", tmdbId)
        if (!details) return null

        return this._detailsToSeasonCards(details)
    }

    private _searchMovieToStoredMedia(item: TMDBSearchItem): StoredTMDBMedia | null {
        const tmdbId = Number(item.id)
        if (!tmdbId) return null

        const title = this._titleFromItem(item)
        const originalTitle = this._originalTitleFromItem(item)
        const date = this._parseDate(item.release_date)
        const poster = this._poster(item.poster_path)
        const backdrop = this._backdrop(item.backdrop_path) || poster

        const media: $app.AL_BaseAnime = {
            id: this._encodeId("movie", tmdbId),
            siteUrl: this._siteUrl("movie", tmdbId),
            title: {
                userPreferred: title,
                romaji: title,
                english: title,
                native: originalTitle || title,
            },
            coverImage: {
                large: poster,
                medium: poster,
                extraLarge: poster,
                color: "",
            },
            bannerImage: backdrop,
            description: item.overview || "",
            genres: ["Movie", "TMDB"],
            meanScore: item.vote_average ? Math.round(item.vote_average * 10) : 0,
            synonyms: originalTitle && originalTitle !== title ? [originalTitle] : [],
            status: this._toStatus(undefined, item.release_date),
            episodes: 1,
            type: "ANIME",
            format: "MOVIE",
            seasonYear: date?.year || new Date().getUTCFullYear(),
            isAdult: !!item.adult,
            startDate: date || {
                year: new Date().getUTCFullYear(),
            },
            endDate: date || undefined,
        }

        return {
            tmdbId,
            mediaType: "movie",
            season: 0,
            media,
        }
    }

    private _detailsToSeasonCards(details: TMDBDetails): StoredTMDBMedia[] {
        const tmdbId = Number(details.id)
        const title = details.name || details.original_name || "TV Show"
        const originalTitle = details.original_name || title

        const seasons = Array.isArray(details.seasons)
            ? details.seasons
                .filter(s => Number(s.season_number) > 0)
                .sort((a, b) => Number(a.season_number) - Number(b.season_number))
            : []

        if (seasons.length === 0) {
            const seasonNumber = 1
            const media = this._tvSeasonMedia(details, title, originalTitle, seasonNumber, 1, details.first_air_date)
            return [{
                tmdbId,
                mediaType: "tv",
                season: seasonNumber,
                media,
            }]
        }

        const cards: StoredTMDBMedia[] = []

        for (const season of seasons) {
            const seasonNumber = Number(season.season_number)
            const episodeCount = Number(season.episode_count) || 1
            const media = this._tvSeasonMedia(details, title, originalTitle, seasonNumber, episodeCount, season.air_date)
            cards.push({
                tmdbId,
                mediaType: "tv",
                season: seasonNumber,
                media,
            })
        }

        return cards
    }

    private _tvSeasonMedia(
        details: TMDBDetails,
        title: string,
        originalTitle: string,
        seasonNumber: number,
        episodeCount: number,
        airDate?: string,
    ): $app.AL_BaseAnime {
        const tmdbId = Number(details.id)
        const poster = this._poster(details.poster_path)
        const backdrop = this._backdrop(details.backdrop_path) || poster
        const startDate = this._parseDate(details.first_air_date)

        const genres = Array.isArray(details.genres)
            ? details.genres.map(g => g.name).filter(Boolean)
            : []

        if (!genres.includes("TMDB")) {
            genres.push("TMDB")
        }

        if (!genres.includes("TV")) {
            genres.push("TV")
        }

        const synonyms = [
            originalTitle,
            details.tagline || "",
            details.original_language || "",
        ].filter(x => x && x !== title)

        let nextAiringEpisode: any = undefined

        if (details.next_episode_to_air?.air_date && Number(details.next_episode_to_air.season_number) === seasonNumber) {
            const airingAt = new Date(details.next_episode_to_air.air_date).getTime()

            if (!isNaN(airingAt)) {
                nextAiringEpisode = {
                    episode: details.next_episode_to_air.episode_number || 1,
                    airingAt,
                    timeUntilAiring: Math.floor((airingAt - Date.now()) / 1000),
                }
            }
        }

        const seasonTitle = seasonNumber > 1
            ? `${title} — Season ${seasonNumber}`
            : title

        const seasonStart = airDate ? new Date(airDate).getTime() : 0
        const nextSeason = details.next_episode_to_air ? Number(details.next_episode_to_air.season_number) : undefined
        const lastSeason = details.last_episode_to_air ? Number(details.last_episode_to_air.season_number) : undefined

        let seasonStatus: $app.AL_MediaStatus
        if (!isNaN(seasonStart) && seasonStart > Date.now()) {
            seasonStatus = "NOT_YET_RELEASED"
        } else if (nextAiringEpisode) {
            seasonStatus = "RELEASING"
        } else if (lastSeason !== undefined && lastSeason >= seasonNumber) {
            seasonStatus = "FINISHED"
        } else if (lastSeason !== undefined && lastSeason < seasonNumber) {
            seasonStatus = "NOT_YET_RELEASED"
        } else {
            seasonStatus = "FINISHED"
        }

        return {
            id: this._encodeId("tv", tmdbId, seasonNumber),
            siteUrl: this._siteUrl("tv", tmdbId),
            title: {
                userPreferred: seasonTitle,
                romaji: seasonTitle,
                english: seasonTitle,
                native: originalTitle || title,
            },
            coverImage: {
                large: poster,
                medium: poster,
                extraLarge: poster,
                color: "",
            },
            bannerImage: backdrop,
            description: details.overview || "",
            genres,
            meanScore: details.vote_average ? Math.round(details.vote_average * 10) : 0,
            synonyms,
            status: seasonStatus,
            episodes: episodeCount,
            type: "ANIME",
            format: "TV",
            seasonYear: startDate?.year || new Date().getUTCFullYear(),
            isAdult: !!details.adult,
            startDate: startDate || {
                year: new Date().getUTCFullYear(),
            },
            endDate: this._parseDate(details.last_air_date) || undefined,
            nextAiringEpisode,
        }
    }

    private _movieDetailsToStoredMedia(details: TMDBDetails): StoredTMDBMedia {
        const tmdbId = Number(details.id)
        const title = details.title || details.original_title || "Movie"
        const originalTitle = details.original_title || title
        const startDate = this._parseDate(details.release_date)

        const poster = this._poster(details.poster_path)
        const backdrop = this._backdrop(details.backdrop_path) || poster

        const genres = Array.isArray(details.genres)
            ? details.genres.map(g => g.name).filter(Boolean)
            : []

        if (!genres.includes("TMDB")) {
            genres.push("TMDB")
        }

        if (!genres.includes("Movie")) {
            genres.push("Movie")
        }

        const synonyms = [
            originalTitle,
            details.tagline || "",
            details.original_language || "",
        ].filter(x => x && x !== title)

        const media: $app.AL_BaseAnime = {
            id: this._encodeId("movie", tmdbId),
            siteUrl: this._siteUrl("movie", tmdbId),
            title: {
                userPreferred: title,
                romaji: title,
                english: title,
                native: originalTitle || title,
            },
            coverImage: {
                large: poster,
                medium: poster,
                extraLarge: poster,
                color: "",
            },
            bannerImage: backdrop,
            description: details.overview || "",
            genres,
            meanScore: details.vote_average ? Math.round(details.vote_average * 10) : 0,
            synonyms,
            status: this._toStatus(details.status, details.release_date),
            episodes: 1,
            type: "ANIME",
            format: "MOVIE",
            seasonYear: startDate?.year || new Date().getUTCFullYear(),
            isAdult: !!details.adult,
            startDate: startDate || {
                year: new Date().getUTCFullYear(),
            },
            endDate: startDate || undefined,
        }

        const metadata = this._movieDetailsToMetadata(details)

        return {
            tmdbId,
            mediaType: "movie",
            season: 0,
            media,
            metadata,
            realMetadata: true,
        }
    }

    private _movieDetailsToMetadata(details: TMDBDetails): $app.Metadata_AnimeMetadata {
        const title = details.title || details.original_title || "Movie"
        const poster = this._poster(details.poster_path)
        const date = details.release_date || ""

        const description = this._truncate(
            [
                details.tagline || "",
                "",
                details.overview || "",
                "",
                `TMDB: ${this._siteUrl("movie", details.id)}`,
            ].filter(Boolean).join("\n"),
            4000,
        )

        return {
            titles: {
                en: title,
            },
            episodes: {
                "1": {
                    anidbId: 0,
                    tvdbId: 0,
                    anidbEid: 0,
                    title,
                    image: poster,
                    airDate: date,
                    length: details.runtime || 0,
                    summary: description,
                    overview: description,
                    episodeNumber: 1,
                    episode: "1",
                    seasonNumber: 1,
                    absoluteEpisodeNumber: 1,
                    hasImage: !!poster,
                },
            },
            episodeCount: 1,
            specialCount: 0,
        }
    }

    // Builds metadata for a single season: episodes keyed relatively 1..N.
    private async _tvSeasonToMetadata(tmdbId: number, seasonNumber: number): Promise<$app.Metadata_AnimeMetadata | null> {
        const [details, seasonDetails] = await Promise.all([
            this._getDetails("tv", tmdbId),
            this._tmdbGet<TMDBSeasonDetails>(`/tv/${tmdbId}/season/${seasonNumber}`, {}),
        ])

        const title = details?.name || seasonDetails?.name || `Season ${seasonNumber}`

        const fallbackRuntime = Array.isArray(details?.episode_run_time) && details!.episode_run_time.length > 0
            ? details!.episode_run_time[0]
            : 0

        const seasonEpisodes = Array.isArray(seasonDetails?.episodes)
            ? seasonDetails!.episodes
            : []

        const episodes: Record<string, $app.Metadata_EpisodeMetadata> = {}

        for (let i = 0; i < seasonEpisodes.length; i++) {
            const ep = seasonEpisodes[i]
            const n = i + 1
            const image = this._still(ep.still_path)
            const epTitle = ep.name || `Episode ${n}`

            episodes[String(n)] = {
                anidbId: 0,
                tvdbId: 0,
                anidbEid: 0,
                title: epTitle,
                image,
                airDate: ep.air_date || "",
                length: ep.runtime || fallbackRuntime || 0,
                summary: ep.overview || "",
                overview: ep.overview || "",
                episodeNumber: n,
                episode: String(n),
                seasonNumber,
                absoluteEpisodeNumber: n,
                hasImage: !!image,
            }
        }

        // Fallback: the season endpoint returned no episodes, but the show
        // details know the season exists. Emit placeholder episodes.
        if (Object.keys(episodes).length === 0) {
            const season = Array.isArray(details?.seasons)
                ? details!.seasons.find(s => Number(s.season_number) === seasonNumber)
                : undefined

            const count = Number(season?.episode_count) || 1
            const poster = this._poster(season?.poster_path || details?.poster_path)
            const description = this._truncate(season?.overview || details?.overview || "", 4000)

            for (let i = 1; i <= count; i++) {
                episodes[String(i)] = {
                    anidbId: 0,
                    tvdbId: 0,
                    anidbEid: 0,
                    title: `Episode ${i}`,
                    image: poster,
                    airDate: "",
                    length: fallbackRuntime,
                    summary: description,
                    overview: description,
                    episodeNumber: i,
                    episode: String(i),
                    seasonNumber,
                    absoluteEpisodeNumber: i,
                    hasImage: !!poster,
                }
            }
        }

        return {
            titles: {
                en: title,
            },
            episodes,
            episodeCount: Object.keys(episodes).length,
            specialCount: 0,
        }
    }

    private _fallbackMetadata(media: $app.AL_BaseAnime, mediaType: TMDBMediaType, source: any): $app.Metadata_AnimeMetadata {
        const title = media.title?.english || media.title?.romaji || media.title?.userPreferred || "TMDB Title"
        const image = media.coverImage?.large || ""
        const date = media.startDate?.year
            ? `${media.startDate.year}-${this._pad(media.startDate.month || 1)}-${this._pad(media.startDate.day || 1)}`
            : ""

        const description = this._truncate(media.description || source?.overview || "", 4000)

        return {
            titles: {
                en: title,
            },
            episodes: {
                "1": {
                    anidbId: 0,
                    tvdbId: 0,
                    anidbEid: 0,
                    title,
                    image,
                    airDate: date,
                    length: mediaType === "movie" ? source?.runtime || 0 : 0,
                    summary: description,
                    overview: description,
                    episodeNumber: 1,
                    episode: "1",
                    seasonNumber: 1,
                    absoluteEpisodeNumber: 1,
                    hasImage: !!image,
                },
            },
            episodeCount: mediaType === "movie" ? 1 : media.episodes || 1,
            specialCount: 0,
        }
    }

    private _makeConfigRequiredCard(): $app.AL_BaseAnime {
        const title = "TMDB API key required"
        const now = new Date()

        return {
            id: 999999001,
            siteUrl: "https://www.themoviedb.org/settings/api",
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
            description: "Add your TMDB v3 API key in this extension's settings.",
            genres: ["TMDB"],
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

    // ---------------------------------------------------------------- ID encoding

    private _encodeId(mediaType: TMDBMediaType, tmdbId: number, season = 0): number {
        if (mediaType === "movie") {
            return 1000000000 + Number(tmdbId)
        }

        return 2000000000 + Number(tmdbId) * 1000 + (season || 0)
    }

    private _decodeId(id: number): { mediaType: TMDBMediaType, tmdbId: number, season: number } | null {
        const numericId = Number(id)

        if (!numericId || isNaN(numericId)) {
            return null
        }

        if (numericId >= 2000000000) {
            const rest = numericId - 2000000000
            return {
                mediaType: "tv",
                tmdbId: Math.floor(rest / 1000),
                season: rest % 1000,
            }
        }

        if (numericId >= 1000000000) {
            return {
                mediaType: "movie",
                tmdbId: numericId - 1000000000,
                season: 0,
            }
        }

        return null
    }

    // ---------------------------------------------------------------- utils

    private _titleFromItem(item: TMDBSearchItem): string {
        return item.title || item.name || item.original_title || item.original_name || "TMDB Title"
    }

    private _originalTitleFromItem(item: TMDBSearchItem): string {
        return item.original_title || item.original_name || this._titleFromItem(item)
    }

    private _siteUrl(mediaType: TMDBMediaType, tmdbId: number): string {
        return mediaType === "movie"
            ? `https://www.themoviedb.org/movie/${tmdbId}`
            : `https://www.themoviedb.org/tv/${tmdbId}`
    }

    private _poster(path?: string): string {
        if (!path) return ""
        if (path.startsWith("http")) return path
        return `https://image.tmdb.org/t/p/w500${path}`
    }

    private _backdrop(path?: string): string {
        if (!path) return ""
        if (path.startsWith("http")) return path
        return `https://image.tmdb.org/t/p/w1280${path}`
    }

    private _still(path?: string): string {
        if (!path) return ""
        if (path.startsWith("http")) return path
        return `https://image.tmdb.org/t/p/w500${path}`
    }

    private _parseDate(dateStr?: string): { year: number, month?: number, day?: number } | null {
        if (!dateStr) return null

        const d = new Date(dateStr)

        if (isNaN(d.getTime())) {
            return null
        }

        return {
            year: d.getUTCFullYear(),
            month: d.getUTCMonth() + 1,
            day: d.getUTCDate(),
        }
    }

    private _toStatus(status?: string, firstDate?: string): $app.AL_MediaStatus {
        const first = firstDate ? new Date(firstDate).getTime() : 0

        if (first && !isNaN(first) && first > Date.now()) {
            return "NOT_YET_RELEASED"
        }

        const s = String(status || "").toLowerCase()

        if (
            s.includes("returning") ||
            s.includes("in production")
        ) {
            return "RELEASING"
        }

        if (
            s.includes("planned") ||
            s.includes("pilot") ||
            s.includes("post production") ||
            s.includes("rumored")
        ) {
            return "NOT_YET_RELEASED"
        }

        return "FINISHED"
    }

    private _apiKey(): string {
        const key = String(this.api_key || "").trim()

        if (!key || key.includes("{{") || key.includes("}}")) {
            return ""
        }

        return key
    }

    private _hasApiKey(): boolean {
        return this._apiKey().length > 0
    }

    private _language(): string {
        const lang = String(this.language || "en-US").trim()

        if (!lang || lang.includes("{{") || lang.includes("}}")) {
            return "en-US"
        }

        return lang
    }

    private _includeAdult(): boolean {
        const value = String(this.include_adult || "false").toLowerCase().trim()
        return value === "true" || value === "1" || value === "yes"
    }

    private _truncate(input: string, max: number): string {
        if (!input) return ""
        if (input.length <= max) return input
        return input.slice(0, max - 3) + "..."
    }

    private _pad(value: number): string {
        return value < 10 ? `0${value}` : `${value}`
    }

    // ---------------------------------------------------------------- cache

    private _getMediaCache(): Record<number, StoredTMDBMedia> {
        const raw = $store.get("tmdb.media") as { version?: number; media?: Record<number, StoredTMDBMedia> } | undefined

        if (!raw || raw.version !== MEDIA_CACHE_VERSION || !raw.media) {
            return {}
        }

        return raw.media
    }

    private _setMediaCache(cache: Record<number, StoredTMDBMedia>) {
        $store.set("tmdb.media", {
            version: MEDIA_CACHE_VERSION,
            media: cache,
        })
    }
}

type TMDBMediaType = "movie" | "tv"

type StoredTMDBMedia = {
    tmdbId: number
    mediaType: TMDBMediaType
    season: number
    media: $app.AL_BaseAnime
    metadata?: $app.Metadata_AnimeMetadata
    // True when the metadata was genuinely built (per-episode overviews/stills).
    // False/absent for the placeholder fallback that is not safe to return.
    realMetadata?: boolean
}

type TMDBListResponse<T> = {
    page: number
    results: T[]
    total_pages: number
    total_results: number
}

type TMDBGenre = {
    id: number
    name: string
}

type TMDBSearchItem = {
    id: number
    media_type: "movie" | "tv" | "person" | string
    title?: string
    name?: string
    original_title?: string
    original_name?: string
    overview?: string
    poster_path?: string
    backdrop_path?: string
    release_date?: string
    first_air_date?: string
    vote_average?: number
    vote_count?: number
    popularity?: number
    adult?: boolean
    genre_ids?: number[]
    original_language?: string
}

type TMDBDetails = {
    id: number

    title?: string
    original_title?: string
    name?: string
    original_name?: string

    overview?: string
    tagline?: string
    status?: string

    poster_path?: string
    backdrop_path?: string

    release_date?: string
    first_air_date?: string
    last_air_date?: string

    runtime?: number
    episode_run_time?: number[]

    vote_average?: number
    vote_count?: number
    popularity?: number

    adult?: boolean
    original_language?: string

    genres?: TMDBGenre[]

    number_of_episodes?: number
    number_of_seasons?: number
    seasons?: TMDBSeason[]

    next_episode_to_air?: TMDBEpisode
    last_episode_to_air?: TMDBEpisode
}

type TMDBSeason = {
    id?: number
    name?: string
    overview?: string
    poster_path?: string
    season_number: number
    episode_count?: number
    air_date?: string
}

type TMDBSeasonDetails = {
    id: number
    name?: string
    overview?: string
    poster_path?: string
    season_number: number
    air_date?: string
    episodes?: TMDBEpisode[]
}

type TMDBEpisode = {
    id?: number
    name?: string
    overview?: string
    air_date?: string
    episode_number?: number
    season_number?: number
    still_path?: string
    runtime?: number
}
