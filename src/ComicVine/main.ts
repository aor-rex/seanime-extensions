/// <reference path="../custom-source.d.ts" />
/// <reference path="../core.d.ts" />

// ComicVine (gamespot.com) custom source exposing Western comics as manga.
//
// ID scheme:
//   3000000000 + ComicVine volume numeric id
//
// Medium details are fetched on demand from the `/volume/4050-{id}/` endpoint
// and cached (versioned) in $store so browsing/searching stays within the API
// rate limit (200 requests per resource per hour).

const COMICVINE_CACHE_VERSION = 1
const ID_OFFSET = 3000000000

const FIELD_LIST = [
    "id",
    "name",
    "aliases",
    "start_year",
    "description",
    "image",
    "count_of_issues",
    "site_detail_url",
    "publisher",
].join(",")

class Provider implements CustomSource {
    api_key = "{{api-key}}"
    western_comics_only = "{{western-only}}"

    getSettings(): Settings {
        return {
            supportsAnime: false,
            supportsManga: true,
        }
    }

    // ---------------------------------------------------------------- CustomSource (anime stubs)

    async getAnime(ids: number[]): Promise<$app.AL_BaseAnime[]> {
        return []
    }

    async getAnimeMetadata(id: number): Promise<$app.Metadata_AnimeMetadata | null> {
        return null
    }

    async getAnimeWithRelations(id: number): Promise<$app.AL_CompleteAnime> {
        throw new Error("not found.")
    }

    async getAnimeDetails(id: number): Promise<$app.AL_AnimeDetailsById_Media | null> {
        return null
    }

    async listAnime(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseAnime>> {
        return { media: [], total: 0, page: 1, totalPages: 1 }
    }

    // ---------------------------------------------------------------- CustomSource (manga)

    async getManga(ids: number[]): Promise<$app.AL_BaseManga[]> {
        const ret: $app.AL_BaseManga[] = []
        const cache = this._getMediaCache()

        for (const id of ids) {
            const cached = cache[id]

            if (cached) {
                ret.push(cached)
                continue
            }

            const decoded = this._decodeId(id)
            if (!decoded) continue

            const volume = await this._apiGet("/volume/" + decoded.resource + "/", {})
            const result = (volume as any)?.results

            if (!result || typeof result.id === "undefined") continue

            const media = this._volumeToMedia(result)
            cache[media.id] = media
            ret.push(media)
        }

        this._setMediaCache(cache)
        return ret
    }

    async getMangaDetails(id: number): Promise<$app.AL_MangaDetailsById_Media | null> {
        return {
            id: id,
            genres: [],
            siteUrl: "",
            relations: { edges: [] },
            rankings: [],
            recommendations: { edges: [] },
        }
    }

    async listManga(search: string, page: number, perPage: number): Promise<ListResponse<$app.AL_BaseManga>> {
        const query = String(search || "").trim()
        const currentPage = page && page > 0 ? page : 1
        const limit = Math.max(1, Math.min(perPage || 20, 100))

        if (!this._hasApiKey()) {
            return {
                media: [],
                total: 0,
                page: 1,
                totalPages: 1,
            }
        }

        let env: any = null
        let total = 0

        if (query.length > 0) {
            env = await this._apiGet("/search/", {
                query,
                resources: "volume",
                field_list: FIELD_LIST,
                limit: String(limit),
                page: String(currentPage),
            })
            total = Number((env as any)?.number_of_total_results) || 0
        } else {
            env = await this._apiGet("/volumes/", {
                sort: "date_added:desc",
                field_list: FIELD_LIST,
                limit: String(limit),
                page: String(currentPage),
            })
            total = Number((env as any)?.number_of_total_results) || 0
        }

        const results = (env as any)?.results || []
        const cache = this._getMediaCache()
        const media: $app.AL_BaseManga[] = []

        for (const result of results) {
            if (this._westernOnly() && this._isMangaLike(result)) continue

            const m = this._volumeToMedia(result)
            if (this._isFiniteMedia(m)) {
                cache[m.id] = m
                media.push(m)
            }
        }

        this._setMediaCache(cache)

        return {
            media,
            total,
            page: currentPage,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        }
    }

    // ---------------------------------------------------------------- ComicVine helpers

    private _apiGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
        const key = this._apiKey()
        if (!key) return Promise.resolve(null)

        const query: Record<string, string> = {
            api_key: key,
            format: "json",
            ...params,
        }

        const parts: string[] = []

        for (const k of Object.keys(query)) {
            const value = query[k]
            if (value === undefined || value === null || value === "") continue
            parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`)
        }

        const url = `https://comicvine.gamespot.com/api${path}?${parts.join("&")}`

        try {
            return fetch(url, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "Seanime/1.0",
                },
            }).then(res => res.json())
        } catch (err) {
            console.error("ComicVine fetch failed:", err)
            return Promise.resolve(null)
        }
    }

    private _volumeToMedia(result: any): $app.AL_BaseManga {
        const numericId = Number(String(result?.id).replace(/\D/g, ""))
        const id = numericId ? this._encodeId(numericId) : ID_OFFSET

        const title = String(result?.name || "").trim() || "Unknown"
        const aliases = this._normalizeAliases(result?.aliases)
        const image = result?.image || {}
        const superUrl = String(image.super_url || image.large_url || "").trim()
        const mediumUrl = String(image.medium_url || image.small_url || image.thumb_url || "").trim()
        const publisher = String(result?.publisher?.name || "").trim()

        return {
            id: id,
            siteUrl: String(result?.site_detail_url || "").trim(),
            title: {
                userPreferred: title,
                romaji: title,
                english: title,
            },
            coverImage: {
                extraLarge: superUrl,
                large: superUrl || mediumUrl,
                medium: mediumUrl,
                color: "",
            },
            description: this._cleanHtml(result?.description),
            chapters: Number(result?.count_of_issues) || 0,
            synonyms: aliases,
            genres: publisher ? [publisher] : [],
            type: "MANGA",
            startDate: this._startDate(result?.start_year),
        }
    }

    private _startDate(startYear: any): { year: number } | undefined {
        if (startYear === undefined || startYear === null) return undefined
        if (typeof startYear === "string" && !startYear.trim()) return undefined
        const year = Number(startYear)
        return Number.isFinite(year) ? { year } : undefined
    }

    private _decodeId(id: number): { resource: string, numericId: number } | null {
        const numericId = Number(id)
        if (!numericId || numericId < ID_OFFSET) return null
        const value = numericId - ID_OFFSET
        if (value < 1) return null
        return { resource: `4050-${value}`, numericId: value }
    }

    private _encodeId(numericId: number): number {
        return ID_OFFSET + Number(numericId)
    }

    private _normalizeAliases(aliases: any): string[] {
        if (typeof aliases !== "string" || !aliases.trim()) return []
        const parts = aliases.split("\n").map(a => a.trim()).filter(a => a.length > 0)
        return parts.slice(0, 10)
    }

    private _isFiniteMedia(m: any): boolean {
        const values: any[] = []
        if (m) values.push(m.id, m.chapters, m.startDate?.year)
        return values.every(v => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v)))
    }

    private _cleanHtml(input: any): string {
        if (typeof input !== "string" || !input) return ""
        const withoutTags = input.replace(/<[^>]*>/g, " ")
        const decoded = withoutTags
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, "\"")
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
        return decoded.replace(/\s+/g, " ").trim()
    }

    private _apiKey(): string {
        return String(this.api_key || "").trim()
    }

    private _hasApiKey(): boolean {
        const key = this._apiKey()
        return key.length > 0 && !key.includes("{{")
    }

    private _westernOnly(): boolean {
        return String(this.western_comics_only || "").trim() === "true"
    }

    // Best-effort "is manga" detection. ComicVine exposes no country, language,
    // or manga flag on volumes (see /volume and /publisher docs), so this relies
    // on: "manga" in the name/aliases, CJK characters in the name, or a
    // manga-only publisher. International manga editions (e.g. Naruto@Carlsen,
    // Hellsing@Dark Horse) may still slip through.
    private _isMangaLike(result: any): boolean {
        const name = String(result?.name || "")
        const aliases = String(result?.aliases || "")

        if (/manga|mang[áàâäã]/i.test(name) || /manga|mang[áàâäã]/i.test(aliases)) return true

        const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
        if (cjk.test(name)) return true

        const publisher = String(result?.publisher?.name || "").toLowerCase()
        const mangaPublishers = [
            "shueisha", "shogakukan", "kodansha", "viz", "tokyopop", "yen press",
            "seven seas", "square enix", "kadokawa", "ichijinsha", "houbunsha",
            "akita shoten", "hakusensha", "futabasha", "media factory",
            "ascii media works", "del rey manga", "cmx", "one peace", "vertical",
            "shonen gahosha", "bungeishunju",
        ]
        return mangaPublishers.some(p => publisher.includes(p))
    }

    // ---------------------------------------------------------------- cache

    private _getMediaCache(): Record<number, $app.AL_BaseManga> {
        const raw = $store.get("comicvine.media") as { version?: number, media?: Record<number, $app.AL_BaseManga> } | undefined

        if (!raw || raw.version !== COMICVINE_CACHE_VERSION || !raw.media) {
            return {}
        }

        return raw.media
    }

    private _setMediaCache(cache: Record<number, $app.AL_BaseManga>) {
        $store.set("comicvine.media", {
            version: COMICVINE_CACHE_VERSION,
            media: cache,
        })
    }
}