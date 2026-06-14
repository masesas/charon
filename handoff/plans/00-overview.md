# Implementation Plan — Parameter & Reliability Enhancement (Master Overview)

**Tanggal:** 2026-06-14
**Status:** Draft untuk dieksekusi. Master index — detail per-tier ada di dokumen terpisah.
**Pemilik:** charon agent (main branch)

---

## 0. Mengapa plan ini ada (evidence dari `data/charon.db`)

Audit DB produksi (9171 candidates, 4096 LLM batches, 4 posisi closed) menemukan funnel berikut:

| Tahap | Angka | Catatan |
|---|---|---|
| Candidates dibangun | 9171 | |
| Lolos filter | 1458 (16%) | 7713 difilter |
| LLM batch dijalankan | 4096 | |
| **LLM GAGAL** | **3999 (97.6%)** | `empty_error` tiap hari sejak 23 Mei |
| LLM verdict BUY | 6 | confidence 64–78 |
| Posisi terbuka | 4 | semua dari 2 hari awal saat LLM hidup |
| Exit | 4/4 **SL** | −18.6%, −26.8%, −35.8%, −53.7% |

**Root cause `empty_error` (SUDAH DIKONFIRMASI via probe live):**
Endpoint LLM (`http://localhost:20128/api/v1/chat/completions`) default-nya
mengembalikan **SSE streaming** (`data: {...}` chunks). Kode di `src/pipeline/llm.js`
membaca `res.data?.choices?.[0]?.message?.content` yang hanya valid untuk body
JSON non-streaming. Pada respons streaming, `res.data` = teks SSE mentah →
`choices` undefined → `content = ''` → `JSON.parse('')` throw dengan
`err.message === ''` → tercatat sebagai `"LLM failed: "`.

Probe membuktikan: menambah `stream: false` pada request body →
proxy balas JSON bersih (`object: chat.completion`, `choices[0].message.content`
terisi, `content-type: application/json`). **Fix inti = satu baris (`stream: false`),
sisanya resiliensi supaya kegagalan senyap tidak terulang.**

**Keputusan user:**
- Model di `.env`: `morph-orchestrator` → ganti `my-default` (URL tetap valid).
- Saat LLM gagal: **fallback ke skor deterministik** (bukan diam total).
- Deliverable saat ini: **impl plan doc untuk semua tier** (dipecah karena panjang).

**Implikasi penting:** Auto-tuning (handoff lama Item C Fase 2) **belum bisa** dijalankan —
tidak ada data PnL valid (agent tak pernah benar-benar memutuskan selama 3 minggu).
Plan ini memperbaiki otak agent dulu, lalu mengumpulkan data bersih, baru kalibrasi.

---

## 1. Roadmap aktual (referensi lama sudah usang)

Roadmap referensi user:
```
signal → buildCandidate → filterCandidate → scoreCandidate
   → decideCandidateBatch → checkRiskBeforeBuy
   → refreshCandidateForExecution → executeLiveBuy → monitorPositions 10s → TP/SL/trailing
```

Roadmap nyata (dari `src/pipeline/orchestrator.js` + `src/execution/*`):
```
signal
 → canOpenMorePositions?            (early-exit, hemat enrichment/LLM)
 → buildCandidate ─┬─ filterCandidate
                   └─ scoreCandidate         (scoring DI DALAM buildCandidate)
 → filter gate (passed?)
 → decideCandidateBatch (LLM)        ⚠️ 97% gagal → fallback WATCH (diperbaiki Tier 1)
 → confidence gate: effectiveConfidenceThreshold   ◀ langkah baru vs roadmap lama
 → canOpenMorePositions? (re-check)
 → resolveTierProfile + effectivePositionSizeSol   ◀ tier + sizing modifier
 → checkRiskBeforeBuy (daily-loss / streak / exposure)
 → handleApprovedBuy:
      → refreshCandidateForExecution (fresh data + re-filter + re-score)
      → enforceEntryGuards (Tier-0: risk_gate, price-impact, sellability)  ◀ guard baru
      → createDryRun / createIntent / executeLiveBuy
 → monitorPositions tiap 10s → partialTP → SL/TP/trailing → maxHold
```

Perbedaan utama: (a) scoring bukan langkah terpisah; (b) ada **confidence gate**;
(c) ada **tier routing + sizing modifier**; (d) ada **entry guards Tier-0**;
(e) ada dua kali `canOpenMorePositions`. Roadmap baru ini yang dijadikan acuan.

---

## 2. Pemecahan dokumen (scope tiap tier)

Plan dipecah jadi 3 dokumen tier + overview ini. Tiap dokumen **self-contained**:
punya konteks, scope, file, pseudo-code, default eksplisit, error path, test, dan
audit Layer 1–9.

| Dok | Judul | Scope inti | Risiko | Urutan |
|---|---|---|---|---|
| `01-tier1-llm-resilience.md` | Resiliensi LLM + Fallback Deterministik | Fix `stream:false`, retry+backoff, error surfacing, alert Telegram, fallback skor saat LLM down, ganti model | Sedang (otak agent) | **WAJIB DULU** |
| `02-tier2-adaptive-monitor.md` | Monitor Posisi Adaptif Sub-3s | Fast-lane monitoring posisi muda/dekat-threshold, reentrancy guard, rate-limit aware | Sedang (main loop) | Kedua |
| `03-tier3-param-consistency.md` | Konsistensi Parameter & Knob Learning | Selaraskan `llm_min_confidence`, dokumentasi knob learning, kalibrasi awal konservatif | Rendah | Ketiga |

**Kenapa urutan ini:** Tier 1 memblokir segalanya — tanpa LLM hidup atau fallback,
Tier 2 & 3 menyetel sistem yang tidak mengambil keputusan. Tier 2 menutup kerugian
nyata (4/4 SL, dua > −35%). Tier 3 adalah polish + persiapan kalibrasi setelah data
bersih mengalir.

---

## 3. Parameter yang disentuh (peta lengkap)

### Tier 1 (LLM)
| Param | Lokasi | Sekarang | Usulan | Alasan |
|---|---|---|---|---|
| `stream` (request) | `llm.js` | (absen → SSE) | `false` | **root cause empty_error** |
| `LLM_MODEL` | `.env`/`config.js` | `morph-orchestrator` | `my-default` | instruksi user |
| `llm_max_retries` | setting baru | — | `2` | timeout/5xx transien |
| `llm_retry_backoff_ms` | setting baru | — | `1000` | jeda antar retry |
| `llm_fallback_enabled` | setting baru | — | `true` | aktifkan jalur skor |
| `llm_fallback_min_quality` | setting baru | — | `60` | gate quality_score fallback |
| `llm_fallback_max_risk` | setting baru | — | `45` | gate risk_score fallback |
| `llm_fallback_confidence` | setting baru | — | `55` | confidence sintetis fallback |
| `llm_alert_fail_streak` | setting baru | — | `5` | alert setelah N gagal beruntun |

### Tier 2 (Monitor)
| Param | Lokasi | Sekarang | Usulan | Alasan |
|---|---|---|---|---|
| `POSITION_CHECK_MS` | `config.js` | `10_000` | `10_000` (slow lane tetap) | baseline |
| `POSITION_CHECK_FAST_MS` | `config.js` baru | — | `2500` | sub-3s untuk posisi volatil |
| `POSITION_VOLATILE_AGE_MS` | `config.js` baru | — | `300_000` | posisi < 5 mnt = fast lane |
| `position_fast_near_threshold_pct` | setting baru | — | `8` | dekat SL/TP (±8%) = fast lane |

### Tier 3 (Konsistensi)
| Param | Lokasi | Sekarang | Usulan | Alasan |
|---|---|---|---|---|
| `llm_min_confidence` (setting) | settings | `75` | `65` | LLM jarang tembus 75; selaraskan |
| `llm_min_confidence` (sniper) | strategi | `50` | `65` | hilangkan mismatch strategy↔setting |
| `risk_gate_enabled` | setting | `false` | `false` (doc only) | aktif setelah data |
| `sizing_modifier_enabled` | setting | `false` | `false` (doc only) | aktif setelah data |
| `source_reliability_enabled` | setting | `false` | `false` (doc only) | aktif setelah data |

> Tier 3 knob learning **tetap OFF** — plan hanya mendokumentasikan ambang target &
> prasyarat data; aktivasi bukan bagian eksekusi ini (hindari overfitting 4 sampel).

---

## 4. Konvensi eksekusi (semua tier)

- Per tier: plan → implementasi → `npm run check` (`node --check`) → uji manual di
  **copy DB temp** (jangan sentuh `data/charon.db` 1.5 GB) → code-review agent → fix →
  commit → push → PR → merge → sync main.
- Repo **tak punya test framework** (hanya `node --check`). Verifikasi via skrip manual
  Node + copy DB. Tiap tier mendefinisikan skrip uji sendiri.
- Immutability: update setting/objek via copy, jangan mutasi in-place (lihat rules).
- Default eksplisit: tiap setting baru di-`numSetting/boolSetting(key, DEFAULT)` dengan
  DEFAULT ditulis & dikomentari; nilai netral supaya perilaku lama tak berubah diam-diam.
- Jangan commit: `data/`, `.env`, `.claude/settings.json`, `package-lock.json`.

---

## 5. Urutan kerja & dependency

```
01-tier1 (resiliensi LLM)   ── WAJIB, tidak ada dependency
        │  (agent mulai memutuskan lagi → data bersih mulai terkumpul)
        ▼
02-tier2 (monitor adaptif)  ── independen dari Tier 1 secara kode,
        │                       tapi baru bermakna setelah ada posisi baru
        ▼
03-tier3 (konsistensi)      ── tergantung Tier 1 (kalibrasi confidence butuh LLM hidup)
```

Tier 1 & Tier 2 secara teknis bisa paralel (file berbeda), tapi disarankan Tier 1
dulu agar perbaikan diverifikasi dengan keputusan LLM yang benar-benar jalan.

---

## 6. Definition of Done (master)

- [ ] `01-tier1` selesai: LLM batch sukses > 95% di smoke test live; fallback teruji saat endpoint dimatikan; alert terkirim.
- [ ] `02-tier2`: posisi muda dipantau sub-3s tanpa double-sell; rate-limit aman.
- [ ] `03-tier3`: tak ada mismatch `llm_min_confidence`; doc knob learning + prasyarat data lengkap.
- [ ] Tiap tier: `npm run check` hijau, code-review CRITICAL/HIGH clear, di-push & merge.
- [ ] Handoff diperbarui untuk sesi berikutnya (status tiap tier).

---

## 7. Out of scope (eksplisit)

- Aktivasi knob learning di produksi dengan angka hasil tuning (butuh ≥ N posisi valid pasca Tier 1).
- Per-tier exposure SOL terpisah.
- Streaming-aware LLM parser (kita pakai `stream:false`; parsing SSE inkremental tidak diperlukan).
- Pindah provider LLM (URL tetap; hanya ganti nama model).
- Cleanup `signal_events` (handoff lama Item A) — beda concern; bisa sesi terpisah.
