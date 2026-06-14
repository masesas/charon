# Tier 3 — Konsistensi Parameter & Knob Learning

**Prioritas:** Ketiga (setelah Tier 1; Tier 2 opsional sebelum ini).
**Risiko:** Rendah.
**Dependency:** Tier 1 (kalibrasi `llm_min_confidence` butuh LLM hidup).
**Lihat juga:** `00-overview.md`, `src/pipeline/orchestrator.js` (`effectiveConfidenceThreshold`).

---

## 1. Konteks & Masalah

Dua kelas masalah parameter:

### 1.1 Mismatch `llm_min_confidence` (bug konsistensi)
Ada **tiga sumber** nilai yang tidak sinkron:
- `settings.llm_min_confidence = 75` (tabel settings).
- `strategies.sniper.llm_min_confidence = 50` (config strategi).
- Gate aktual di `orchestrator.js:30` `effectiveConfidenceThreshold` membaca
  `numSetting('llm_min_confidence', 75)` → **pakai 75**, mengabaikan nilai strategi (50).
- Log guardrail `orchestrator.js:171` juga hard-code `numSetting('llm_min_confidence', 75)`.

Dari data: dari 6 verdict BUY, confidence = 64,66,68,72,78,78 → **hanya 2 yang ≥ 75**.
Artinya gate 75 menolak mayoritas sinyal BUY LLM. Nilai 50 di strategi menyesatkan
(tampak longgar padahal gate 75). Perlu **satu sumber kebenaran** + kalibrasi.

### 1.2 Knob learning semua OFF (tanpa dokumentasi aktivasi)
Tiga knob neutral-default belum pernah aktif & belum ada angka untuk mengaktifkan:
- `risk_gate_enabled=false` (+ `risk_score_max_gate=100`)
- `sizing_modifier_enabled=false` (+ `sizing_min/max_multiplier`)
- `source_reliability_enabled=false` (+ `source_reliability_threshold_k=0`, `min_samples=10`)

Tidak boleh diaktifkan dengan tebakan (overfitting 4 sampel). Tier 3 hanya
**mendokumentasikan prasyarat data & ambang target**, bukan mengaktifkan.

---

## 2. Tujuan

1. Hilangkan mismatch `llm_min_confidence` → satu sumber kebenaran, nilai terkalibrasi.
2. Dokumentasikan knob learning: arti, default, prasyarat data, ambang target awal.
3. (Opsional) Tambah perintah/visibilitas agar operator tahu knob mana aktif.

---

## 3. Desain

### 3.1 Satu sumber kebenaran untuk confidence
Pilihan (rekomendasi **A**):

**A. Setting global sebagai sumber, strategi sebagai override opsional.**
- `effectiveConfidenceThreshold` base: gunakan `strat.llm_min_confidence` bila ada,
  fallback `numSetting('llm_min_confidence', DEFAULT)`. Ini menyelaraskan dengan pola
  `strategySetting()` yang sudah ada di `settings.js:78`.
- Set `settings.llm_min_confidence = 65` dan `strategies.sniper.llm_min_confidence = 65`
  → konsisten apa pun jalur baca.
- Perbaiki log guardrail `orchestrator.js:171` agar memanggil
  `effectiveConfidenceThreshold(selectedRow?.candidate)` (atau base yang sama), bukan
  hard-code 75 — supaya log mencerminkan ambang nyata.

**B. (alternatif)** Hapus `llm_min_confidence` dari strategi, settings satu-satunya.
Lebih sederhana tapi mengurangi fleksibilitas per-strategi. **Tidak dipilih.**

### 3.2 Kalibrasi nilai (65)
Default baru `65`:
- Menangkap 4 dari 6 BUY historis (64 tetap ketat ditolak; 66,68,72,78,78 lolos).
- Lebih longgar dari 75 (yang menolak 4/6) tapi lebih ketat dari 50 (yang akan
  meloloskan semua termasuk yang lemah).
- **Bukan angka final** — setelah Tier 1 hidup & data baru mengalir (≥ 30 keputusan
  BUY/PASS dengan PnL), kalibrasi ulang berbasis win-rate per band confidence.
- Catatan: angka ini dipilih dari distribusi 6 sampel → **lemah secara statistik**.
  Didokumentasikan sebagai placeholder konservatif, bukan hasil tuning.

### 3.3 Interaksi dengan fallback Tier 1
`llm_fallback_confidence` (Tier 1, default 55) < `llm_min_confidence` (65) → fallback
default tetap **tidak beli**. Bila operator ingin fallback bisa beli, naikkan
`llm_fallback_confidence ≥ 65` secara sadar. Konsistensi ini dijaga & didokumentasikan.

### 3.4 Dokumentasi knob learning (deliverable utama Tier 3)
Buat `handoff/learning-knobs.md` (atau section di doc ini) berisi tabel:

| Knob | Default | Arti | Prasyarat aktivasi | Ambang target awal (placeholder) |
|---|---|---|---|---|
| `risk_gate_enabled` / `risk_score_max_gate` | false / 100 | Tolak buy bila risk_score ≥ gate | ≥ 30 posisi closed dgn PnL; korelasi risk_score↔PnL terukur | gate ≈ persentil-75 risk_score dari posisi rugi |
| `sizing_modifier_enabled` / `sizing_min,max_multiplier` | false / 0.5,1.0 | Skala size dari quality−risk | validasi quality_score prediktif | mulai band sempit 0.8–1.0 |
| `source_reliability_enabled` / `_threshold_k` / `_min_samples` | false / 0 / 10 | Sesuaikan confidence-threshold per source berdasar win-rate historis | ≥ min_samples per (route,label) | k kecil (≈10) setelah ada ≥10 sampel/source |

Plus prosedur aktivasi bertahap: aktifkan **satu knob**, jalankan dry_run N hari,
bandingkan metrik, baru knob berikut. Hindari aktivasi serempak (tak bisa atribusi efek).

### 3.5 (Opsional) Visibilitas
Tambah ke command status Telegram (`statusCommand.js`) ringkasan knob aktif +
nilai `llm_min_confidence` efektif. Memudahkan operator memverifikasi state.
**Opsional** — bisa ditunda bila ingin scope minimal.

---

## 4. File yang Disentuh

| File | Perubahan |
|---|---|
| `src/pipeline/orchestrator.js` | `effectiveConfidenceThreshold` base pakai `strat.llm_min_confidence ?? numSetting(...)`; log guardrail pakai ambang nyata |
| `src/db/connection.js` | seed/backfill `settings.llm_min_confidence=65`; `strategies.*.llm_min_confidence` selaras (sniper 65) |
| `handoff/learning-knobs.md` | dokumen knob (baru) |
| `src/telegram/statusCommand.js` | (opsional) tampilkan knob aktif |

> Catatan migrasi: setting existing di DB produksi `llm_min_confidence=75`. Backfill
> harus **update nilai existing** (bukan INSERT OR IGNORE) bila kita ingin 65 berlaku.
> Keputusan: ubah via `setSetting('llm_min_confidence', 65)` di blok init **hanya bila
> nilai masih default lama**, atau biarkan operator set manual via Telegram. Pilih:
> **jangan overwrite paksa** nilai operator — seed hanya bila key belum ada; untuk DB
> existing, ubah lewat perintah Telegram/dokumentasi. (Hindari menimpa preferensi user.)

---

## 5. Pseudo-code

```js
// orchestrator.js — effectiveConfidenceThreshold
export function effectiveConfidenceThreshold(candidate) {
  const strat = activeStrategy();
  const base = (strat?.llm_min_confidence != null)
    ? Number(strat.llm_min_confidence)
    : numSetting('llm_min_confidence', 65);          // default selaras 65
  if (!boolSetting('source_reliability_enabled', false)) return base;
  // ... sisanya tak berubah (reliability adj) ...
}

// log guardrail (orchestrator.js ~171) — ganti hard-code 75:
guardrails: {
  agentEnabled: boolSetting('agent_enabled', true),
  confidenceThreshold: selectedRow ? effectiveConfidenceThreshold(selectedRow.candidate)
                                   : numSetting('llm_min_confidence', 65),
  openPositions: openPositionCount(),
  maxOpenPositions: numSetting('max_open_positions', 3),
},
```

---

## 6. Default Values (eksplisit)

| Param | Lama | Baru | Catatan |
|---|---|---|---|
| `settings.llm_min_confidence` | 75 | 65 | seed-if-absent; DB existing via operator |
| `strategies.sniper.llm_min_confidence` | 50 | 65 | selaraskan |
| `effectiveConfidenceThreshold` fallback | 75 | 65 | konsisten |
| knob learning | OFF | OFF | tetap; hanya didokumentasikan |

---

## 7. Error Path & Lifecycle (Layer 3)

- **Strat tanpa `llm_min_confidence`:** `?? numSetting` fallback → tak NaN. ✅
- **Backfill tak menimpa preferensi:** seed-if-absent; DB existing tak di-overwrite paksa. ✅
- **Reliability adj tetap cold-start safe** (kode existing, tak diubah). ✅

---

## 8. Test / Verifikasi

1. **Konsistensi:** dengan strat.llm_min_confidence=65 & setting=65 →
   `effectiveConfidenceThreshold` balik 65 (source_reliability off).
2. **Override strat:** set strat=70, setting=65 → base 70.
3. **Strat null field:** hapus field di strat → fallback ke setting 65.
4. **Log guardrail:** `entry_not_approved` mencatat threshold = nilai efektif (bukan 75 statis).
5. **Backfill seed-if-absent:** DB tanpa key → 65 terisi; DB dengan key 80 → tetap 80.
6. `npm run check` hijau.

---

## 9. Audit Layer 1–9 (ringkas)

- **L1 Type:** `Number()` guard pada strat field; `?? numSetting`. ✅
- **L2 Library:** pola `strategySetting`/`numSetting` existing. ✅
- **L3:** §7. ✅
- **L4 Konsistensi:** satu sumber kebenaran; log ↔ gate pakai fungsi sama. ✅
- **L5 Contoh:** pseudo-code terdefinisi. ✅
- **L6 Default:** §6 eksplisit. ✅
- **L7 Race:** N/A (baca-saja konfigurasi). ✅
- **L8 Limitations:** §10. ✅
- **L9:** N/A. ✅

---

## 10. Known Limitations

- Nilai 65 berasal dari **6 sampel** → secara statistik lemah; placeholder konservatif,
  bukan hasil tuning. Re-kalibrasi wajib setelah Tier 1 menghasilkan data baru.
- Knob learning **tidak diaktifkan** di Tier 3 — aktivasi butuh ≥ N posisi valid &
  analisa korelasi (sesi terpisah, lihat `00-overview` Out of scope).
- Visibilitas Telegram (3.5) opsional; bila ditunda, operator verifikasi via DB/setting.
