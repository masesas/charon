# Next Steps Plan — Charon

**Status:** Draft untuk dieksekusi. Menunggu instruksi user untuk memilih urutan/scope.
**Konteks:** 4 PR sudah merged berturut di `main`:
- PR#1 Tier 0 safety (liquidity/honeypot/price-impact guard + real fill price)
- PR#2 Tier-routing (lowcap/midcap/highcap paralel + exit profil per-tier)
- PR#3 Price-based PnL + exit-slippage modeling
- PR#4 Learning loop (scores gate/size + source-reliability threshold)

**State penting:**
- DB produksi di-restore: `data/charon.db` ~1.5 GB — **9171 candidates, 4 posisi (semua closed, PnL negatif -18% s/d -53%), 4095 decision_logs, 737k signal_events**. Integritas OK.
- DB schema masih versi lama (pre-Tier-0); migrasi auto-apply saat `initDb()` jalan berikutnya (sudah diverifikasi bersih di copy).
- ⚠️ `.env` `DB_PATH=/app/data/charon.db` (Docker). Run lokal default ke `./charon.sqlite` — set `DB_PATH=data/charon.db` untuk pakai data restored.
- Semua knob learning-loop default NEUTRAL (belum aktif).

---

## Item A — Cleanup signal_events (DB bloat)

**Masalah:** `signal_events` = 737k baris / 1.2 GB dari total 1.5 GB DB. Tak ada retention policy → tumbuh tanpa batas. Memperlambat backup, query, restore.

**Scope:**
- Tambah retention/prune untuk `signal_events` (mis. hapus > N hari, pola sama `cleanupAlerts`/`cleanupOldSnapshots` di `priceMonitor.js`).
- Setting: `signal_events_retention_days` (default mis. 7–14).
- Jadwalkan di `app.js` `setInterval` (pola existing reconcile/cleanup).
- `VACUUM` opsional/manual sekali untuk klaim ruang setelah prune pertama (catat: VACUUM kunci DB, jalankan saat maintenance).

**File:** `src/signals/trending.js` atau `serverClient.js` (penulis signal_events), `src/db/connection.js` (default), `src/app.js` (interval), kemungkinan modul cleanup baru `src/db/maintenance.js`.

**Risiko:** rendah. Read-mostly cleanup. Pastikan tak menghapus signal_events yang masih direferensikan decision_logs/candidates aktif (cek FK/join sebelum prune).

**Effort:** kecil. **Nilai:** praktis langsung (DB sehat).

---

## Item B — Monitor sub-3s untuk posisi volatil (SL telat)

**Masalah:** `monitorPositions` jalan tiap `POSITION_CHECK_MS=10s` (config.js:35). Memecoin bisa dump 60% dalam <10s → SL -25% tereksekusi jauh lebih dalam. Satu-satunya celah keamanan exit yang tersisa dari analisa awal.

**Scope:**
- Monitoring adaptif: posisi **baru/volatil** (mis. usia < 5 menit, atau dekat SL/TP) di-cek **sub-3s**; posisi matang melambat ke 10s.
- Pendekatan: pisahkan loop "fast lane" (posisi memenuhi kriteria volatil) dari "slow lane", atau hitung interval per-posisi.
- Hati-hati rate-limit: fast polling = lebih banyak `fetchJupiterAsset` → throttle/backoff existing (jupiter.js) harus cukup; pertimbangkan hanya posisi yang dekat threshold yang di-fast-poll.
- Reentrancy: `monitorPositions` sudah tak punya re-entrancy guard di level loop (cuma `sellInProgress` per-posisi) — fast polling memperbesar peluang overlap; pastikan `sellInProgress` cukup atau tambah guard loop-level.

**File:** `src/app.js` (interval/scheduler), `src/execution/positions.js` (`monitorPositions` — seleksi fast vs slow), `src/config.js` (`POSITION_CHECK_FAST_MS`, `POSITION_VOLATILE_AGE_MS`).

**Risiko:** sedang — menyentuh main loop & rate-limit. Perlu plan mode + validasi race.

**Effort:** sedang. **Nilai:** menutup risiko kerugian besar (SL telat).

---

## Item C — Analisa kuantitatif historis + (opsional) auto-tuning

**Masalah:** Sekarang ada data nyata (9171 candidates, 4095 decisions, PnL akurat pasca-PR#3) tapi belum pernah dianalisis. Sebelum auto-tune ambang, **ukur dulu** apa yang sebenarnya terjadi.

**Scope — Fase 1 (analisa, read-only):**
- Query `data/charon.db`: win-rate & avg PnL **per tier** (lowcap/midcap/highcap), **per source/route**, **per signal label**.
- Distribusi exit_reason (SL vs TP vs TRAILING vs MAX_HOLD) — berapa banyak SL telat (near-miss vs realized gap).
- Korelasi `risk_score`/`quality_score` vs hasil PnL → validasi apakah scoring formula prediktif.
- Catatan: 4 posisi closed semua negatif — sampel sangat kecil; mungkin perlu jalankan dry-run dulu untuk kumpulkan lebih banyak data sebelum kesimpulan kuat.
- Output: dokumen temuan di `handoff/` (mis. `historical-analysis.md`).

**Scope — Fase 2 (auto-tuning, setelah Fase 1):**
- Berdasar temuan, kalibrasi: ambang tier, `risk_score_max_gate`, `source_reliability_threshold_k`, sizing multiplier band.
- Mungkin: job berkala yang menyesuaikan setting dari performa rolling (hati-hati overfitting sample kecil).

**File:** Fase 1 murni query (skrip analisa di `/tmp` atau `scripts/`). Fase 2: `src/learning/*` (sudah ada `lessons.js`/`feedback.js`/`report.js`), settings.

**Risiko:** Fase 1 nol (read-only). Fase 2 sedang (mengubah perilaku dari data).

**Effort:** Fase 1 kecil-sedang. **Nilai:** dasar keputusan berbasis bukti; aktifkan knob learning-loop dgn angka, bukan tebakan.

---

## Rekomendasi urutan

1. **Item A** (cleanup) dulu — kecil, praktis, DB sehat sebelum hal lain.
2. **Item C Fase 1** (analisa) — read-only, memberi bukti untuk mengaktifkan learning-loop & menyetel tier. Juga mengungkap apakah Item B benar-benar mendesak (lihat distribusi SL telat dari data).
3. **Item B** (monitor cepat) atau **Item C Fase 2** (auto-tune) — tergantung temuan analisa.

**Out of scope / nanti:**
- Aktivasi knob learning-loop di produksi (butuh data dari Item C).
- Per-tier exposure SOL terpisah.
- Trailing arm lebih awal (~60% TP).

---

## Catatan eksekusi (konvensi yang sudah dipakai)
- Tiap item: plan mode → riset (Explore/Plan agent) → implementasi → `node --check`/`npm run check` → unit manual di temp DB copy → code-review agent → fix → commit → push → PR → merge → sync main.
- Repo tak punya test framework (hanya `node --check`); verifikasi via skrip manual + temp DB copy.
- DB di `data/` tidak di-track git (aman dari commit).
- Jangan sentuh `.claude/settings.json` & `package-lock.json` (modifikasi pre-existing, bukan milik kita).
