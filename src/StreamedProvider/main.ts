/// <reference path="../online-streaming-provider.d.ts" />
/// <reference path="../core.d.ts" />

// Streamed (Sports) - Online Streaming Provider
// Resolves Streamed's embed player into a raw HLS (.m3u8) URL that Seanime can
// play natively. Streams are live sports broadcasts; availability varies.

const API_BASES = [
    "https://streamed.pk",
    "https://streamed.st",
]

// All stream sources exposed by Streamed (per API docs)
const SOURCES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "intel"]

const SERVER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Referer": "https://exposestrat.com/",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

type ProviderMatch = {
    id: string
    title: string
    category: string
    date: number
    popular: boolean
    teams?: { home?: { name?: string }; away?: { name?: string } }
    sources?: { source: string; id: string }[]
}

class Provider {
    private base = API_BASES[0]
    // Cache of the fetched match by id, so the embed chain isn't re-walked per server.
    private matchCache: Record<string, ProviderMatch> = {}

    getSettings(): Settings {
        return {
            episodeServers: ["streamed"],
            supportsDub: false,
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

    private async _fetchText(url: string, referer?: string): Promise<string> {
        const headers: Record<string, string> = {
            "User-Agent": SERVER_HEADERS["User-Agent"],
        }
        if (referer) headers["Referer"] = referer
        const res = await fetch(url, { headers })
        if (!res.ok) throw new Error(`Request failed: ${url} (${res.status})`)
        return await res.text()
    }

    private _match(html: string, re: RegExp): string | null {
        const m = html.match(re)
        return m ? m[1] : null
    }

    // find match by id within the cached lists
    private async _getMatch(id: string): Promise<ProviderMatch | null> {
        if (this.matchCache[id]) return this.matchCache[id]

        const lists = [
            await this._api<ProviderMatch[]>("/api/matches/live"),
            await this._api<ProviderMatch[]>("/api/matches/all-today"),
            await this._api<ProviderMatch[]>("/api/matches/all/popular"),
        ]
        for (const list of lists) {
            if (!list) continue
            const found = list.find((m) => m && m.id === id)
            if (found) {
                this.matchCache[id] = found
                return found
            }
        }
        return null
    }

    private _titleOf(match: ProviderMatch): string {
        if (match.teams?.home?.name && match.teams?.away?.name) {
            return `${match.teams.home.name} vs ${match.teams.away.name}`
        }
        return match.title
    }

    private _normalize(s: string): string {
        return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "")
    }

    // ---------------------------------------------------------------- embed -> m3u8

    // Resolve the stream's embedUrl into a playable .m3u8 URL.
    private async _resolveEmbed(embedUrl: string): Promise<string> {
        // 1. Fetch the embed page (embed.st/embed/...) and find the inner streamed.php iframe
        const embedHtml = await this._fetchText(embedUrl)
        const inner = this._match(embedHtml, /<iframe[^>]+src="([^"]*streamed\.php[^"]*)"[^>]*>/i)
        if (!inner) throw new Error("Could not locate streamed.php iframe.")

        let streamedUrl = inner
        if (streamedUrl.startsWith("//")) streamedUrl = "https:" + streamedUrl
        else if (streamedUrl.startsWith("/")) streamedUrl = "https://embed.st" + streamedUrl
        if (!streamedUrl.startsWith("http")) streamedUrl = "https://embed.st" + streamedUrl

        // 2. Fetch streamed.php to get the channel fid
        const phpHtml = await this._fetchText(streamedUrl, "https://embed.st/")
        const fid = this._match(phpHtml, /fid\s*=\s*"([^"]+)"/)
        if (!fid) throw new Error("Could not extract channel fid.")

        // 3. Fetch maestrohd1.php which embeds the real player with the HLS URL
        const maestroUrl = `https://exposestrat.com/maestrohd1.php?player=desktop&live=${encodeURIComponent(fid)}`
        const maestroHtml = await this._fetchText(maestroUrl, "https://embedhd.st/")

        // 4. Extract the obfuscated char-array URL (rpUltgetHt return)
        const m3u8 = this._extractM3U8(maestroHtml)
        if (!m3u8) throw new Error("Could not extract HLS URL from player.")
        return m3u8
    }

    // The player builds the m3u8 URL in rpUltgetHt() as a char array join:
    //   return(["h","t","t",...].join("") + ibrUatrSnergelayrusaA.join("") + ...)
    private _extractM3U8(html: string): string | null {
        const arrayMatch = html.match(/return\(\s*(\[[\s\S]*?\])\s*\.join\(""\)/)
        if (!arrayMatch) return null

        let out = ""
        const arraySrc = arrayMatch[1]
        const parts = arraySrc.match(/"((?:[^"\\]|\\.)*)"/g) || []
        for (const part of parts) {
            const val = part.slice(1, -1).replace(/\\\//g, "/")
            out += val
        }
        if (!out || !out.startsWith("http")) return null

        // Optional suffix variables are almost always [""]; ignore them.
        return out
    }

    // Fetch all live streams for a match source and pick the best embed.
    private async _getEmbedForSource(matchId: string, source: string): Promise<string> {
        const match = await this._getMatch(matchId)
        if (!match || !match.sources) throw new Error("Match not found.")

        const srcInfo = match.sources.find((s) => s.source === source)
        if (!srcInfo) throw new Error(`Source '${source}' not available for this match.`)

        const url = `/api/stream/${source}/${srcInfo.id}`
        const streams = await this._api<any[]>(url)
        if (!streams || streams.length === 0) throw new Error("No live streams for this source.")

        // Prefer HD English stream
        let best = streams[0]
        for (const s of streams) {
            if (s && s.hd && String(s.language || "").toLowerCase().startsWith("en")) {
                best = s
                break
            }
        }
        if (!best || !best.embedUrl) throw new Error("Stream has no embed URL.")
        return best.embedUrl
    }

    // ---------------------------------------------------------------- Provider

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = String(opts.query || opts.media?.englishTitle || opts.media?.romajiTitle || "").trim()
        if (!query) return []

        const q = this._normalize(query)

        const lists = [
            await this._api<ProviderMatch[]>("/api/matches/live"),
            await this._api<ProviderMatch[]>("/api/matches/all-today"),
            await this._api<ProviderMatch[]>("/api/matches/all/popular"),
        ]

        const results: SearchResult[] = []
        const seen: Record<string, boolean> = {}

        for (const list of lists) {
            if (!list) continue
            for (const m of list) {
                if (!m || !m.id) continue
                const title = this._titleOf(m)
                const nTitle = this._normalize(title)

                // exact normalized match, or a longer-title containment match
                const exact = nTitle === q
                const contains = nTitle.includes(q) && q.length >= 4
                if (!exact && !contains) continue
                if (seen[m.id]) continue
                seen[m.id] = true

                results.push({
                    id: m.id,
                    title: title,
                    url: "",
                    subOrDub: "sub",
                })
            }
        }

        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const match = await this._getMatch(id)
        if (!match) return []

        const title = this._titleOf(match)
        return [
            {
                id: id,
                number: 1,
                url: "",
                title: title,
            },
        ]
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        // We advertise a single "streamed" server; walk the match's sources
        // in order and return the first resolvable HLS stream.
        const match = await this._getMatch(episode.id)
        if (!match || !match.sources || match.sources.length === 0) {
            throw new Error("Match not found or has no sources.")
        }

        let lastErr: Error | null = null

        for (const srcInfo of match.sources) {
            try {
                const embedUrl = await this._getEmbedForSource(episode.id, srcInfo.source)
                const m3u8 = await this._resolveEmbed(embedUrl)
                return {
                    server: "streamed",
                    headers: SERVER_HEADERS,
                    videoSources: [
                        {
                            url: m3u8,
                            type: "m3u8",
                            quality: "auto",
                            subtitles: [],
                        },
                    ],
                }
            } catch (err) {
                lastErr = err as Error
            }
        }

        throw new Error(lastErr?.message || "No playable source found.")
    }
}

export = new Provider()