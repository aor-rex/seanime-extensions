/// <reference path="../manga-provider.d.ts" />
/// <reference path="../core.d.ts" />

// BatCave
//
// Manga provider reading source for https://batcave.biz (English comics).
//
// batcave.biz is protected by the "DLE-Guard" challenge (a deterministic
// SHA-256 proof-of-work). The runtime has no browser/WebView, so this
// extension solves the challenge itself:
//
//   1. GET  /comix/            -> 302 to /_c?t=<token>&u=<target>
//   2. POST /_v  (form body)   -> 200, sets __guard_trust cookie
//   3. Retry the original URL carrying __guard_trust
//
// The proof-of-work is a brute-force over a nonce:
//     find nonce where sha256(token + ":" + nonce) starts with "00"
//
// The chapter image CDN does NOT require the trust cookie:
//   - img.batcave.biz only needs Referer: https://batcave.biz/
// Chapter pages are read from the reader page's inline __DATA__.images
// (anonymous readers get rdr_ajax:false, so the page already embeds every
// image URL). The legacy chapter API (reader/getChapterData) is not used.

function sha256hex(msg: string): string {
	const K = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221,
		3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401,
		4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349,
		2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372,
		1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771,
		3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571,
		1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474,
		2756734187, 3204031479, 3329325298]
	const h = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]
	const data: number[] = []
	for (let i = 0; i < msg.length; i++) data.push(msg.charCodeAt(i) & 0xff)
	const bitLen = data.length * 8
	data.push(0x80)
	while (data.length % 64 !== 56) data.push(0)
	const hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0
	data.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)

	let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
	const w = new Array(64)
	for (let i = 0; i < data.length; i += 64) {
		for (let t = 0; t < 16; t++) {
			w[t] = ((data[i + 4 * t] << 24) | (data[i + 4 * t + 1] << 16) | (data[i + 4 * t + 2] << 8) | (data[i + 4 * t + 3])) >>> 0
		}
		for (let t = 16; t < 64; t++) {
			const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3)
			const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10)
			w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
		}
		let A = a, B = b, C = c, D = d, E = e, F = f, G = g, H = hh
		for (let t = 0; t < 64; t++) {
			const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7))
			const ch = (E & F) ^ (~E & G)
			const temp1 = (H + S1 + ch + K[t] + w[t]) >>> 0
			const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10))
			const maj = (A & B) ^ (A & C) ^ (B & C)
			const temp2 = (S0 + maj) >>> 0
			H = G; G = F; F = E; E = (D + temp1) >>> 0; D = C; C = B; B = A; A = (temp1 + temp2) >>> 0
		}
		a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0
		e = (e + E) >>> 0; f = (f + F) >>> 0; g = (g + G) >>> 0; hh = (hh + H) >>> 0
	}
	const toHex = (n: number) => n.toString(16).padStart(8, "0")
	return toHex(a) + toHex(b) + toHex(c) + toHex(d) + toHex(e) + toHex(f) + toHex(g) + toHex(hh)
}

const BATCAVE_BASE = "https://batcave.biz"
const IMG_REFERER = "https://batcave.biz/"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
const TRUST_KEY = "batcave.trust"

type ChaptersData = {
	news_id: number
	xhash: string
	chapters: { id: string | number; posi: number; title: string; date: string }[]
}

type ReaderData = {
	news_id: number
	chapter_id: number
	pages?: number
	rdr_ajax?: boolean
	images?: string[]
	chapters?: { id: number; title: string }[]
}

class Provider implements MangaProvider {
	getSettings(): Settings {
		const settings = { supportsAnime: false, supportsManga: true } as Settings & { supportsMultiLanguage?: boolean }
		settings.supportsMultiLanguage = false
		return settings
	}

	private get trustCookie(): string {
		const v = $store.get<string>(TRUST_KEY)
		return v || ""
	}

	private set trustCookie(v: string) {
		$store.set(TRUST_KEY, v || "")
	}

	// ---------------------------------------------------------------- types

	// The TS DOM lib always wins over core.d.ts here, so `fetch` returns a
	// DOM Response type. At runtime the goja binding returns FetchResponse
	// (sync text(), cookies map, ...). This helper restores the right type.
	private async _req(url: string, options?: FetchOptions): Promise<FetchResponse> {
		const res = await fetch(url, options as any)
		return (res as unknown) as FetchResponse
	}

	// ---------------------------------------------------------------- guard

	// Enforces requests to the HTML site through the trust cookie,
	// automatically solving the DLE-Guard proof-of-work when challenged.
	private async _html(url: string, redirect = "follow"): Promise<FetchResponse> {
		const headers: Record<string, string> = {
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		}
		const trust = this.trustCookie
		if (trust) headers.Cookie = trust

		// Probe with manual redirects so a DLE-Guard 302 -> /_c is not followed
		// blindly (following it without the __guard_token cookie yields the bot page).
		let res = await this._req(url, { headers, redirect: "manual" })

		for (let i = 0; i < 5; i++) {
			if (res.status < 300 || res.status >= 400) break
			const loc = this._loc(res)
			if (!loc) break
			if (loc.startsWith("/_c")) {
				await this._solveGuard(loc)
			}
			// Retry the original URL (or any non-guard redirect target) with follow,
			// carrying the trust cookie now available.
			const target = loc.startsWith("http") ? loc : BATCAVE_BASE + loc
			const retryHeaders: Record<string, string> = {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			}
			if (this.trustCookie) retryHeaders.Cookie = this.trustCookie
			res = await this._req(loc.startsWith("/_c") ? url : target, { headers: retryHeaders, redirect: "follow" })
		}

		if (res.status >= 300 && res.status < 400) throw new Error("BatCave: DLE-Guard challenge failed")
		if (!res.ok) throw new Error(`BatCave: request failed with status ${res.status}`)
		return res
	}

	private _loc(res: FetchResponse): string {
		const raw = res.rawHeaders["Location"] || res.rawHeaders["location"]
		return (raw && raw[0]) || res.headers["Location"] || res.headers["location"] || ""
	}

	// Solves the DLE-Guard challenge for a /_c?t=<token> location and stores
	// the resulting __guard_trust cookie for subsequent requests.
	private async _solveGuard(location: string): Promise<void> {
		const t = (location.match(/[?&]t=([^&]+)/) || [])[1]
		if (!t) throw new Error("BatCave: challenge location missing token")

		const token = decodeURIComponent(t)
		let nonce = 0
		let hash = ""
		for (;;) {
			const h = sha256hex(token + ":" + nonce)
			if (h.startsWith("00")) {
				hash = h
				break
			}
			nonce++
		}

		const body = [
			`token=${encodeURIComponent(token)}`,
			"mode=modern",
			"workTime=15",
			`iterations=${nonce + 1}`,
			"hasCrypto=1",
			`pow_nonce=${nonce}`,
			`pow_hash=${hash}`,
			"webdriver=0",
			"touch=0",
			"screen_w=1920",
			"screen_h=1080",
			"screen_cd=24",
			"tz=120",
			"dpr=1",
			"cdp=0",
			"cdpf=",
		].join("&")

		const res = await this._req(BATCAVE_BASE + "/_v", {
			method: "POST",
			headers: {
				"User-Agent": UA,
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: BATCAVE_BASE,
				Referer: BATCAVE_BASE + "/_c",
				"X-Requested-With": "XMLHttpRequest",
				"Sec-Fetch-Dest": "empty",
				"Sec-Fetch-Mode": "cors",
				"Sec-Fetch-Site": "same-origin",
			},
			body,
		})

		const cookies = res.cookies || {}
		const trust = cookies["__guard_trust"]
		if (!trust) throw new Error("BatCave: DLE-Guard did not issue a trust cookie")
		this.trustCookie = `__guard_trust=${trust}`
	}

	// ---------------------------------------------------------------- search

	async search(opts: QueryOptions): Promise<SearchResult[]> {
		const query = (opts.query || "").trim()
		const url = query
			? `${BATCAVE_BASE}/search/${encodeURIComponent(query)}`
			: `${BATCAVE_BASE}/comix/`
		const res = await this._html(url)
		const html = res.text()

		const $ = LoadDoc(html)
		const results: SearchResult[] = []

		$(".readed").each((_, el) => {
			const titleEl = el.find(".readed__title a").first()
			const url = titleEl.attr("href") || el.find(".readed__img").first().attr("href") || ""
			if (!url) return
			const title = titleEl.text().trim() || ""
			if (!title) return
			const image = el.find(".readed__img img").first().attr("data-src") || el.find(".readed__img img").first().attr("src") || ""
			const yearMatch = title.match(/\((\d{4})[-–—)]/)
			const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined
			results.push({
				id: url,
				title,
				year,
				image: image.startsWith("http") ? image : image ? BATCAVE_BASE + image : undefined,
			})
		})

		return results
	}

	// ------------------------------------------------------------- chapters

	async findChapters(id: string): Promise<ChapterDetails[]> {
		const res = await this._html(id)
		const html = res.text()

		const data = this._extractChapters(html)
		const chapters: ChapterDetails[] = data.chapters.map((chap, i) => {
			const chapterId = String(chap.id)
			const chapterUrl = `${BATCAVE_BASE}/reader/${data.news_id}/${chapterId}${data.xhash}`
			return {
				id: `${data.news_id}.${chapterId}`,
				url: chapterUrl,
				title: chap.title || `Chapter ${chap.posi}`,
				chapter: String(chap.posi),
				index: i,
				updatedAt: this._toIsoDate(chap.date),
			}
		})

		return chapters
	}

	private _extractChapters(html: string): ChaptersData {
		const data = this._extractData<ChaptersData>(html)
		if (!data || !data.news_id || !data.chapters) throw new Error("BatCave: invalid chapter data")
		return data
	}

	// Pulls the JSON object embedded in a `window.__DATA__ = {...};` inline
	// script. Used by both series pages (chapters) and reader pages (images).
	private _extractData<T>(html: string): T | undefined {
		const marker = "window.__DATA__ ="
		const idx = html.indexOf(marker)
		if (idx === -1) return undefined
		let i = idx + marker.length
		while (i < html.length && /\s/.test(html[i])) i++
		if (html[i] !== "{") return undefined
		let depth = 0
		let inString = false
		let start = i
		for (; i < html.length; i++) {
			const c = html[i]
			if (inString) {
				if (c === "\\") i++
				else if (c === '"') inString = false
				continue
			}
			if (c === '"') inString = true
			else if (c === "{") depth++
			else if (c === "}") {
				depth--
				if (depth === 0) {
					const block = html.substring(start, i + 1)
					try {
						return JSON.parse(block) as T
					} catch {
						return undefined
					}
				}
			}
		}
		return undefined
	}

	// "9.08.2026" (dd.MM.yyyy) -> "2026-08-09"
	private _toIsoDate(date: string): string {
		const m = date.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
		if (!m) return ""
		const [, d, mo, y] = m
		return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`
	}

	// ----------------------------------------------------------------- pages

	async findChapterPages(id: string): Promise<ChapterPage[]> {
		const sep = id.indexOf(".")
		const newsId = id.substring(0, sep)
		const chapterId = id.substring(sep + 1)

		// Anonymous readers get rdr_ajax:false, so the reader page already
		// embeds every image URL in window.__DATA__.images.
		const res = await this._html(`${BATCAVE_BASE}/reader/${newsId}/${chapterId}`)
		const html = res.text()
		const data = this._extractData<ReaderData>(html)
		const images = (data && data.images) || []
		if (!images.length) throw new Error("BatCave: reader page missing images")

		return images.map((img, i) => ({
			url: img.trim(),
			index: i,
			headers: { Referer: IMG_REFERER },
		}))
	}
}