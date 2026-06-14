# Tier 2 — Monitor Posisi Adaptif Sub-3s

**Prioritas:** Kedua (setelah Tier 1).
**Risiko:** Sedang (menyentuh main loop + rate-limit).
**Dependency:** Bermakna setelah Tier 1 (agar ada posisi baru untuk dipantau).
**Lihat juga:** `00-overview.md`, handoff lama Item B.

---

## 1. Konteks & Masalah

`monitorPositions()` dijalankan tiap `POSITION_CHECK_MS = 10_000` (10 detik) di
`src/app.js:64`. Memecoin Solana bisa dump 40–60% dalam < 10 detik. Bukti dari
`data/charon.db`: 4/4 posisi exit `SL`, dua di antaranya **lebih dalam dari target SL**:

| Posisi | tier/strat | SL target | PnL realisasi |
|---|---|---|---|
| 1 | sniper | −25% (mid) | **−35.8%** |
| 3 | degen | −15% (low default −35) | **−53.7%** |

PnL realisasi jauh lebih dalam dari ambang SL → indikasi **exit telat**: harga sudah
jatuh menembus SL jauh sebelum cek 10-detik berikutnya menangkapnya. Ini satu-satunya
celah keamanan exit yang tersisa dari analisa awal.

---

## 2. Tujuan

Pantau posisi **muda/volatil/dekat-threshold** pada **sub-3 detik**, sementara posisi
matang tetap 10 detik (hemat rate-limit). Tanpa menimbulkan double-sell atau
membanjiri Jupiter API.

---

## 3. Desain

### 3.1 Klasifikasi fast vs slow lane (per posisi)
Posisi masuk **fast lane** bila salah satu benar:
- **Muda:** `now() - opened_at_ms < POSITION_VOLATILE_AGE_MS` (default 300_000 = 5 mnt).
- **Dekat threshold:** PnL% saat ini dalam ±`position_fast_near_threshold_pct`
  (default 8%) dari `sl_percent` **atau** `tp_percent` **atau** (jika trailing armed)
  dekat titik trailing-drop. Artinya posisi yang hampir trigger exit dicek lebih sering.

Selain itu → **slow lane** (10s).

> Catatan: "dekat threshold" butuh harga terkini. Agar tidak menambah fetch hanya
> untuk klasifikasi, fast-lane MVP cukup pakai kriteria **umur** + **flag dari siklus
> sebelumnya** (lihat 3.3). Kriteria PnL-dekat-threshold dihitung dari hasil
> `refreshPosition` siklus terakhir yang sudah menyimpan `high_water_*` & bisa
> diperkaya menyimpan `last_pnl_percent` (kolom opsional) — lihat 3.4.

### 3.2 Dua scheduler interval (di app.js)
- Pertahankan slow loop: `setInterval(monitorPositions, POSITION_CHECK_MS)` →
  ubah agar memproses **hanya slow-lane** posisi (atau semua, tapi fast-lane juga
  ditangani loop cepat — lihat reentrancy 3.5).
- Tambah fast loop: `setInterval(monitorPositionsFast, POSITION_CHECK_FAST_MS)`
  (default 2500ms) → memproses hanya posisi fast-lane.

Pendekatan paling sederhana & aman: **satu fungsi `monitorPositions(lane)`** dengan
parameter lane (`'all' | 'fast' | 'slow'`), dipanggil dua interval. Fast loop pakai
`lane='fast'`, slow loop `lane='slow'`. Default `monitorPositions()` (tanpa arg) =
`'all'` untuk kompatibilitas pemanggil lain.

### 3.3 Seleksi di dalam loop
```
positions = openPositions()
selected = positions.filter(p => laneOf(p) === lane)   // 'fast'/'slow'
```
`laneOf(p)`:
```
const ageMs = now() - p.opened_at_ms;
if (ageMs < POSITION_VOLATILE_AGE_MS) return 'fast';
if (isNearThreshold(p)) return 'fast';
return 'slow';
```

### 3.4 isNearThreshold tanpa fetch ekstra
Pakai PnL siklus terakhir. Opsi A (disarankan, minimal): tambah kolom
`last_pnl_percent REAL` di `dry_run_positions` (via `ensureColumn` pola existing di
connection.js) yang di-update tiap `refreshPosition`. `isNearThreshold` membaca kolom
ini:
```
const pnl = Number(p.last_pnl_percent);
if (!Number.isFinite(pnl)) return false;          // belum ada data → slow (umur sudah cover posisi baru)
const near = numSetting('position_fast_near_threshold_pct', 8);
const sl = Number(p.sl_percent), tp = Number(p.tp_percent);
if (Number.isFinite(sl) && pnl <= sl + near) return true;   // mendekati SL dari atas
if (Number.isFinite(tp) && pnl >= tp - near) return true;   // mendekati TP dari bawah
return false;
```
Opsi B (tanpa kolom): simpan map in-memory `positionId -> lastPnl`. Lebih ringan DB,
tapi hilang saat restart. **Pilih Opsi A** (persisten, konsisten dgn reconcile).

### 3.5 Reentrancy / double-fire (KRITIS)
Fast + slow loop + kemungkinan overlap dalam satu lane bisa memproses posisi sama.
Pertahanan berlapis (sebagian sudah ada):
1. **`sellInProgress` Set** (sudah ada di `positions.js:128`) — guard per-posisi saat exit. ✅
2. **Lane disjoint:** sebuah posisi diklasifikasi ke tepat satu lane per siklus →
   normalnya tidak diproses dua loop sekaligus. Tapi klasifikasi bisa berubah antar
   siklus (umur lewat 5 mnt) → ada window. `sellInProgress` menutup risiko exit ganda.
3. **Loop-level guard:** tambah `monitorBusy` Set per-lane (atau satu `Set` global
   `inFlightPositionIds`) supaya posisi yang sedang di-`refreshPosition` tak diambil
   loop lain. Implementasi: sebelum `refreshPosition(p)`, `if (inFlight.has(p.id)) continue; inFlight.add(p.id)`, `finally inFlight.delete(p.id)`.
4. **Re-check status open** sebelum menulis exit (sudah ada di dry-run branch
   `positions.js:309`). Pastikan jalur live juga aman (sudah pakai `sellInProgress`). ✅

### 3.6 Rate-limit awareness
- Fast loop hanya memproses subset kecil (posisi muda/dekat-threshold), bukan semua.
  Dengan `max_open_positions` 2–3, paling banyak ~3 posisi × tiap 2.5s = ~1.2 req/s
  ke `fetchJupiterAsset` — di bawah throttle existing.
- `fetchJupiterAsset` punya cache/backoff (cek `jupiter.js`). Fast loop **harus pakai
  data fresh** untuk SL akurat → panggil `fetchJupiterAsset(mint)` (cache default).
  Bila cache TTL terlalu panjang untuk SL, pertimbangkan `{ useCache: false }` hanya
  untuk fast-lane (verifikasi TTL `fetchJupiterAsset` saat impl; jangan asumsikan).
- Tambah guard: jika jumlah fast-lane posisi > N (mis. 5), batasi/agar tidak spam
  (default `max_open_positions` rendah, jadi praktis tak kena).

---

## 4. File yang Disentuh

| File | Perubahan |
|---|---|
| `src/config.js` | `POSITION_CHECK_FAST_MS=2500`, `POSITION_VOLATILE_AGE_MS=300_000` |
| `src/execution/positions.js` | `monitorPositions(lane='all')`, `laneOf`, `isNearThreshold`, `inFlight` guard, update `last_pnl_percent` |
| `src/app.js` | tambah fast `setInterval`, slow loop pakai `lane='slow'` |
| `src/db/connection.js` | `ensureColumn('dry_run_positions','last_pnl_percent','REAL')` |
| settings | `position_fast_near_threshold_pct=8` |

---

## 5. Pseudo-code

```js
// config.js
export const POSITION_CHECK_FAST_MS = Number(process.env.POSITION_CHECK_FAST_MS || 2500);
export const POSITION_VOLATILE_AGE_MS = Number(process.env.POSITION_VOLATILE_AGE_MS || 300_000);

// positions.js
const inFlight = new Set();

function isNearThreshold(p) {
  const pnl = Number(p.last_pnl_percent);
  if (!Number.isFinite(pnl)) return false;
  const near = numSetting('position_fast_near_threshold_pct', 8);
  const sl = Number(p.sl_percent), tp = Number(p.tp_percent);
  if (Number.isFinite(sl) && pnl <= sl + near) return true;
  if (Number.isFinite(tp) && pnl >= tp - near) return true;
  return false;
}

function laneOf(p) {
  if (now() - Number(p.opened_at_ms) < POSITION_VOLATILE_AGE_MS) return 'fast';
  return isNearThreshold(p) ? 'fast' : 'slow';
}

export async function monitorPositions(lane = 'all') {
  const positions = openPositions().filter(p => lane === 'all' || laneOf(p) === lane);
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    if (inFlight.has(position.id)) continue;          // loop-level reentrancy guard
    inFlight.add(position.id);
    try {
      const jupiterPnl = position.execution_mode === 'live'
        ? (walletPnlData[position.mint]?.pnl || null) : null;
      const result = await refreshPosition(position, { autoExit: true, jupiterPnl })
        .catch(err => { console.log(`[position] ${position.id} ${err.message}`); return null; });
      if (result?.exitReason) await sendPositionExit(result);
    } finally {
      inFlight.delete(position.id);
    }
  }
}

// inside refreshPosition: after computing pnlPercent, persist it
db.prepare('UPDATE dry_run_positions SET high_water_mcap=?, high_water_price=?, trailing_armed=?, last_pnl_percent=? WHERE id=?')
  .run(highWaterMcap, highWaterPrice, trailingArmed?1:0, pnlPercent, position.id);

// app.js
const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
setInterval(() => trackPositions(() => monitorPositions('slow')), POSITION_CHECK_MS);
const trackPositionsFast = makeFailureTracker('position monitor (fast)', (msg) => sendTelegram(msg));
setInterval(() => trackPositionsFast(() => monitorPositions('fast')), POSITION_CHECK_FAST_MS);
```

---

## 6. Default Values (eksplisit)

| Param | Default | Catatan |
|---|---|---|
| `POSITION_CHECK_MS` | `10_000` | slow lane, tak berubah |
| `POSITION_CHECK_FAST_MS` | `2500` | sub-3s |
| `POSITION_VOLATILE_AGE_MS` | `300_000` | 5 menit |
| `position_fast_near_threshold_pct` | `8` | ±8% dari SL/TP |

Perilaku lama dipertahankan: tanpa posisi muda/dekat-threshold, fast loop memproses 0
posisi (no-op) → tak ada perubahan beban. Aktif hanya saat ada posisi berisiko.

---

## 7. Error Path & Lifecycle (Layer 3)

- **Overlap fast×slow:** `inFlight` Set + `sellInProgress` + re-check status open → tak ada exit ganda. ✅
- **refreshPosition throw:** sudah `.catch` per-posisi; `inFlight` dibersihkan di `finally`. ✅
- **last_pnl_percent legacy null:** `isNearThreshold` balik false; posisi muda tetap fast via umur. ✅
- **Rate-limit:** subset kecil; verifikasi TTL `fetchJupiterAsset`. ⚠️ cek saat impl.
- **Restart:** `inFlight` in-memory kosong saat start — benar (tak ada in-flight nyata). ✅
- **Timer leak:** dua `setInterval` hidup selama proses; tak ada timer dinamis per-posisi → tak ada leak. ✅

---

## 8. Test / Verifikasi

Skrip manual + copy DB temp:
1. **laneOf umur:** posisi `opened_at_ms = now()-1000` → `'fast'`; `now()-10*60_000` tanpa near → `'slow'`.
2. **isNearThreshold:** `last_pnl_percent=-20, sl_percent=-25, near=8` → true (−20 ≤ −17). PnL −10 → false.
3. **near TP:** `last_pnl_percent=45, tp=50, near=8` → true.
4. **reentrancy:** panggil `monitorPositions('fast')` 2× nyaris bersamaan (Promise.all) dengan stub refresh lambat → posisi diproses sekali (assert `inFlight`).
5. **disjoint lane:** posisi slow tak diproses oleh `lane='fast'`.
6. **migration:** `ensureColumn` menambah `last_pnl_percent` ke copy DB lama tanpa error; nilai awal NULL.
7. `npm run check` hijau.

Smoke (opsional): jalankan agent dgn 1 posisi dry_run buatan berumur < 5 mnt →
konfirmasi log monitor muncul tiap ~2.5s, lalu melambat ke ~10s setelah 5 mnt.

---

## 9. Audit Layer 1–9 (ringkas)

- **L1 Type:** `Number()` + `Number.isFinite` di semua perbandingan threshold. ✅
- **L2 Library:** `setInterval`, better-sqlite3 `ensureColumn` pola existing; `fetchJupiterAsset` TTL **harus diverifikasi** (jangan asumsi). ⚠️
- **L3:** §7. ✅
- **L4 Konsistensi:** `monitorPositions()` default `'all'` agar pemanggil lain tak rusak; app.js pakai `'slow'`/`'fast'`. ✅
- **L5 Contoh:** pseudo-code variabel terdefinisi; `makeFailureTracker` sudah ada di app.js. ✅
- **L6 Default:** §6. ✅
- **L7 Race:** §3.5 berlapis; window klasifikasi-berubah ditutup `sellInProgress`. Known: dua interval bisa fire dempet → `inFlight` menutup. ✅
- **L8 Limitations:** §10. ✅
- **L9:** N/A. ✅

---

## 10. Known Limitations

- `isNearThreshold` pakai PnL siklus **sebelumnya** (lag 1 siklus). Untuk posisi muda
  ini tak masalah (sudah fast via umur). Untuk posisi matang yang tiba-tiba jatuh,
  lag maksimum = 1 slow-cycle (10s) sebelum naik ke fast lane. Diterima (perbaikan
  besar vs status quo; alternatif real-time butuh WS price feed — di luar scope).
- Tidak ada per-posisi dynamic interval (timer terpisah tiap posisi) — sengaja
  dihindari untuk cegah timer leak; dua-lane lebih sederhana & aman.
- Fast polling menambah biaya RPC/Jupiter saat banyak posisi muda; dibatasi `max_open_positions` (2–3).
