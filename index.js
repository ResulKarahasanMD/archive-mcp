#!/usr/bin/env node
// Internet Archive için MCP sunucusu: Wayback Machine (availability, CDX, arşiv sayfası metni,
// Save Page Now) + archive.org öğeleri (arama, scrape, metadata, dosya listesi, metin dosyası okuma).
// Ev stili: ~/projects/acikkuran-mcp ile aynı iskelet (lib/http.js + yaşam döngüsü).
// Kaynaklar: archive.org/help/wayback_api.php, github.com/internetarchive/wayback (cdx-server),
// archive.org/developers/{md-read,bots}.html, archive.org/help/aboutsearch.htm
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IA, WB, UA, MIN_INTERVAL, MAX_RETRIES, DEADLINE_MS, stats, IaError, buildUrl, fetchRaw, getJson, htmlToText } from "./lib/http.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const text = (s) => ({ content: [{ type: "text", text: s }] });
const safe = (fn) => async (args) => {
  try { return await fn(args); }
  catch (e) { return { isError: true, content: [{ type: "text", text: `Hata: ${e.message}` }] }; }
};

const TS_DESC = "Wayback zaman damgası, 1–14 hane YYYYMMDDhhmmss (ör. '2006', '20130919', '20130919044612'). Yalnız yıl verilirse 1 Temmuz, yıl+ay verilirse ayın 15'i hedeflenir (en yakın kopya döner).";
const URL_DESC = "Hedef adres; şema isteğe bağlı (ör. 'example.com' veya 'https://example.com/path').";
// Wayback kısa damgayı (ör. "2021") dönemin BAŞINA yakın sayar ve önceki yıla kayabilir;
// yıl → 1 Temmuz, yıl+ay → ayın 15'i olarak tamamlayıp dönemin içinden bir kopya hedefleriz.
const padTs = (t) => !t ? t : t.length === 4 ? `${t}0701` : t.length === 6 ? `${t}15` : t;
const fmtTs = (t) => t && t.length >= 8 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}${t.length >= 14 ? ` ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}` : ""}` : t;
const kb = (n) => n == null || Number.isNaN(n) ? "?" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const server = new McpServer({ name: "archive", version: "0.1.0" });

/* ================= 1) Wayback availability ================= */
server.registerTool(
  "wayback_available",
  {
    title: "Wayback: arşivde var mı?",
    description:
      "Bir URL'nin Wayback Machine'de arşivli olup olmadığını ve verilen zamana EN YAKIN tek kopyayı döner " +
      "(archive.org/wayback/available). Hızlı 'var mı/yok mu' kontrolü için; tüm kopyaları listelemek için wayback_cdx.",
    inputSchema: { url: z.string().describe(URL_DESC), timestamp: z.string().regex(/^\d{1,14}$/).optional().describe(TS_DESC + " Boşsa en yeni kopya.") },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await getJson(buildUrl(IA, "/wayback/available", { url: a.url, timestamp: padTs(a.timestamp) }));
    const c = j?.archived_snapshots?.closest;
    if (!c) return text(`Arşivde kopya yok: ${a.url}${a.timestamp ? ` (istenen zaman: ${a.timestamp})` : ""}. wayback_save ile şimdi arşivlenebilir.`);
    return text([`URL: ${a.url}`, `En yakın kopya: ${fmtTs(c.timestamp)} (ts ${c.timestamp}) · HTTP ${c.status} · available=${c.available}`, `Arşiv adresi: ${c.url}`].join("\n"));
  }),
);

/* ================= 2) Wayback CDX ================= */
server.registerTool(
  "wayback_cdx",
  {
    title: "Wayback: kopya listesi (CDX)",
    description:
      "Wayback CDX sunucusundan bir URL'nin (ya da önek/alan adının) tüm kopyalarını listeler: zaman damgası, MIME, HTTP durumu, " +
      "özet (digest), boyut. Tarih aralığı, durum/MIME süzgeci, tekilleştirme (collapse) ve sayfalama destekler. " +
      "Yoğun arşivlenmiş alan adlarında (from/to ile) 30–45 sn sürebilir; küçük limit ve last=true tercih edin. " +
      "collapse='digest' içerik değişimlerini süzer ama CDX sunucusu bu parametreye bazen 503 döndürür.",
    inputSchema: {
      url: z.string().describe(URL_DESC),
      matchType: z.enum(["exact", "prefix", "host", "domain"]).optional().describe("exact (varsayılan) · prefix: bu yolla başlayan tüm URL'ler · host: bu sunucudaki her şey · domain: alt alan adları dahil"),
      from: z.string().regex(/^\d{4,14}$/).optional().describe("Başlangıç, YYYY[MM[DD…]]"),
      to: z.string().regex(/^\d{4,14}$/).optional().describe("Bitiş, YYYY[MM[DD…]]"),
      filter: z.array(z.string()).optional().describe("Alan süzgeçleri, 'alan:regex' veya '!alan:regex'; ör. ['statuscode:200', 'mimetype:text/html']"),
      collapse: z.string().optional().describe("Tekilleştirme: 'digest' (yalnız içerik değişimleri), 'timestamp:8' (günde bir), 'timestamp:6' (ayda bir), 'urlkey'"),
      limit: z.number().int().min(1).max(1000).optional().describe("En fazla satır (varsayılan 50; negatif için 'last' kullanın)"),
      last: z.boolean().optional().describe("true ise en SON limit kadar kopya (limit=-N)"),
      offset: z.number().int().min(0).optional().describe("Bu kadar satırı atla (sayfalama)"),
      fields: z.array(z.enum(["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"])).optional().describe("Dönecek alanlar; varsayılan hepsi"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const limit = a.limit ?? 50;
    const params = { url: a.url, output: "json", matchType: a.matchType, from: a.from, to: a.to, filter: a.filter, collapse: a.collapse, limit: a.last ? -limit : limit, offset: a.offset, fl: a.fields?.join(",") };
    // CDX yoğun alan adlarında 30–45 sn sürebiliyor (2026-09-17 ölçüm); tek denemeye MCP sınırına (60 sn) kadar süre tanı.
    const r = await fetchRaw(buildUrl(WB, "/cdx/search/cdx", params), { accept: "application/json", timeoutMs: 50000, deadlineMs: 56000, maxRetries: 1 });
    if (r.status >= 400) throw new IaError(`CDX HTTP ${r.status}: ${r.body.slice(0, 300)}`);
    if (!r.body.trim()) return text(`CDX sonucu boş: ${a.url}${a.matchType ? ` (${a.matchType})` : ""}. Süzgeçleri gevşetin ya da wayback_available ile en yakın kopyaya bakın.`);
    let rows; try { rows = JSON.parse(r.body); } catch { throw new IaError(`CDX JSON çözülemedi: ${r.body.slice(0, 200)}`); }
    if (!Array.isArray(rows) || rows.length < 2) return text(`CDX sonucu boş: ${a.url}`);
    const head = rows[0]; const body = rows.slice(1);
    const idx = Object.fromEntries(head.map((h, i) => [h, i]));
    const lines = body.map((row) => {
      const ts = idx.timestamp != null ? row[idx.timestamp] : null;
      const parts = [];
      if (ts) parts.push(fmtTs(ts));
      if (idx.statuscode != null) parts.push(`HTTP ${row[idx.statuscode] || "-"}`);
      if (idx.mimetype != null) parts.push(row[idx.mimetype]);
      if (idx.length != null) parts.push(kb(Number(row[idx.length])));
      if (idx.digest != null) parts.push(`digest ${String(row[idx.digest]).slice(0, 8)}`);
      const orig = idx.original != null ? row[idx.original] : a.url;
      const link = ts ? `${WB}/web/${ts}/${orig}` : orig;
      return `- ${parts.join(" · ")}\n  ${link}`;
    });
    return text(`${body.length} kopya (${a.url}${a.matchType ? `, ${a.matchType}` : ""}${a.collapse ? `, collapse=${a.collapse}` : ""}):\n` + lines.join("\n") +
      (body.length >= limit ? `\n\n(limit=${limit} doldu; offset=${(a.offset ?? 0) + limit} ile devam edin ya da collapse ile azaltın)` : ""));
  }),
);

/* ================= 3) Wayback arşiv sayfası oku ================= */
server.registerTool(
  "wayback_fetch",
  {
    title: "Wayback: arşivlenmiş sayfayı oku",
    description:
      "Bir URL'nin belirli zamandaki arşiv kopyasını web.archive.org'dan indirir ve içeriğini döner. " +
      "Varsayılan olarak HTML'i düz metne çevirir; raw=true ile ham gövde (Wayback'in eklediği araç çubuğu olmadan, 'id_' modu). " +
      "Zaman damgası verilmezse en yeni kopya. Wayback en yakın kopyaya yönlendirir; gerçek zaman damgası çıktıda yazar.",
    inputSchema: {
      url: z.string().describe(URL_DESC),
      timestamp: z.string().regex(/^\d{1,14}$/).optional().describe(TS_DESC),
      raw: z.boolean().optional().describe("true: ham gövde (HTML/JSON/metin), false (varsayılan): düz metin"),
      maxChars: z.number().int().min(500).max(200000).optional().describe("Döndürülecek en fazla karakter (varsayılan 20000)"),
      offset: z.number().int().min(0).optional().describe("Metnin bu karakterinden başla (uzun sayfalarda devam)"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const ts = padTs(a.timestamp) || "2";
    const r = await fetchRaw(`${WB}/web/${ts}id_/${a.url}`, { accept: "*/*", maxBytes: 4 * 1024 * 1024 });
    if (r.status === 404) return text(`Arşivde kopya yok: ${a.url}${a.timestamp ? ` @ ${a.timestamp}` : ""}. wayback_available / wayback_cdx ile kontrol edin.`);
    if (r.status >= 400) throw new IaError(`Wayback HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    const m = /\/web\/(\d{14})/.exec(r.url);
    const actualTs = m?.[1];
    const ctype = r.headers.get("content-type") || "";
    const isHtml = /html|xml/i.test(ctype) || /^\s*<(!doctype|html)/i.test(r.body);
    let full = a.raw || !isHtml ? r.body : htmlToText(r.body);
    if (!a.raw && isHtml && full.length < 400) {
      // İstemci tarafında çizilen uygulama (Next/React/Vue): sunucu HTML'i boş. Varsa gömülü veri bloğunu ekle.
      const nd = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(r.body)?.[1];
      const nuxt = /window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/i.exec(r.body)?.[1];
      full += "\n\n[Not: sunucu HTML'inde çok az metin var; sayfa büyük olasılıkla JavaScript ile çiziliyor (" +
        (nd ? "Next.js" : nuxt ? "Nuxt" : /react|vue|angular|_next|webpack/i.test(r.body) ? "SPA" : "?") +
        "). Arşiv kopyası yalnız iskeleti içerir; içerik için sayfanın çağırdığı API/JSON adreslerini wayback_cdx ile (matchType=prefix) arayın ya da raw=true ile ham HTML'e bakın.]";
      if (nd) full += "\n__NEXT_DATA__: " + nd.slice(0, 3000);
      if (nuxt) full += "\n__NUXT__: " + nuxt.slice(0, 3000);
    }
    const off = a.offset ?? 0, max = a.maxChars ?? 20000;
    const slice = full.slice(off, off + max);
    const hdr = [`Arşiv: ${r.url}`, `Kopya zamanı: ${actualTs ? fmtTs(actualTs) : "?"} · içerik türü: ${ctype || "?"} · ${full.length} karakter${r.truncated ? " (4 MB'ta kesildi)" : ""}${off + max < full.length ? ` · devam için offset=${off + max}` : ""}`].join("\n");
    return text(hdr + "\n\n" + slice);
  }),
);

/* ================= 4) Save Page Now ================= */
server.registerTool(
  "wayback_save",
  {
    title: "Wayback: sayfayı şimdi arşivle",
    description:
      "Save Page Now: verilen URL'nin yeni bir kopyasını Wayback Machine'e kaydettirir (web.archive.org/save/URL). " +
      "Bu bir YAZMA işlemidir (archive.org'da kalıcı kayıt oluşur); kullanıcı açıkça arşivlemek istediğinde kullanın. " +
      "Anonim çağrılar hız sınırlıdır; sonuç yeni kopyanın adresidir.",
    inputSchema: { url: z.string().describe(URL_DESC) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  safe(async (a) => {
    const r = await fetchRaw(`${WB}/save/${a.url}`, { accept: "*/*", noCache: true, maxBytes: 64 * 1024 });
    const loc = r.headers.get("content-location") || r.headers.get("x-archive-orig-location");
    const m = /\/web\/(\d{14})\//.exec(r.url) || /\/web\/(\d{14})\//.exec(loc || "");
    if (r.status >= 400) throw new IaError(`Save Page Now HTTP ${r.status}: ${r.body.slice(0, 300)}`);
    if (!m) return text(`Kayıt isteği gönderildi (HTTP ${r.status}) ama kopya adresi çözülemedi; birkaç saniye sonra wayback_available ile kontrol edin: ${a.url}`);
    return text(`Arşivlendi: ${fmtTs(m[1])} (ts ${m[1]})\n${WB}/web/${m[1]}/${a.url}`);
  }),
);

/* ================= 5) archive.org arama ================= */
const SEARCH_Q_DESC = "Lucene sözdizimi: 'title:(ottoman) AND mediatype:texts', 'creator:\"Evliya Çelebi\"', 'collection:nasa', 'subject:palm pilot', 'date:[1900-01-01 TO 1950-12-31]', 'language:tur'. Alanlar: identifier, title, creator, subject, description, mediatype (texts/movies/audio/software/image/data/web/collection), collection, date, year, language, publisher, downloads.";
const DEFAULT_FIELDS = ["identifier", "title", "creator", "date", "mediatype", "language", "downloads", "item_size"];

function renderDocs(docs) {
  return docs.map((d, i) => {
    const one = (v) => Array.isArray(v) ? v.join("; ") : v;
    const bits = [d.title ? String(one(d.title)) : "(başlıksız)"];
    if (d.creator) bits.push(String(one(d.creator)));
    if (d.date || d.year || d.publicdate) bits.push(String(one(d.date || d.year || d.publicdate)).slice(0, 10));
    if (d.mediatype) bits.push(d.mediatype);
    if (d.language) bits.push(String(one(d.language)));
    if (d.downloads != null) bits.push(`${d.downloads} indirme`);
    if (d.item_size != null) bits.push(kb(Number(d.item_size)));
    const extra = Object.entries(d).filter(([k]) => !["identifier", "title", "creator", "date", "year", "publicdate", "mediatype", "language", "downloads", "item_size"].includes(k))
      .map(([k, v]) => `${k}: ${String(one(v)).slice(0, 300)}`);
    return `${i + 1}. [${d.identifier}] ${bits.join(" · ")}\n   ${IA}/details/${d.identifier}` + (extra.length ? "\n   " + extra.join("\n   ") : "");
  }).join("\n");
}

server.registerTool(
  "ia_search",
  {
    title: "archive.org öğe arama",
    description:
      "archive.org koleksiyonlarında (kitap, film, ses, yazılım, görüntü, veri, web) öğe arar (advancedsearch.php). " +
      "Sayfalı, sıralanabilir; en fazla 10.000 sonuca kadar sayfalanır. Daha derin tarama için ia_scrape. " +
      "Sonuçtaki identifier ile ia_metadata / ia_files çağrılır.",
    inputSchema: {
      q: z.string().min(1).describe(SEARCH_Q_DESC),
      rows: z.number().int().min(1).max(200).optional().describe("Sayfa başına sonuç (varsayılan 20)"),
      page: z.number().int().min(1).optional().describe("Sayfa numarası (1'den başlar)"),
      sort: z.array(z.string()).optional().describe("Sıralama, ör. ['downloads desc'], ['date asc'], ['publicdate desc']"),
      fields: z.array(z.string()).optional().describe("Dönecek metadata alanları; varsayılan: " + DEFAULT_FIELDS.join(", ") + ". Ek olarak description, subject, publisher, collection vb."),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const fields = a.fields?.length ? Array.from(new Set(["identifier", ...a.fields])) : DEFAULT_FIELDS;
    const j = await getJson(buildUrl(IA, "/advancedsearch.php", { q: a.q, "fl[]": fields, rows: a.rows ?? 20, page: a.page ?? 1, "sort[]": a.sort, output: "json" }));
    const resp = j?.response;
    if (!resp) throw new IaError(`beklenmeyen yanıt: ${JSON.stringify(j).slice(0, 300)}`);
    const docs = resp.docs || [];
    if (!docs.length) return text(`Sonuç yok: ${a.q}`);
    const rows = a.rows ?? 20, page = a.page ?? 1;
    return text(`${resp.numFound} sonuç, sayfa ${page} (${docs.length} gösteriliyor) · q=${a.q}\n` + renderDocs(docs) +
      (resp.numFound > page * rows ? `\n\n(devam: page=${page + 1})` : ""));
  }),
);

/* ================= 6) scrape (imleçli derin tarama) ================= */
server.registerTool(
  "ia_scrape",
  {
    title: "archive.org derin tarama (imleçli)",
    description:
      "services/search/v1/scrape: 10.000 sınırı olmadan, imleç (cursor) ile tüm eşleşen öğeleri sırayla getirir. " +
      "Toplu listeleme ve yalnız sayım (totalOnly) için. Küçük aramalarda ia_search yeterlidir.",
    inputSchema: {
      q: z.string().min(1).describe(SEARCH_Q_DESC),
      fields: z.array(z.string()).optional().describe("Dönecek alanlar (varsayılan identifier,title,date,mediatype)"),
      count: z.number().int().min(100).max(10000).optional().describe("İstek başına kayıt (en az 100; varsayılan 100)"),
      cursor: z.string().optional().describe("Önceki yanıttaki cursor"),
      sorts: z.array(z.string()).optional().describe("Sıralama, ör. ['date asc']"),
      totalOnly: z.boolean().optional().describe("true: yalnız toplam sayı"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const fields = a.fields?.length ? Array.from(new Set(["identifier", ...a.fields])) : ["identifier", "title", "date", "mediatype"];
    const j = await getJson(buildUrl(IA, "/services/search/v1/scrape", { q: a.q, fields: fields.join(","), count: a.count ?? 100, cursor: a.cursor, sorts: a.sorts?.join(","), total_only: a.totalOnly ? "true" : undefined }));
    if (a.totalOnly) return text(`Toplam: ${j.total} · q=${a.q}`);
    const items = j.items || [];
    return text(`${j.total} toplam, bu parça ${items.length} · q=${a.q}\n` + renderDocs(items) + (j.cursor ? `\n\n(devam: cursor=${j.cursor})` : "\n\n(son parça)"));
  }),
);

/* ================= 6b) hesap sayfası: yüklemeler / beğeniler ================= */
server.registerTool(
  "ia_account",
  {
    title: "archive.org kullanıcı hesabı (yüklemeler, beğeniler)",
    description:
      "Bir archive.org kullanıcısının (@kullanici) yüklemelerini, beğenilerini (favorites), yorumlarını ya da koleksiyonlarını listeler; " +
      "details/@kullanici/uploads sayfasının kullandığı services/search/beta/page_production uç noktasıdır (belgelenmemiş, site UI'si ile aynı). " +
      "Beğeniler ayrıca ia_search ile 'collection:fav-<kullanici>' sorgusuyla da bulunur; yüklemeler yalnız buradan gelir.",
    inputSchema: {
      user: z.string().min(1).describe("Kullanıcı adı, '@' ile ya da olmadan (ör. '@kuran_mealleri_dip_notlu')"),
      element: z.enum(["uploads", "favorites", "reviews", "collections", "web_archives", "lists"]).optional().describe("Varsayılan uploads"),
      rows: z.number().int().min(1).max(100).optional().describe("Sayfa başına (varsayılan 50)"),
      page: z.number().int().min(1).optional().describe("Sayfa (1'den)"),
      sort: z.string().optional().describe("Sıralama, ör. 'publicdate:desc' (varsayılan), 'downloads:desc', 'titleSorter:asc'"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const user = "@" + a.user.replace(/^@/, "");
    const el = a.element ?? "uploads";
    const rows = a.rows ?? 50, page = a.page ?? 1;
    const j = await getJson(buildUrl(IA, "/services/search/beta/page_production/", {
      page_type: "account_details", page_target: user, page_elements: JSON.stringify([el]), hits_per_page: rows, page, sort: a.sort ?? "publicdate:desc",
    }));
    const hits = j?.response?.body?.page_elements?.[el]?.hits;
    if (!hits) throw new IaError(`beklenmeyen yanıt (${user}/${el}): ${JSON.stringify(j).slice(0, 300)}`);
    const docs = (hits.hits || []).map((h) => h.fields || {});
    if (!docs.length) return text(`${user} · ${el}: kayıt yok${hits.total ? ` (toplam ${hits.total}, sayfa ${page} boş)` : ""}.`);
    return text(`${user} · ${el}: toplam ${hits.total}, sayfa ${page} (${docs.length} gösteriliyor)\n` + renderDocs(docs) +
      (hits.total > page * rows ? `\n\n(devam: page=${page + 1})` : ""));
  }),
);

/* ================= 7) metadata ================= */
server.registerTool(
  "ia_metadata",
  {
    title: "archive.org öğe metadata",
    description:
      "Bir öğenin tam metadata kaydını döner (archive.org/metadata/ID): başlık, yaratıcı, tarih, dil, konu, koleksiyon, açıklama, " +
      "dosya sayısı/boyut, sunucu. Dosya listesi için ia_files daha okunaklıdır. Alt yol ile tek alan alınabilir (ör. 'metadata/title', 'files_count').",
    inputSchema: {
      identifier: z.string().min(1).describe("Öğe kimliği, ör. 'nasa' veya 'evliya-celebi-seyahatname' (details/ sonrası)"),
      subpath: z.string().optional().describe("Yalnız bu alan: 'metadata', 'metadata/description', 'files_count', 'server', 'files/0'"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const path = `/metadata/${encodeURIComponent(a.identifier)}${a.subpath ? "/" + a.subpath.replace(/^\/+/, "") : ""}`;
    const j = await getJson(buildUrl(IA, path, { extended_err: 1 }));
    if (a.subpath) return text(`${a.identifier} · ${a.subpath}:\n` + (typeof j.result === "string" ? j.result : JSON.stringify(j.result ?? j, null, 1)));
    if (j.error) throw new IaError(`${a.identifier}: ${j.error}`);
    if (!j.metadata) return text(`Öğe bulunamadı ya da boş: ${a.identifier}`);
    const m = j.metadata;
    const one = (v) => Array.isArray(v) ? v.join("; ") : String(v ?? "");
    const lines = [`[${a.identifier}] ${one(m.title)}`, `${IA}/details/${a.identifier}`];
    for (const k of ["creator", "date", "year", "language", "mediatype", "collection", "subject", "publisher", "contributor", "licenseurl", "rights", "source", "publicdate", "addeddate", "uploader", "scanner", "ocr", "isbn", "identifier-access"]) {
      if (m[k] != null) lines.push(`${k}: ${one(m[k]).slice(0, 500)}`);
    }
    if (m.description) lines.push(`description: ${htmlToText(one(m.description)).slice(0, 2000)}`);
    lines.push(`files: ${j.files_count ?? j.files?.length ?? "?"} · item_size: ${kb(Number(j.item_size))} · server: ${j.server ?? "?"} · dir: ${j.dir ?? "?"}`);
    const known = new Set(["title", "creator", "date", "year", "language", "mediatype", "collection", "subject", "publisher", "contributor", "licenseurl", "rights", "source", "publicdate", "addeddate", "uploader", "scanner", "ocr", "isbn", "identifier-access", "description", "identifier"]);
    const rest = Object.entries(m).filter(([k]) => !known.has(k)).map(([k, v]) => `${k}: ${one(v).slice(0, 200)}`);
    if (rest.length) lines.push("diğer alanlar:\n  " + rest.join("\n  "));
    return text(lines.join("\n"));
  }),
);

/* ================= 8) dosya listesi ================= */
server.registerTool(
  "ia_files",
  {
    title: "archive.org öğe dosyaları",
    description:
      "Bir öğedeki dosyaları (ad, biçim, boyut, kaynak) ve indirme adreslerini listeler (archive.org/download/ID/dosya). " +
      "format ile süzülebilir (ör. 'Text PDF', 'DjVuTXT', 'JPEG', 'MP3', 'Item Tile'). Metin dosyaları ia_read_file ile okunur.",
    inputSchema: {
      identifier: z.string().min(1).describe("Öğe kimliği"),
      format: z.string().optional().describe("Yalnız bu biçimi/uzantıyı içerenler (büyük-küçük harf duyarsız alt dize; 'pdf', 'txt', 'djvu')"),
      limit: z.number().int().min(1).max(500).optional().describe("En fazla dosya (varsayılan 100)"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const j = await getJson(buildUrl(IA, `/metadata/${encodeURIComponent(a.identifier)}/files`, { extended_err: 1 }));
    let files = j.result || [];
    if (!Array.isArray(files) || !files.length) return text(`Dosya yok ya da öğe bulunamadı: ${a.identifier}`);
    const total = files.length;
    if (a.format) { const f = a.format.toLowerCase(); files = files.filter((x) => (x.format || "").toLowerCase().includes(f) || (x.name || "").toLowerCase().endsWith(f)); }
    const limit = a.limit ?? 100;
    const shown = files.slice(0, limit);
    const lines = shown.map((f) => `- ${f.name} · ${f.format || "?"} · ${kb(Number(f.size))}${f.source === "derivative" ? " · türev" : ""}\n  ${IA}/download/${a.identifier}/${encodeURIComponent(f.name).replace(/%2F/g, "/")}`);
    return text(`${a.identifier}: ${total} dosya${a.format ? `, süzgeç '${a.format}' → ${files.length}` : ""}${files.length > limit ? `, ilk ${limit} gösteriliyor` : ""}\n` + lines.join("\n"));
  }),
);

/* ================= 9) metin dosyası oku ================= */
server.registerTool(
  "ia_read_file",
  {
    title: "archive.org dosya oku (metin)",
    description:
      "Bir öğedeki metin tabanlı dosyayı (txt, DjVuTXT OCR çıktısı, json, csv, xml, html…) indirip içeriğini döner; " +
      "uzun dosyalar offset/maxChars ile parça parça okunur. Kitaplarda OCR metni genellikle '<id>_djvu.txt' dosyasındadır. " +
      "İkili dosyalar (pdf, jpg, mp3) için yalnız adres verin, buradan okumayın.",
    inputSchema: {
      identifier: z.string().min(1).describe("Öğe kimliği"),
      file: z.string().min(1).describe("Dosya adı (ia_files çıktısındaki 'name')"),
      maxChars: z.number().int().min(500).max(200000).optional().describe("En fazla karakter (varsayılan 20000)"),
      offset: z.number().int().min(0).optional().describe("Başlangıç karakteri"),
      htmlToText: z.boolean().optional().describe("HTML ise düz metne çevir (varsayılan true)"),
    },
    annotations: READ_ONLY,
  },
  safe(async (a) => {
    const off = a.offset ?? 0, max = a.maxChars ?? 20000;
    const url = `${IA}/download/${encodeURIComponent(a.identifier)}/${encodeURIComponent(a.file).replace(/%2F/g, "/")}`;
    // Baştan sınırlı okuma: offset+max karakter için ~4 bayt/karakter pay bırak, en çok 8 MB.
    const r = await fetchRaw(url, { accept: "*/*", maxBytes: Math.min(8 * 1024 * 1024, (off + max) * 4 + 65536) });
    if (r.status === 404) return text(`Dosya bulunamadı: ${url}. ia_files ile adı doğrulayın.`);
    if (r.status >= 400) throw new IaError(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    const ctype = r.headers.get("content-type") || "";
    if (/^(image|audio|video|application\/(pdf|zip|octet-stream|x-))/i.test(ctype)) return text(`İkili içerik (${ctype}); metin olarak okunmaz. Adres: ${url}`);
    const isHtml = /html/i.test(ctype) || /\.html?$/i.test(a.file);
    const full = isHtml && a.htmlToText !== false ? htmlToText(r.body) : r.body;
    const slice = full.slice(off, off + max);
    return text(`${url}\n${ctype || "?"} · okunan ${full.length} karakter${r.truncated ? " (kısmi indirme)" : ""}${off + max < full.length ? ` · devam için offset=${off + max}` : ""}\n\n` + slice);
  }),
);

/* ================= 10) durum ================= */
server.registerTool(
  "archive_status",
  {
    title: "Sunucu durumu",
    description: "Kullanılan adresler, User-Agent, hız ayarları, önbellek istatistikleri ve canlı erişim denemesi.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  safe(async () => {
    let live;
    try { const j = await getJson(buildUrl(IA, "/wayback/available", { url: "example.com" })); live = j?.archived_snapshots?.closest ? `OK — example.com en yeni kopya ${fmtTs(j.archived_snapshots.closest.timestamp)}` : "OK (boş yanıt)"; }
    catch (e) { live = `HATA — ${e.message}`; }
    const s = stats();
    return text([
      `archive.org: ${IA} · Wayback: ${WB}`, `User-Agent: ${UA}`,
      `İstek aralığı: ${MIN_INTERVAL} ms · azami yeniden deneme: ${MAX_RETRIES} · çağrı bütçesi: ${DEADLINE_MS} ms`,
      `İstek: ${s.calls} · yeniden deneme: ${s.retries} · önbellek: ${s.cacheHits} isabet / ${s.cacheMisses} ıska (${s.cacheSize} kayıt)`,
      `Canlı ping: ${live}`,
    ].join("\n"));
  }),
);

/* ================= yaşam döngüsü ================= */
// stdio sunucusu istemciye bağımlıdır: istemci ölünce SÜRECİN DE ölmesi gerekir,
// yoksa arka planda yetim node süreçleri birikir. Üç kapanış yolunu da bağlarız.
let closing = false;
const bye = (code = 0) => {
  if (closing) return;
  closing = true;
  Promise.resolve(server.close?.()).catch(() => {}).finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
};
const transport = new StdioServerTransport();
transport.onclose = () => bye(0);
process.stdin.on("end", () => bye(0));
process.stdin.on("close", () => bye(0));
process.stdin.on("error", () => bye(0));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => bye(0));
await server.connect(transport);
