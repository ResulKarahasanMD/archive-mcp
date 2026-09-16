// Internet Archive HTTP katmanı: istekleri seri hale getirir, kısa aralık bırakır,
// yanıtları TTL ile önbellekler, 429/5xx için üstel geri çekilme uygular.
// archive.org/developers/bots.html: her otomatik istek tanımlayıcı User-Agent taşımalı,
// 429 + Retry-After'a uyulmalı, yanıtlar önbelleklenmeli.
export const MIN_INTERVAL = Number(process.env.IA_MIN_INTERVAL_MS ?? 500);
export const MAX_RETRIES = Number(process.env.IA_MAX_RETRIES ?? 3);
export const TIMEOUT_MS = Number(process.env.IA_TIMEOUT_MS ?? 30000);
// MCP istemcisi 60 sn sonra çağrıyı düşürür; ondan önce anlaşılır bir hata dönmeliyiz.
export const DEADLINE_MS = Number(process.env.IA_DEADLINE_MS ?? 45000);
const CACHE_TTL_MS = Number(process.env.IA_CACHE_TTL_MS ?? 30 * 60 * 1000);
const CACHE_MAX = 500;
// Test/hata ayıklama için taban adresler değiştirilebilir (test-lifecycle bunu TEST-NET'e yönlendirir).
export const IA = (process.env.IA_BASE || "https://archive.org").replace(/\/+$/, "");
export const WB = (process.env.WAYBACK_BASE || "https://web.archive.org").replace(/\/+$/, "");

export class IaError extends Error {}

const cache = new Map(); // key -> { at, data }
let hits = 0, misses = 0, calls = 0, retries = 0;
export const stats = () => ({ calls, retries, cacheHits: hits, cacheMisses: misses, cacheSize: cache.size });

let lastCall = 0;
let chain = Promise.resolve(); // tüm istekleri tek sıraya dizer
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function throttle() {
  const wait = lastCall + MIN_INTERVAL - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

export const UA = process.env.IA_USER_AGENT || "archive-mcp/0.1.0 (local MCP server for Claude Code; +https://github.com/rak)";

/** Tek istek + 429/5xx için üstel geri çekilme. Dönen: {status, headers, body(text), url(final)} */
async function once(url, { method = "GET", accept = "application/json", maxBytes = 0 } = {}) {
  let backoff = Number(process.env.IA_BACKOFF_MS || 1500);
  const t0 = Date.now();
  const left = () => DEADLINE_MS - (Date.now() - t0);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    calls++;
    let res;
    try {
      res = await fetch(url, { method, headers: { Accept: accept, "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(Math.max(1000, Math.min(TIMEOUT_MS, left()))) });
    } catch (e) {
      const why = [e.message, e.cause?.message, e.cause?.code].filter((x, i, a) => x && a.indexOf(x) === i).join(" ← ");
      const code = e.cause?.code;
      const fatal = code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN";
      if (fatal || attempt === MAX_RETRIES || left() < backoff) {
        throw new IaError(`ağ hatası: ${why} (${attempt + 1}. deneme, ${Math.round((Date.now() - t0) / 1000)} sn, ${url})`);
      }
      retries++; await sleep(backoff); backoff *= 2; continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const body = await res.text().catch(() => "");
      // archive.org bakım sayfası: yeniden denemek yalnız zaman yakar, hemen bildir.
      if (/Temporarily Offline/i.test(body)) {
        throw new IaError(`${res.status}: Internet Archive "Temporarily Offline" bakım sayfası döndü (${new URL(url).host}); servis geçici olarak kapalı, daha sonra yeniden deneyin. CDX sorgularında 'collapse' parametresi bu sayfayı tetikleyebiliyor; collapse olmadan deneyin.`);
      }
      const ra = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff + Math.floor(Math.random() * 500);
      if (attempt === MAX_RETRIES || left() < waitMs + MIN_INTERVAL) {
        throw new IaError(`${res.status} ${res.status === 429 ? "istek sınırı (Wayback/IA hız limiti; biraz bekleyip yeniden deneyin)" : "sunucu hatası"} (${attempt + 1} deneme): ${body.slice(0, 200)}`);
      }
      retries++; await sleep(waitMs); backoff *= 2; continue;
    }
    let body;
    if (maxBytes > 0 && res.body) {
      // Büyük dosyaları baştan kesmek için akışı sınırlı oku.
      const reader = res.body.getReader();
      const chunks = []; let n = 0;
      while (n < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); n += value.length;
      }
      try { await reader.cancel(); } catch {}
      body = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes).toString("utf8");
    } else {
      body = await res.text();
    }
    return { status: res.status, headers: res.headers, body, url: res.url || url, truncated: maxBytes > 0 && body.length >= maxBytes };
  }
}

function run(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

export function buildUrl(base, path, params = {}) {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { for (const x of v) u.searchParams.append(k, String(x)); }
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Ham istek (önbellekli). */
export async function fetchRaw(url, opts = {}) {
  const key = `${opts.method || "GET"} ${url} ${opts.maxBytes || 0}`;
  if (!opts.noCache) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < CACHE_TTL_MS) { hits++; return c.data; }
  }
  misses++;
  const data = await run(() => once(url, opts));
  if (!opts.noCache) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), data });
  }
  return data;
}

/** JSON isteği; 4xx'i IaError'a çevirir. */
export async function getJson(url, opts = {}) {
  const r = await fetchRaw(url, { accept: "application/json", ...opts });
  if (r.status >= 400) throw new IaError(`HTTP ${r.status}: ${r.body.slice(0, 300)}`);
  try { return JSON.parse(r.body); } catch { throw new IaError(`JSON çözülemedi (${url}): ${r.body.slice(0, 200)}`); }
}

/** HTML → düz metin (kaba ama bağımlılıksız). */
export function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
