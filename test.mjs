#!/usr/bin/env node
// Canlı duman testi: her aracı gerçek archive.org'a karşı bir kez çağırır (ağ gerekir).
// wayback_save YAZMA yaptığı için yalnız SAVE=1 verildiğinde çalışır.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "index.js")], stderr: "inherit" }));

let fail = 0;
async function call(name, args, expect) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const out = r.content?.[0]?.text ?? "";
  const ok = !r.isError && (!expect || expect.test(out));
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)${ok ? "" : "\n   " + out.slice(0, 400)}`);
  if (process.env.VERBOSE) console.log("   " + out.slice(0, 600).replace(/\n/g, "\n   "));
  return out;
}

const { tools } = await client.listTools();
console.log(`${tools.length} araç: ${tools.map((t) => t.name).join(", ")}`);

await call("wayback_available", { url: "example.com" }, /En yakın kopya/);
await call("wayback_available", { url: "example.com", timestamp: "20060101" }, /2006-01/);
// Not: example.com gibi devasa arşivli adreslerde from/to 30 sn+ sürer; collapse ise 2026-09-17 itibarıyla CDX'te 503 döndürüyor.
await call("wayback_cdx", { url: "acikkuran.com", from: "2020", to: "2022", limit: 5 }, /kopya/);
await call("wayback_cdx", { url: "archive.org/about/", matchType: "prefix", limit: 3, filter: ["statuscode:200"] }, /kopya/);
await call("wayback_fetch", { url: "example.com", timestamp: "2013", maxChars: 800 }, /Example Domain/);
await call("wayback_fetch", { url: "example.com", raw: true, maxChars: 500 }, /<html/i);
await call("ia_search", { q: "collection:nasa AND mediatype:image", rows: 3, sort: ["downloads desc"] }, /sonuç, sayfa 1/);
await call("ia_search", { q: 'creator:"Evliya Çelebi"', rows: 3, fields: ["title", "language", "subject"] }, /sonuç|Sonuç yok/);
await call("ia_scrape", { q: "collection:nasa", totalOnly: true }, /Toplam: \d+/);
await call("ia_scrape", { q: "collection:nasa", count: 100 }, /toplam, bu parça 100/);
await call("ia_metadata", { identifier: "nasa" }, /\[nasa\]/);
await call("ia_metadata", { identifier: "nasa", subpath: "metadata/title" }, /NASA/i);
await call("ia_metadata", { identifier: "bu-oge-yok-xyz-123" }, /bulunamadı|Hata/);
await call("ia_files", { identifier: "nasa", limit: 5 }, /dosya/);
// OCR'li bir kitap: americana koleksiyonundan en çok indirilen metin öğesi (kimlik sabitlenmez, canlı seçilir).
const book = await call("ia_search", { q: "collection:americana AND mediatype:texts AND format:DjVuTXT", rows: 1, sort: ["downloads desc"] }, /\[[^\]]+\]/);
const bookId = /\[([^\]]+)\]/.exec(book)?.[1];
const files = await call("ia_files", { identifier: bookId, format: "txt", limit: 3 }, /_djvu\.txt/);
const txt = /^\s*- (\S+_djvu\.txt)/m.exec(files)?.[1];
if (txt) await call("ia_read_file", { identifier: bookId, file: txt, maxChars: 600 }, /okunan \d+ karakter/);
await call("archive_status", {}, /Canlı ping: OK/);
if (process.env.SAVE) await call("wayback_save", { url: "https://example.com/" }, /Arşivlendi|gönderildi/);

await client.close();
console.log(fail ? `\n${fail} başarısız` : "\nhepsi geçti");
process.exit(fail ? 1 : 0);
