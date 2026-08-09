/// <reference path="../online-streaming-provider.d.ts" />
/// <reference path="../core.d.ts" />

// The repo's shared d.ts files declare colliding global types (Settings,
// SearchResult are also used by manga-provider/custom-source). Define the
// onlinestream shapes locally so this provider type-checks in isolation.
type CornSubOrDub = "sub" | "dub" | "both"

type CornSearchResult = {
    id: string
    title: string
    url: string
    subOrDub: CornSubOrDub
}

type CornEpisodeDetails = {
    id: string
    number: number
    url: string
    title?: string
}

type CornVideoSource = {
    url: string
    type: "mp4" | "m3u8"
    quality: string
    subtitles: CornVideoSubtitle[]
}

type CornVideoSubtitle = {
    id: string
    url: string
    language: string
    isDefault: boolean
}

type CornEpisodeServer = {
    server: string
    headers: { [key: string]: string }
    videoSources: CornVideoSource[]
}

type CornMedia = {
    englishTitle?: string
    romajiTitle?: string
}

type CornSearchOptions = {
    media: CornMedia
    query: string
    dub: boolean
}

type CornSettings = {
    episodeServers: string[]
    supportsDub: boolean
}

type CornhubVideo = {
    videoId: string
    title: string
    url: string
    thumbnail: string
}

class Provider {
    private base_url = "https://www.pornhub.com"

    getSettings(): CornSettings {
        return {
            episodeServers: ["pornhub"],
            supportsDub: false,
        }
    }

    async search(opts: CornSearchOptions): Promise<CornSearchResult[]> {
        const query = String(opts.query || opts.media.englishTitle || opts.media.romajiTitle || "").trim()
        if (!query) return []

        const candidates = [query, this._sanitizeQuery(query)]

        const ret: CornSearchResult[] = []

        // Mirrors the community custom source: try multiple URL variants and
        // swallow per-request failures so a 404 never rejects the whole search.
        for (const candidate of candidates) {
            if (!candidate) continue

            const urls = [
                `${this._baseUrl()}/video/search?search=${encodeURIComponent(candidate)}&page=1`,
                `${this._baseUrl()}/video/search?search=${encodeURIComponent(candidate)}`,
            ]

            for (const url of urls) {
                try {
                    const html = await this._fetchText(url)
                    if (!html || html.length < 500) continue

                    const videos = this._parseSearchPage(html)

                    for (const video of this._dedupeVideos(videos)) {
                        if (!video.videoId || !video.title) continue
                        ret.push({
                            id: video.videoId,
                            title: video.title,
                            url: video.url,
                            subOrDub: "both",
                        })
                    }

                    if (ret.length > 0) return ret
                } catch (err) {
                    // Try the next URL / candidate (pornhub 404s on queries it
                    // can't resolve, e.g. ones containing "!!").
                }
            }
        }

        return ret
    }

    // Strips characters pornhub's search endpoint rejects, keeping only safe
    // ones. "Hardcore Gangbang!! 4 Spaniard" -> "Hardcore Gangbang 4 Spaniard".
    private _sanitizeQuery(query: string): string {
        return String(query || "")
            .replace(/[^a-zA-Z0-9\s\-_+]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    async findEpisodes(id: string): Promise<CornEpisodeDetails[]> {
        const videoId = this._getPornhubId(id)
        if (!videoId) return []

        const url = this._watchUrl(videoId)
        const html = await this._fetchText(url)

        const jsonLdVideo = this._parseJsonLdVideo(html, url)
        const title =
            this._decode(jsonLdVideo?.title || "") ||
            this._decode(this._match(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)) ||
            this._decode(this._match(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) ||
            "Pornhub Video"

        return [
            {
                id: videoId,
                number: 1,
                url: url,
                title: title,
            },
        ]
    }

    async findEpisodeServer(episode: CornEpisodeDetails, _server: string): Promise<CornEpisodeServer> {
        const videoId = this._getPornhubId(episode.id)
        if (!videoId) {
            throw new Error("Invalid episode id.")
        }

        const url = this._watchUrl(videoId)
        const html = await this._fetchText(url)

        const videoSources = this._extractVideoSources(html)

        if (videoSources.length === 0) {
            throw new Error("No video sources found.")
        }

        return {
            server: "pornhub",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
                "Referer": `${this._baseUrl()}/`,
                "Accept-Language": "en-US,en;q=0.9",
            },
            videoSources: videoSources,
        }
    }

    // ------------------------------------------------------------------ stream extraction

    // Extracts the video page's flashvars JSON object (brace balanced).
    private _extractFlashvars(html: string): any | null {
        const match = html.match(/var\s+flashvars_[\w]*\s*=\s*(\{)/)
        if (!match) return null

        const start = match.index! + match[0].length - 1
        let depth = 0
        let inStr = false
        let esc = false

        for (let i = start; i < html.length; i++) {
            const c = html[i]

            if (inStr) {
                if (esc) {
                    esc = false
                } else if (c === "\\") {
                    esc = true
                } else if (c === '"') {
                    inStr = false
                }
                continue
            }

            if (c === '"') {
                inStr = true
            } else if (c === "{") {
                depth++
            } else if (c === "}") {
                depth--
                if (depth === 0) {
                    try {
                        return JSON.parse(html.slice(start, i + 1))
                    } catch (err) {
                        return null
                    }
                }
            }
        }

        return null
    }

    private _extractVideoSources(html: string): CornVideoSource[] {
        const ret: CornVideoSource[] = []
        const seen: Record<string, boolean> = {}

        const push = (url: string, type: "mp4" | "m3u8", quality: string) => {
            if (!url || seen[url]) return
            seen[url] = true
            ret.push({
                url: url,
                type: type,
                quality: quality || "auto",
                subtitles: [],
            })
        }

        const flashvars = this._extractFlashvars(html)

        if (flashvars?.mediaDefinitions && Array.isArray(flashvars.mediaDefinitions)) {
            for (const def of flashvars.mediaDefinitions) {
                if (!def) continue

                const format = String(def.format || "").toLowerCase()
                const rawUrl = def.videoUrl || def.url || ""

                if (!rawUrl) continue

                const height = Number(def.height) || 0
                const width = Number(def.width) || 0
                let quality = this._decode(String(def.quality || ""))
                if (!quality) {
                    if (height > 0) quality = `${height}p`
                    else if (width > 0) quality = `${width}p`
                } else if (/^\d+$/.test(quality)) {
                    quality = `${quality}p`
                }

                if (format === "hls") {
                    push(rawUrl, "m3u8", quality)
                } else if (format === "mp4") {
                    // Direct mp4 URLs are served via a get_media endpoint that
                    // usually requires extra tokens/cookies; keep them as mp4
                    // only when they look like direct media files.
                    if (rawUrl.includes("/video/get_media")) continue
                    push(rawUrl, "mp4", quality)
                }
            }
        }

        // Fallback: quality items embedded as key/value URL maps.
        if (ret.length === 0 && flashvars?.qualityItems && Array.isArray(flashvars.qualityItems)) {
            for (const item of flashvars.qualityItems) {
                if (!item) continue
                const rawUrl = item.url || item.videoUrl || ""
                if (!rawUrl) continue
                push(rawUrl, "m3u8", this._decode(String(item.quality || item.id || "")))
            }
        }

        // Fallback: bare HLS URLs anywhere in the page.
        if (ret.length === 0) {
            const m3u8Pattern = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/gi
            let m: RegExpExecArray | null
            while ((m = m3u8Pattern.exec(html)) !== null) {
                const u = this._decode(m[0])
                if (u.includes("master.m3u8")) {
                    push(u, "m3u8", "auto")
                }
            }
        }

        // Sort highest quality first, keep default quality on top.
        const score = (q: string): number => {
            const num = parseInt(q, 10)
            return isNaN(num) ? 0 : num
        }

        return ret.sort((a, b) => score(b.quality) - score(a.quality))
    }

    // ------------------------------------------------------------------ search parsing

    private _parseSearchPage(html: string): CornhubVideo[] {
        const videos: CornhubVideo[] = []

        const jsonLdVideos = this._parseJsonLdList(html)
        videos.push(...jsonLdVideos)

        const patterns = [
            /<a[^>]+href=["']([^"']*view_video\.php\?viewkey=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
            /<a[^>]+href=["']([^"']*\/view_video\.php\?viewkey=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        ]

        for (const pattern of patterns) {
            let match: RegExpExecArray | null

            while ((match = pattern.exec(html)) !== null) {
                const rawHref = this._decode(match[1] || "")
                const inner = match[2] || ""
                const videoId = this._getPornhubId(rawHref)

                if (!videoId) continue

                const title =
                    this._decode(this._match(inner, /title=["']([^"']+)["']/i)) ||
                    this._decode(this._match(inner, /alt=["']([^"']+)["']/i)) ||
                    this._decode(this._stripTags(inner)).trim()

                if (!title || title.length < 2) continue

                const thumb =
                    this._decode(this._match(inner, /data-mediumthumb=["']([^"']+)["']/i)) ||
                    this._decode(this._match(inner, /data-src=["']([^"']+)["']/i)) ||
                    this._decode(this._match(inner, /src=["']([^"']+)["']/i)) ||
                    ""

                videos.push({
                    videoId,
                    title,
                    url: this._normalizeUrl(rawHref),
                    thumbnail: this._normalizeUrl(thumb),
                })
            }
        }

        return this._dedupeVideos(videos)
    }

    private _parseJsonLdList(html: string): CornhubVideo[] {
        const ret: CornhubVideo[] = []
        const scripts = this._extractScriptJsonLd(html)

        for (const raw of scripts) {
            try {
                const data = JSON.parse(raw)
                const items = this._flattenJsonLd(data)

                for (const item of items) {
                    const video = this._jsonLdToVideo(item, "")
                    if (video) ret.push(video)
                }
            } catch (err) {
            }
        }

        return ret
    }

    private _parseJsonLdVideo(html: string, pageUrl: string): CornhubVideo | null {
        const scripts = this._extractScriptJsonLd(html)

        for (const raw of scripts) {
            try {
                const data = JSON.parse(raw)
                const items = this._flattenJsonLd(data)

                for (const item of items) {
                    const video = this._jsonLdToVideo(item, pageUrl)
                    if (video) return video
                }
            } catch (err) {
            }
        }

        return null
    }

    private _jsonLdToVideo(item: any, fallbackUrl: string): CornhubVideo | null {
        if (!item) return null

        const type = String(item["@type"] || item.type || "").toLowerCase()

        if (type && !type.includes("videoobject") && !type.includes("video")) {
            return null
        }

        const name = item.name || item.title || ""
        const url = item.url || item.contentUrl || item.embedUrl || fallbackUrl || ""

        const videoId = this._getPornhubId(url) || this._getPornhubId(item["@id"] || "")

        if (!videoId || !name) return null

        const thumbnail = Array.isArray(item.thumbnailUrl)
            ? item.thumbnailUrl[0]
            : item.thumbnailUrl || item.thumbnail || ""

        return {
            videoId,
            title: this._decode(name),
            url: this._normalizeUrl(url || this._watchUrl(videoId)),
            thumbnail: this._normalizeUrl(String(thumbnail || "")),
        }
    }

    // ------------------------------------------------------------------ utils

    private async _fetchText(url: string): Promise<string> {
        const headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        }

        let res = await fetch(url, { headers: headers })

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`)
        }

        let html = await res.text()

        // PornHub intermittently serves a JS anti-bot challenge page instead of
        // the real page. Retry once when the response looks like a challenge.
        if (html.length < 500 || html.includes("leastFactor")) {
            res = await fetch(url, { headers: headers })
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} for ${url}`)
            }
            html = await res.text()
        }

        return html
    }

    private _extractScriptJsonLd(html: string): string[] {
        const ret: string[] = []
        const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
        let match: RegExpExecArray | null

        while ((match = pattern.exec(html)) !== null) {
            const raw = (match[1] || "").trim()
            if (raw) ret.push(raw)
        }

        return ret
    }

    private _flattenJsonLd(data: any): any[] {
        const ret: any[] = []

        const walk = (value: any) => {
            if (!value) return

            if (Array.isArray(value)) {
                for (const item of value) walk(item)
                return
            }

            if (typeof value === "object") {
                ret.push(value)

                if (Array.isArray(value["@graph"])) walk(value["@graph"])
                if (Array.isArray(value.itemListElement)) {
                    for (const el of value.itemListElement) {
                        if (el?.item) walk(el.item)
                        else walk(el)
                    }
                }
            }
        }

        walk(data)
        return ret
    }

    private _getPornhubId(input: string): string {
        const text = String(input || "").trim()

        const patterns = [
            /viewkey=([a-zA-Z0-9_-]+)/i,
            /\/view_video\.php\?viewkey=([a-zA-Z0-9_-]+)/i,
        ]

        for (const pattern of patterns) {
            const match = text.match(pattern)
            if (match?.[1]) return match[1]
        }

        if (/^[a-zA-Z0-9_-]{8,}$/.test(text)) return text

        return ""
    }

    private _watchUrl(videoId: string): string {
        return `${this._baseUrl()}/view_video.php?viewkey=${encodeURIComponent(videoId)}`
    }

    private _baseUrl(): string {
        let url = this.base_url || "https://www.pornhub.com"

        if (url.includes("{{") || url.includes("}}")) {
            url = "https://www.pornhub.com"
        }

        return this._trimSlash(url)
    }

    private _normalizeUrl(url: string): string {
        if (!url) return ""

        if (url.startsWith("//")) return "https:" + url
        if (url.startsWith("/")) return this._baseUrl() + url

        return url
    }

    private _match(text: string, pattern: RegExp): string {
        const match = String(text || "").match(pattern)
        return match?.[1] || ""
    }

    private _stripTags(input: string): string {
        return String(input || "")
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    private _decode(input: string): string {
        const named: Record<string, string> = {
            "amp": "&",
            "quot": '"',
            "apos": "'",
            "lt": "<",
            "gt": ">",
            "nbsp": " ",
            "quest": "?",
            "excl": "!",
            "colon": ":",
            "period": ".",
            "comma": ",",
            "semi": ";",
            "sol": "/",
            "lpar": "(",
            "rpar": ")",
            "lsqb": "[",
            "rsqb": "]",
            "hellip": "…",
            "ndash": "–",
            "mdash": "—",
            "rsquo": "'",
            "lsquo": "'",
            "ldquo": '"',
            "rdquo": '"',
            "prime": "′",
            "deg": "°",
        }

        return String(input || "")
            .replace(/&(#x?[0-9a-fA-F]+);/g, (_, code: string) => {
                try {
                    const n = code[1].toLowerCase() === "x"
                        ? parseInt(code.slice(2), 16)
                        : parseInt(code.slice(1), 10)
                    return String.fromCharCode(n)
                } catch (err) {
                    return ""
                }
            })
            .replace(/&([a-zA-Z0-9]+);/g, (_, name: string) => named[name] ?? `&${name};`)
    }

    private _trimSlash(input: string): string {
        let value = String(input || "").trim()

        while (value.endsWith("/")) {
            value = value.slice(0, -1)
        }

        return value
    }

    private _dedupeVideos(videos: CornhubVideo[]): CornhubVideo[] {
        const seen: Record<string, boolean> = {}
        const ret: CornhubVideo[] = []

        for (const video of videos) {
            if (!video?.videoId || seen[video.videoId]) continue
            seen[video.videoId] = true
            ret.push(video)
        }

        return ret
    }
}
