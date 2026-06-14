# Learning Knobs — Aktivasi Bertahap Berbasis Data

**Status:** Referensi operasional. Semua knob **OFF by default** (neutral — perilaku
identik dengan pre-feature). Dokumen ini = prasyarat data + prosedur aktivasi.
**Bagian dari:** Tier 3 (`handoff/plans/03-tier3-param-consistency.md`).
**Verifikasi:** Skrip `scripts/learning-readiness.mjs` (read-only) mengecek kesiapan data.

---

## 0. Prinsip

> **Jangan aktifkan knob dengan tebakan.** Per 2026-06-14 hanya ada **4 posisi closed**
> (semua SL, dari fase singkat saat LLM hidup). Aktivasi di atas sampel sekecil ini =
> overfitting ke noise. Tier 1 (resiliensi LLM) baru saja memulihkan pengambilan
> keputusan agent — biarkan data bersih mengalir dulu.

**Aturan emas:**
1. Aktifkan **satu knob** dalam satu waktu. Jangan serempak (tak bisa atribusi efek).
2. Jalankan **dry_run** dulu (bukan live) setelah tiap aktivasi, minimal beberapa hari.
3. Bandingkan metrik sebelum/sesudah dari `signal_source_performance` & `dry_run_positions`.
4. Setiap perubahan ambang dicatat (tanggal + alasan + angka) di bawah, di §6 changelog.

---

## 1. Knob: `risk_gate_enabled` / `risk_score_max_gate`

**Apa:** Hard-gate entry. Tolak BUY bila `candidate.scores.risk_score >= risk_score_max_gate`.
Deterministik — tak butuh data historis untuk *jalan*, tapi butuh data untuk *menyetel* ambang.

**Kode:** `src/execution/entryGuards.js:50-55`
```js
if (boolSetting('risk_gate_enabled', false)) {
  const riskMax = numSetting('risk_score_max_gate', 100);
  const risk = Number(candidate?.scores?.risk_score);
  if (Number.isFinite(risk) && risk >= riskMax) { /* block */ }
}
```

**Default:** `risk_gate_enabled=false`, `risk_score_max_gate=100` (100 = tak pernah blok).

**Prasyarat aktivasi:**
- ≥ 30 posisi closed dengan PnL valid (untuk korelasi risk_score↔hasil).
- Distribusi `risk_score` posisi **rugi** vs **untung** terlihat terpisah (gate hanya
  berguna bila skor tinggi memang berkorelasi dengan rugi).

**Cara setel ambang awal (konservatif):**
- Hitung persentil-75 `risk_score` dari posisi **rugi**. Set `risk_score_max_gate`
  di sekitar nilai itu (mulai tinggi, turunkan perlahan).
- Contoh: jika posisi rugi mayoritas `risk_score` 70-90 dan posisi untung 30-55 →
  mulai gate di 80, amati berapa banyak entry terblok & apakah yang terblok memang buruk.

**Risiko salah setel:** gate terlalu rendah → blok hampir semua entry (agent diam lagi).
Mulai longgar.

---

## 2. Knob: `sizing_modifier_enabled` / `sizing_min_multiplier` / `sizing_max_multiplier`

**Apa:** Skala ukuran posisi dari skor. `m = 1 + ((quality-50) - (risk-50))/100`,
di-clamp ke `[sizing_min_multiplier, sizing_max_multiplier]`. q==r → 1.0.

**Kode:** `src/execution/tiers.js:114-127`
```js
if (!boolSetting('sizing_modifier_enabled', false)) return base;
const q = Number(candidate?.scores?.quality_score ?? 50);
const r = Number(candidate?.scores?.risk_score ?? 50);
let m = 1 + ((q - 50) - (r - 50)) / 100;
const lo = numSetting('sizing_min_multiplier', 0.5);
const hi = numSetting('sizing_max_multiplier', 1.0);
m = Math.min(hi, Math.max(lo, m));
return base * m;
```

**Default:** `sizing_modifier_enabled=false`, `min=0.5`, `max=1.0` (max 1.0 → tak pernah
melebihi base tier).

**Prasyarat aktivasi:**
- Validasi `quality_score` **prediktif** terhadap PnL (posisi quality tinggi memang
  lebih sering untung). Tanpa ini, sizing modifier hanya menambah varians.
- Idealnya setelah `risk_gate` terbukti sehat (keduanya pakai skor yang sama).

**Cara setel awal (band sempit):**
- Mulai `min=0.8, max=1.0` — variasi ukuran ±20% saja. Hindari `max>1.0` sampai
  benar-benar yakin (memperbesar posisi = memperbesar risiko absolut).
- Lebarkan band hanya jika data menunjukkan skor tinggi konsisten lebih cuan.

**Catatan penting:** modifier dihitung di **dua tempat** (pre-exposure check di
orchestrator & saat createPosition) — keduanya pure function dari skor+profile, jadi
hasilnya konsisten. Jangan mengubah formula tanpa update kedua pemanggil.

---

## 3. Knob: `source_reliability_enabled` / `_threshold_k` / `_min_samples`

**Apa:** Sesuaikan **confidence threshold** per source (route+label) berdasar
reliability historis. Source bagus → threshold turun (lebih mudah lolos); source
buruk → threshold naik.

**Kode:** `src/pipeline/orchestrator.js:30-44`
```js
const base = strat.llm_min_confidence ?? numSetting('llm_min_confidence', 65);
if (!boolSetting('source_reliability_enabled', false)) return base;
const samples = getSourceSampleCount(route, label);
if (samples < numSetting('source_reliability_min_samples', 10)) return base; // cold-start safe
const rel = computeSourceReliabilityScore(route, label); // 0-100, 50 pivot
const k = numSetting('source_reliability_threshold_k', 0);
const adj = base - k * (rel - 50) / 50;
return Math.min(ceil, Math.max(floor, adj)); // floor=40, ceil=95
```

**Default:** `enabled=false`, `k=0` (k=0 → adjustment nol bahkan saat enabled),
`min_samples=10`, `confidence_floor=40`, `confidence_ceil=95`.

**Reliability score** (`computeSourceReliabilityScore`, sourcePerformance.js:100):
win_rate (0-50) + avg_pnl (0-30) + sample_size (0-20) + time_consistency (0-10).
Pivot 50 → di atas 50 menurunkan threshold, di bawah menaikkan.

**Prasyarat aktivasi:**
- ≥ `min_samples` (default 10) posisi closed **per (route, label)** yang mau dipengaruhi.
  Cold-start guard sudah melindungi: di bawah min_samples → threshold base (tak berubah).
- Setidaknya 2-3 source punya sampel cukup, supaya diferensiasi bermakna.

**Cara setel awal:**
- Mulai `k` kecil (mis. 10). Pada `k=10`, source reliability 100 → threshold turun
  `10*(100-50)/50 = 10` poin (65→55); reliability 0 → naik 10 poin (65→75).
- Naikkan `k` perlahan bila diferensiasi terbukti membantu (source bagus menghasilkan
  lebih banyak entry cuan).

---

## 4. Skrip kesiapan (read-only)

`scripts/learning-readiness.mjs` membaca DB (default `data/charon.db`, override via
`DB_PATH`) dan melaporkan, **tanpa menulis apa pun**:
- Jumlah posisi closed dengan PnL valid (gate global: cukup untuk analisa?).
- Distribusi `risk_score`/`quality_score` posisi untung vs rugi (untuk Knob 1 & 2).
- Sampel per (route,label) + reliability score (untuk Knob 3).
- Rekomendasi: knob mana yang **sudah** memenuhi prasyarat data.

Jalankan: `DB_PATH=data/charon.db node scripts/learning-readiness.mjs`

---

## 5. Prosedur aktivasi (langkah baku per knob)

1. Jalankan `scripts/learning-readiness.mjs` → konfirmasi prasyarat knob terpenuhi.
2. Set ambang **konservatif** (lihat per-knob di atas) via Telegram setting atau
   `setSetting()`. Catat di §6.
3. Aktifkan flag (`*_enabled=true`) — **satu knob saja**.
4. Pastikan `trading_mode=dry_run`. Jalankan ≥ 3-7 hari.
5. Bandingkan metrik sebelum/sesudah (win-rate, avg PnL, jumlah entry, distribusi exit).
6. Jika membaik & stabil → pertahankan / setel lebih agresif sedikit. Jika memburuk →
   matikan flag, revert ambang, catat temuan.
7. Baru lanjut knob berikutnya. Ulangi.

---

## 6. Changelog ambang (WAJIB diisi tiap perubahan)

| Tanggal | Knob | Perubahan | Alasan | Hasil (diisi setelah evaluasi) |
|---|---|---|---|---|
| 2026-06-14 | llm_min_confidence | 75 → 65 | selaraskan + tangkap cluster BUY 66+ (6 sampel) | placeholder, re-kalibrasi pasca data baru |
| — | risk_gate | (belum aktif) | — | — |
| — | sizing_modifier | (belum aktif) | — | — |
| — | source_reliability | (belum aktif) | — | — |

---

## 7. Out of scope dokumen ini

- Auto-tuning otomatis (job berkala yang menyesuaikan ambang) — risiko overfitting,
  butuh desain terpisah setelah knob manual terbukti.
- Mengubah formula scoring (`scoring.js`) atau reliability — itu perubahan model,
  bukan knob.
