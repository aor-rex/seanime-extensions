/// <reference path="../online-streaming-provider.d.ts" />
/// <reference path="../core.d.ts" />

const SIMKL_API = "https://api.simkl.com"
const VIDSRC_API = "https://data.vidsrcme.ru/api.php"

interface SimklIds {
    simkl_id?: number
    simkl?: number
    slug?: string
    tmdb?: string
}

interface SimklItem {
    title?: string
    title_en?: string
    year?: number
    type?: string
    endpoint_type?: string
    ep_count?: number
    ids?: SimklIds
}

interface VidsrcData {
    title?: string
    imdb_id?: string
    season?: number
    episode?: string
    eps?: Record<string, string[]>
    stream_urls?: string
}

interface VidsrcResponse {
    status_code?: string
    data?: VidsrcData
    vs?: {
        w?: number
        wasm_url?: string
    }
}

class Provider implements AnimeProvider {
    private clientId = "{{simkl-client-id}}"

    getSettings(): Settings {
        return {
            episodeServers: ["vidsrc"],
            supportsDub: false,
        }
    }

    // ---------------------------------------------------------------- helpers

    private hasClientId(): boolean {
        const key = String(this.clientId || "").trim()
        return key.length > 0 && !key.includes("{{")
    }

    private async simklSearch(type: "anime" | "tv" | "movie", q: string): Promise<SimklItem[] | null> {
        try {
            const res = await fetch(
                `${SIMKL_API}/search/${type}?q=${encodeURIComponent(q)}&client_id=${encodeURIComponent(this.clientId)}&extended=full&limit=10`,
            )
            if (!res.ok) return null
            return res.json() as unknown as SimklItem[]
        } catch {
            return null
        }
    }

    private async simklDetail(type: "anime" | "tv" | "movie", simklId: number): Promise<SimklItem | null> {
        try {
            const res = await fetch(
                `${SIMKL_API}/${type}/${simklId}?client_id=${encodeURIComponent(this.clientId)}&extended=full`,
            )
            if (!res.ok) return null
            return res.json() as unknown as SimklItem
        } catch {
            return null
        }
    }

    private tmdbOf(item: SimklItem, type: "anime" | "tv" | "movie"): string {
        const t = item?.ids?.tmdb
        if (t && t !== "0") return String(t)
        return ""
    }

    private str(v: any): string {
        return v === null || v === undefined ? "" : String(v)
    }

    // Resolve a vidsrc type + tmdb id for a media type.
    private vidsrcType(mediaFormat: string | undefined): "tv" | "movie" {
        const f = String(mediaFormat || "").toUpperCase()
        if (f === "MOVIE" || f === "SPECIAL") return "movie"
        return "tv"
    }

    // ---------------------------------------------------------------- search

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        if (!this.hasClientId()) {
            throw new Error("SIMKL Client ID is not configured. Set it in the VidSrc extension settings.")
        }

        const query = String(opts.query || "").trim()
        if (!query) return []

        const vType = this.vidsrcType(opts.media?.format)
        // Anime covers both series (TV) and movies on SIMKL; real movies live
        // under "movie". Try the primary endpoint, fall back to the other.
        const endpoints: ("anime" | "tv" | "movie")[] = vType === "movie"
            ? ["movie", "anime"]
            : ["anime", "tv"]

        let items: SimklItem[] = []
        for (const ep of endpoints) {
            const res = await this.simklSearch(ep, query)
            if (res && res.length > 0) {
                items = res
                break
            }
        }
        if (items.length === 0) return []

        const best = this.pickBest(items, opts)
        if (!best) return []
        const bestSimklId = best?.ids?.simkl_id ?? best?.ids?.simkl
        if (!bestSimklId && !this.tmdbOf(best, "anime")) return []

        // Resolve a tmdb id (search results sometimes omit it for season splits).
        let tmdb = this.tmdbOf(best, "anime")
        if (!tmdb && bestSimklId) {
            const detail = await this.simklDetail("anime", bestSimklId)
            tmdb = detail ? this.tmdbOf(detail, "anime") : ""
        }
        if (!tmdb) return []

        const isMovie = this.isMovieItem(best)
        if (isMovie) {
            return [{
                id: `movie:${tmdb}`,
                title: this.str(best.title_en || best.title),
                url: `movie:${tmdb}`,
                subOrDub: "sub",
            }]
        }

        // TV/anime: determine which season this AniList entry corresponds to.
        const season = await this.determineSeason(tmdb, best, opts)
        const id = season > 0 ? `tv:${tmdb}:${season}` : `tv:${tmdb}`
        return [{
            id,
            title: this.str(best.title_en || best.title),
            url: id,
            subOrDub: "sub",
        }]
    }

    // Picks the SIMKL item that best matches the AniList media: exact year
    // first, then exact episode count.
    private pickBest(items: SimklItem[], opts: SearchOptions): SimklItem {
        let ranked = [...items]
        const year = opts.year
        if (year) {
            const byYear = ranked.filter((i) => i.year === year)
            if (byYear.length > 0) ranked = byYear
        }
        const ec = opts.media?.episodeCount
        if (ec && ec > 0) {
            const byCount = ranked.filter((i) => i.ep_count === ec)
            if (byCount.length > 0) ranked = byCount
        }
        return ranked[0]
    }

    private isMovieItem(item: SimklItem): boolean {
        const t = String(item?.type || item?.endpoint_type || "").toLowerCase()
        return t === "movie" || t === "movies"
    }

    private parseSeasonFromTitle(title: string): number {
        const t = String(title || "")
        let m = t.match(/[Ss]eason\s*(\d+)/i)
        if (m) return Number(m[1])
        m = t.match(/\b[Ss](\d{1,2})\b/)
        if (m) return Number(m[1])
        return 0
    }

    // Determines the vidsrc season (1-based) for the matched SIMKL item by
    // matching the item's episode count against the eps map, then falling back
    // to parsing the season from the item title. Returns 0 when unknown (all
    // seasons flattened).
    private async determineSeason(tmdb: string, item: SimklItem, opts: SearchOptions): Promise<number> {
        const data = await this.vidsrcEps("tv", tmdb)
        const eps = data?.eps
        if (!eps || Object.keys(eps).length === 0) return 0

        const counts: Record<number, number> = {}
        for (const [s, list] of Object.entries(eps)) counts[Number(s)] = (list || []).length

        const itemCount = Number(item?.ep_count)
        if (itemCount > 0) {
            const matches = Object.entries(counts).filter(([, c]) => c === itemCount)
            if (matches.length === 1) return Number(matches[0][0])
        }

        const byTitle = this.parseSeasonFromTitle(item?.title || item?.title_en || "")
        if (byTitle > 0 && counts[byTitle] !== undefined) return byTitle

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

        // TV: fetch the eps map (season -> episode numbers) for this tmdb id.
        const data = await this.vidsrcEps("tv", parsed.tmdb)
        const eps = data?.eps
        if (!eps || Object.keys(eps).length === 0) return []

        const seasonKeys = Object.keys(eps).map(Number).sort((a, b) => a - b)
        const episodes: EpisodeDetails[] = []

        // A specific season was determined for this entry: return its episodes
        // numbered 1..N matching the AniList entry's episode list.
        if (parsed.season && parsed.season > 0) {
            const epNums = (eps[String(parsed.season)] || [])
                .map(Number)
                .filter((n) => Number.isFinite(n) && n > 0)
                .sort((a, b) => a - b)
            for (let i = 0; i < epNums.length; i++) {
                episodes.push({
                    id: `tv:${parsed.tmdb}:${parsed.season}:${epNums[i]}`,
                    number: i + 1,
                    url: `${parsed.season}:${epNums[i]}`,
                    title: `Episode ${i + 1}`,
                })
            }
            return episodes
        }

        // Unknown season: flatten all seasons into continuous absolute numbers.
        let number = 0
        for (const season of seasonKeys) {
            const epNums = (eps[String(season)] || [])
                .map(Number)
                .filter((n) => Number.isFinite(n) && n > 0)
                .sort((a, b) => a - b)
            for (const epNum of epNums) {
                number++
                episodes.push({
                    id: `tv:${parsed.tmdb}:${season}:${epNum}`,
                    number,
                    url: `${season}:${epNum}`,
                    title: `Episode ${number}`,
                })
            }
        }

        return episodes
    }

    // ---------------------------------------------------------------- findEpisodeServer

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        // Recover the search-result id from the episode id (first segment = vidsrc type:tmdb).
        const meta = this.metaFromEpisode(episode)
        if (!meta) {
            throw new Error("vidsrc: could not determine media from episode")
        }

        const { type, tmdb, season, epNum } = meta
        const full = await this.vidsrcRequestFull(type, tmdb, season, epNum)
        const data = full?.data
        const blobB64 = data?.stream_urls

        if (!blobB64) {
            throw new Error("vidsrc: no stream_urls returned")
        }

        // Fetch the wasm whose data-section bytes form the XOR key.
        const wasmUrl = full?.vs?.wasm_url
        const wasm = wasmUrl ? await this.fetchBytes(wasmUrl) : null
        if (!wasm || wasm.length === 0) {
            throw new Error("vidsrc: failed to fetch wasm")
        }

        const urls = this.decryptUrls(wasm, blobB64)
        if (!urls || urls.length === 0) {
            throw new Error("vidsrc: failed to decrypt stream urls")
        }

        const master = urls[0]
        const token = await this.fetchToken(master)
        const finalUrl = token ? `${master}?token=${encodeURIComponent(token)}` : master

        return {
            server: "vidsrc",
            // Non-empty headers route playback through seanime's /api/v1/proxy
            // (which fetches upstream server-side). The vidsrc segment CDN
            // rejects requests carrying an Origin or Referer header, so direct
            // browser playback fails with 403; proxying avoids both.
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" },
            videoSources: [{
                url: finalUrl,
                type: "m3u8",
                quality: "auto",
                subtitles: [],
            }],
        }
    }

    private metaFromEpisode(episode: EpisodeDetails): { type: "tv" | "movie"; tmdb: string; season: number; epNum: number } | null {
        // Episode ids are:
        //   movie: `${tmdb}:1`        -> movie:<tmdb>:1
        //   tv:    `${tmdb}:${season}:${epNum}` -> tv:<tmdb>:<season>:<epNum>
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
        // Fallback: parse from url `${season}:${epNum}` with tmdb from id.
        const urlParts = String(episode?.url || "").split(":")
        const season = Number(urlParts[0])
        const epNum = Number(urlParts[1])
        return {
            type: "tv",
            tmdb: idParts[0],
            season: Number.isFinite(season) && season > 0 ? season : 1,
            epNum: Number.isFinite(epNum) && epNum > 0 ? epNum : 1,
        }
    }

    private parseId(id: string): { type: "tv" | "movie"; tmdb: string; season: number } | null {
        const m = String(id || "").match(/^(tv|movie):(\d+)(?::(\d+))?$/)
        if (!m) return null
        const season = m[3] ? Number(m[3]) : 0
        return { type: m[1] === "movie" ? "movie" : "tv", tmdb: m[2], season: Number.isFinite(season) && season > 0 ? season : 0 }
    }

    private async vidsrcRequestFull(type: "tv" | "movie", tmdb: string, s: number, e: number): Promise<VidsrcResponse | null> {
        const params = type === "movie"
            ? `type=movie&tmdb=${tmdb}&stream_urls=1`
            : `type=tv&tmdb=${tmdb}&s=${s}&e=${e}&stream_urls=1`
        try {
            const res = await fetch(`${VIDSRC_API}?${params}`)
            if (!res.ok) return null
            return res.json() as unknown as VidsrcResponse
        } catch {
            return null
        }
    }

    private async vidsrcRequest(type: "tv" | "movie", tmdb: string, s: number, e: number): Promise<VidsrcData | null> {
        const full = await this.vidsrcRequestFull(type, tmdb, s, e)
        return full?.data ?? null
    }

    // Fetches only the episode map (no stream_urls) for TV episode listing.
    private async vidsrcEps(type: "tv", tmdb: string): Promise<VidsrcData | null> {
        try {
            const res = await fetch(`${VIDSRC_API}?type=tv&tmdb=${tmdb}&s=1&e=1`)
            if (!res.ok) return null
            return (res.json() as unknown as VidsrcResponse)?.data ?? null
        } catch {
            return null
        }
    }

    private async fetchBytes(url: string): Promise<Uint8Array | null> {
        // wasm.php can intermittently return an empty body under rapid requests;
        // retry a few times with a small delay.
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
                if (!res.ok) continue
                // Response body is a Go []byte exposed as an array-like object.
                const arr = Uint8Array.from(res.body as any)
                if (arr.length > 0) return arr
            } catch {
                // fall through to retry
            }
            if (attempt < 3) {
                await this.sleep(500)
            }
        }
        return null
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(), ms)
            // Timer kept reachable for environments that need it.
            void timer
        })
    }

    // ---------------------------------------------------------------- decryption

    // Decrypts a vidsrc stream_urls blob (base64 ChaCha20 IETF) into a list of
    // plaintext URLs by brute-forcing the 32-byte key across all data-segment
    // pairs. The wasm data section is not strictly required (the blob key is
    // derived by XOR of two 32-byte data segments inside the wasm), so we accept
    // the wasm bytes optionally; if unavailable we return null.
    private decryptUrls(wasm: Uint8Array | null, blobB64: string): string[] | null {
        let segs: { offset: number; bytes: Uint8Array }[]
        if (wasm && wasm.length > 8) {
            segs = this.parseDataSegments(wasm)
        } else {
            // If we couldn't fetch wasm, there's nothing to derive the key from.
            return null
        }

        const blob = this.base64ToBytes(blobB64)
        const nonce = blob.subarray(0, 12)
        const ct = blob.subarray(12)

        for (let i = 0; i < segs.length; i++) {
            for (let j = i + 1; j < segs.length; j++) {
                const a = segs[i].bytes
                const b = segs[j].bytes
                if (a.length < 32 || b.length < 32) continue
                const key = new Uint8Array(32)
                for (let k = 0; k < 32; k++) key[k] = a[k] ^ b[k]
                const plain = this.chachaXor(key, 0, nonce, ct)
                const txt = this.decodeUtf8(plain)
                if (/https?:\/\//.test(txt) || /m3u8|\.mp4/.test(txt)) {
                    const urls = txt.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
                    if (urls.length > 0) return urls
                }
            }
        }
        return null
    }

    // ---------------------------------------------------------------- WASM MVP parser

    private readUleb(buf: Uint8Array, off: number): [number, number] {
        let r = 0, s = 0
        for (;;) {
            const b = buf[off++]
            r |= (b & 0x7f) << s
            if (!(b & 0x80)) return [r, off]
            s += 7
        }
    }

    private parseDataSegments(buf: Uint8Array): { offset: number; bytes: Uint8Array }[] {
        const segs: { offset: number; bytes: Uint8Array }[] = []
        let off = 8
        while (off < buf.length) {
            const sid = buf[off++]
            let size: number
            ;[size, off] = this.readUleb(buf, off)
            if (sid === 11) {
                let cnt: number
                ;[cnt, off] = this.readUleb(buf, off)
                for (let i = 0; i < cnt; i++) {
                    const flag = buf[off++]
                    let offset = -1
                    if (flag === 0) {
                        const op = buf[off++]
                        if (op === 0x41) {
                            let v: number
                            ;[v, off] = this.readUleb(buf, off)
                            offset = v
                            off++
                        } else if (op === 0x42) {
                            let v: number
                            ;[v, off] = this.readUleb(buf, off)
                            offset = v
                            off++
                        }
                    } else if (flag === 2) {
                        let m: number
                        ;[m, off] = this.readUleb(buf, off)
                        const op = buf[off++]
                        if (op === 0x41) {
                            let v: number
                            ;[v, off] = this.readUleb(buf, off)
                            offset = v
                            off++
                        }
                    }
                    let len: number
                    ;[len, off] = this.readUleb(buf, off)
                    segs.push({ offset, bytes: buf.slice(off, off + len) })
                    off += len
                }
                break
            }
            off += size
        }
        return segs
    }

    // ---------------------------------------------------------------- ChaCha20 (IETF)

    private rotl(x: number, n: number): number {
        return ((x << n) | (x >>> (32 - n))) >>> 0
    }

    private QR(x: Uint32Array, a: number, b: number, c: number, d: number): void {
        x[a] = (x[a] + x[b]) >>> 0; x[d] = this.rotl(x[d] ^ x[a], 16)
        x[c] = (x[c] + x[d]) >>> 0; x[b] = this.rotl(x[b] ^ x[c], 12)
        x[a] = (x[a] + x[b]) >>> 0; x[d] = this.rotl(x[d] ^ x[a], 8)
        x[c] = (x[c] + x[d]) >>> 0; x[b] = this.rotl(x[b] ^ x[c], 7)
    }

    private chachaBlock(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
        const st = new Uint32Array(16)
        const c = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]
        for (let i = 0; i < 4; i++) st[i] = c[i]
        for (let i = 0; i < 8; i++) {
            st[4 + i] = ((key[4 * i] | (key[4 * i + 1] << 8) | (key[4 * i + 2] << 16) | (key[4 * i + 3] << 24)) >>> 0)
        }
        st[12] = counter >>> 0
        for (let i = 0; i < 3; i++) {
            st[13 + i] = ((nonce[4 * i] | (nonce[4 * i + 1] << 8) | (nonce[4 * i + 2] << 16) | (nonce[4 * i + 3] << 24)) >>> 0)
        }

        const x = new Uint32Array(st)
        for (let i = 0; i < 10; i++) {
            this.QR(x, 0, 4, 8, 12); this.QR(x, 1, 5, 9, 13); this.QR(x, 2, 6, 10, 14); this.QR(x, 3, 7, 11, 15)
            this.QR(x, 0, 5, 10, 15); this.QR(x, 1, 6, 11, 12); this.QR(x, 2, 7, 8, 13); this.QR(x, 3, 4, 9, 14)
        }
        const out = new Uint8Array(64)
        for (let i = 0; i < 16; i++) {
            const v = (x[i] + st[i]) >>> 0
            out[4 * i] = v & 0xff; out[4 * i + 1] = (v >>> 8) & 0xff; out[4 * i + 2] = (v >>> 16) & 0xff; out[4 * i + 3] = (v >>> 24) & 0xff
        }
        return out
    }

    private chachaXor(key: Uint8Array, counter: number, nonce: Uint8Array, data: Uint8Array): Uint8Array {
        const out = new Uint8Array(data.length)
        let c = counter
        for (let off = 0; off < data.length; off += 64) {
            const block = this.chachaBlock(key, c, nonce)
            const n = Math.min(64, data.length - off)
            for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ block[i]
            c = (c + 1) >>> 0
        }
        return out
    }

    // ---------------------------------------------------------------- byte helpers

    private base64ToBytes(b64: string): Uint8Array {
        // goja_nodejs Buffer supports base64; avoids needing global atob/btoa.
        return Uint8Array.from((Buffer as any).from(b64, "base64"))
    }

    // Minimal UTF-8 decoder (goja lacks TextDecoder). Decrypted URLs are ASCII,
    // so we handle ASCII fast-path plus a conservative UTF-8 fallback.
    private decodeUtf8(bytes: Uint8Array): string {
        let out = ""
        let i = 0
        while (i < bytes.length) {
            const b = bytes[i]
            if (b < 0x80) {
                out += String.fromCharCode(b)
                i++
            } else {
                // Accumulate UTF-8 sequence and decode via Buffer to be safe.
                let len = 1
                if (b >= 0xc0 && b < 0xe0) len = 2
                else if (b >= 0xe0 && b < 0xf0) len = 3
                else if (b >= 0xf0) len = 4
                else len = 1
                const chunk = bytes.slice(i, Math.min(i + len, bytes.length))
                try {
                    out += (Buffer as any).from(chunk).toString("utf8")
                } catch {
                    out += String.fromCharCode(b)
                }
                i += len
            }
        }
        return out
    }

    private async fetchToken(masterUrl: string): Promise<string> {
        try {
            const origin = new URL(masterUrl).origin
            const res = await fetch(`${origin}/generate.php`)
            if (!res.ok) return ""
            const t = (res.text() as any)
            const ts = typeof t === "string" ? t : String(t || "")
            return ts.trim() && !ts.startsWith("<") ? ts.trim() : ""
        } catch {
            return ""
        }
    }
}
