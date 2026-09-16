# archive-mcp

Internet Archive için yerel MCP sunucusu (stdio, Node ≥ 20, bağımlılık: `@modelcontextprotocol/sdk`, `zod`). Yalnız okuma yapar; tek istisna `wayback_save` (Save Page Now).

Kaynak belgeler: [Wayback API](https://archive.org/help/wayback_api.php) · [CDX server](https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server) · [Metadata read](https://archive.org/developers/md-read.html) · [Search](https://archive.org/help/aboutsearch.htm) · [Bot kuralları](https://archive.org/developers/bots.html)

## Araçlar
| Araç | Uç nokta | Ne yapar |
|---|---|---|
| `wayback_available` | `archive.org/wayback/available` | Verilen zamana en yakın tek kopya |
| `wayback_cdx` | `web.archive.org/cdx/search/cdx` | Kopya listesi: matchType, from/to, filter, collapse, limit/offset |
| `wayback_fetch` | `web.archive.org/web/{ts}id_/{url}` | Arşiv kopyasını indirir; HTML→düz metin, `raw` ile ham |
| `wayback_save` | `web.archive.org/save/{url}` | **Yazar**: yeni kopya oluşturur |
| `ia_search` | `archive.org/advancedsearch.php` | Lucene sorgusu, sayfalı (≤10 000) |
| `ia_scrape` | `services/search/v1/scrape` | İmleçli derin tarama / yalnız sayım |
| `ia_metadata` | `archive.org/metadata/{id}[/alt yol]` | Öğe metadata'sı |
| `ia_files` | `metadata/{id}/files` | Dosya listesi + indirme adresleri |
| `ia_read_file` | `archive.org/download/{id}/{file}` | Metin dosyası (ör. `_djvu.txt` OCR) parça parça |
| `archive_status` | — | Ayarlar, önbellek, canlı ping |

## Ortam değişkenleri
`IA_MIN_INTERVAL_MS` (500) · `IA_MAX_RETRIES` (3) · `IA_TIMEOUT_MS` (30000) · `IA_DEADLINE_MS` (45000, MCP'nin 60 sn sınırının altında) · `IA_CACHE_TTL_MS` (30 dk) · `IA_USER_AGENT` · `IA_BASE` / `WAYBACK_BASE` (test için).

## Bilinen sunucu tarafı sınırlar (2026-09-17 ölçüldü)
- CDX `collapse=…` → anında 503 "Temporarily Offline". Sunucu bunu yeniden denemeden hemen bildirir.
- CDX `from/to` sorguları 30–56 sn sürüyor ya da aralıklı 503 veriyor (küçük sitelerde bile; curl ile 44 sn ölçüldü). `matchType=prefix` + `limit` sorguları < 1 sn. Sunucu bakım sayfasında bir kez yeniden dener, sonra açık hata döner. Testte bu vaka `CDX_RANGE=1` ile açılır.
- Anonim Save Page Now hız sınırlıdır.

## Test
```sh
npm test                 # canlı duman testi (ağ); SAVE=1 ile wayback_save de çalışır
npm run test:lifecycle   # yetim süreç testi (ağ gerekmez)
```
