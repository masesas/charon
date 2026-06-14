# Tier 1 — Resiliensi LLM + Fallback Deterministik

**Prioritas:** WAJIB DULU (memblokir Tier 2 & 3).
**Risiko:** Sedang (menyentuh otak agent).
**Dependency:** Tidak ada.
**Lihat juga:** `00-overview.md` (root cause & evidence).

---

## 1. Konteks & Masalah

Sejak 23 Mei 2026, **100% LLM batch gagal** (`empty_error`), tiap hari. Akibatnya
`decideCandidateBatch` selalu balik `verdict: WATCH, confidence: 0` → agent **tidak
mengambil keputusan apa pun** selama 3+ minggu. Tidak ada retry, tidak ada alert,
error message kosong (senyap total).

**Root cause (dikonfirmasi via probe live, lihat overview §0):**
Request di `src/pipeline/llm.js:129-139` **tidak mengirim `stream: false`**. Proxy
(`localhost:20128`) default streaming SSE → `res.data` berisi teks `data: {...}`
mentah → `res.data.choices` undefined → `content = ''` → `JSON.parse('')` throw,
`err.message === ''`.

Bukti probe:
- Tanpa `stream:false`: respons `data: {...}\n\n` (SSE), `content-type: text/event-stream`.
- Dengan `stream:false`: `{"object":"chat.completion","choices":[{"message":{"content":"..."}}]}`, `content-type: application/json`. ✅

---

## 2. Tujuan

1. **Perbaiki root cause** — kirim `stream: false`, agar parsing existing bekerja.
2. **Ganti model** — `morph-orchestrator` → `my-default` (URL tetap).
3. **Retry + backoff** untuk kegagalan transien (timeout/5xx).
4. **Error surfacing** — jangan pernah simpan error kosong; pakai status + body HTTP.
5. **Alert Telegram** saat gagal beruntun (≥ N), supaya kegagalan senyap tak terulang.
6. **Fallback deterministik** — saat LLM tetap gagal, putuskan via `risk_score`/
   `quality_score` (sudah dihitung di scoring.js) alih-alih diam total.

---

## 3. Desain

### 3.1 Fix request (root cause)
`src/pipeline/llm.js` `decideCandidateBatch`, body POST:
- Tambah `stream: false`.
- `model: LLM_MODEL` tetap (nilai `my-default` datang dari `.env`).

### 3.2 Ganti model
`.env`: `LLM_MODEL=my-default` (URL `LLM_BASE_URL` tidak diubah).
`src/config.js:28` default fallback string boleh diselaraskan ke `'my-default'`
agar konsisten bila `.env` absen (opsional, non-breaking).

### 3.3 Error surfacing (anti empty-error)
Buat helper `describeAxiosError(err)`:
- Jika `err.response`: `HTTP <status> <statusText>: <body cuplik 300 char>`.
- Jika `err.code` (mis. `ECONNABORTED`/`ECONNREFUSED`): sertakan code.
- Jika `err.message` kosong: fallback `err.code || 'unknown_llm_error'`.
Hasil dipakai untuk `reason`, `recordHealthFailure`, dan log — **tidak pernah string kosong**.

Tambahan guard parsing: jika `content` kosong **atau** `res.data` ternyata string
yang diawali `data:` (SSE tak terduga), lempar `Error('empty/stream response: ...')`
yang deskriptif (bukan biarkan `JSON.parse('')` lempar kosong).

### 3.4 Retry + backoff
Loop attempt `1..(maxRetries+1)`:
- Retry hanya untuk **transien**: timeout (`ECONNABORTED`), `ECONNREFUSED`,
  HTTP `>=500`, atau parse-empty. **Jangan** retry untuk HTTP 4xx (selain 429) —
  itu bug request, retry sia-sia. HTTP 429 → retry dengan backoff.
- Backoff: `llm_retry_backoff_ms * attempt` (linear; cukup untuk transien lokal).
- `sleep()` sudah ada di `utils.js`.

### 3.5 Fallback deterministik (keputusan user)
Fungsi baru `deterministicFallbackDecision(rows)`:
- Hanya aktif bila `llm_fallback_enabled` (default `true`).
- Pilih kandidat dengan `quality_score >= llm_fallback_min_quality` (default 60)
  **dan** `risk_score <= llm_fallback_max_risk` (default 45).
- Dari yang lolos, ambil skor komposit tertinggi: `quality_score - risk_score`
  (deterministik, tie-break by `candidate_id` terkecil agar stabil).
- Jika ada pemenang → `verdict: 'BUY'`, `confidence: llm_fallback_confidence`
  (default 55), `reason: 'LLM unavailable — deterministic score fallback (...)'`,
  `risks: ['llm_fallback']`. Jika tak ada → `verdict: 'WATCH', confidence: 0`.
- TP/SL pakai `default_tp_percent`/`default_sl_percent` setting.
- **Penting:** confidence fallback (55) harus dibandingkan terhadap
  `effectiveConfidenceThreshold`. Lihat §3.6 — kalau threshold 65, fallback 55 tak
  akan beli. Itu **disengaja konservatif**: fallback default tidak agresif. Untuk
  membuat fallback bisa beli, set `llm_fallback_confidence >= llm_min_confidence`
  secara sadar (didokumentasikan, bukan default).

### 3.6 Interaksi dengan confidence gate
Gate di `orchestrator.js:116`:
`batchDecision.confidence >= effectiveConfidenceThreshold(selectedRow.candidate)`.
Fallback menghasilkan `confidence` sintetis → otomatis tunduk gate yang sama.
Tidak perlu ubah orchestrator untuk fallback (hanya `llm.js` yang berubah).
Konsekuensi: dengan default (`fallback_confidence=55`, `llm_min_confidence=75/65`),
fallback **tidak akan trigger buy** — aman by default; jadi jalur diam→aktif harus
opt-in. (Lihat Tier 3 untuk penyelarasan `llm_min_confidence`.)

### 3.7 Alert beruntun
Counter modul-level `llmFailStreak` (in-memory):
- `++` tiap kegagalan; reset 0 tiap sukses.
- Saat `llmFailStreak === llm_alert_fail_streak` (default 5) → `sendTelegram`
  satu kali (edge-trigger, bukan tiap kegagalan setelahnya) berisi error terakhir
  yang deskriptif. Reset hanya saat sukses → alert kedua hanya jika streak baru.
- Import `sendTelegram` ke `llm.js` (cek tidak ada circular import — `send.js`
  tidak meng-import `llm.js`; aman).

---

## 4. File yang Disentuh

| File | Perubahan |
|---|---|
| `.env` | `LLM_MODEL=my-default` |
| `src/config.js` | (opsional) default string `LLM_MODEL` → `'my-default'` |
| `src/pipeline/llm.js` | `stream:false`, retry loop, `describeAxiosError`, parse guard, fallback, alert streak |
| `src/utils.js` | (jika perlu) tak ada; `sleep`, `strictJsonFromText` sudah ada |
| `src/db/connection.js` | (opsional) seed default setting baru ke tabel `settings` |

Tidak ada perubahan schema DB (setting pakai key-value `settings` yang sudah ada).

---

## 5. Pseudo-code (versi final, sudah di-guard)

```js
// llm.js — module scope
let llmFailStreak = 0;

function describeAxiosError(err) {
  if (err?.response) {
    const body = typeof err.response.data === 'string'
      ? err.response.data.slice(0, 300)
      : JSON.stringify(err.response.data || {}).slice(0, 300);
    return `HTTP ${err.response.status} ${err.response.statusText || ''}: ${body}`.trim();
  }
  if (err?.code) return `${err.code}: ${err.message || 'no message'}`;
  return err?.message || 'unknown_llm_error';
}

function isRetryable(err) {
  if (err?.code === 'ECONNABORTED' || err?.code === 'ECONNREFUSED') return true;
  const status = err?.response?.status;
  if (status && (status >= 500 || status === 429)) return true;
  if (err?.__parseEmpty) return true; // empty/stream response
  return false;
}

function deterministicFallbackDecision(rows) {
  if (!boolSetting('llm_fallback_enabled', true)) {
    return baseWatch('LLM unavailable — fallback disabled.');
  }
  const minQ = numSetting('llm_fallback_min_quality', 60);
  const maxR = numSetting('llm_fallback_max_risk', 45);
  const eligible = rows
    .map(r => ({ r, q: Number(r.candidate?.scores?.quality_score ?? 0),
                      risk: Number(r.candidate?.scores?.risk_score ?? 100) }))
    .filter(x => x.q >= minQ && x.risk <= maxR)
    .sort((a, b) => (b.q - b.risk) - (a.q - a.risk) || a.r.id - b.r.id);
  if (!eligible.length) return baseWatch('LLM unavailable — no candidate passed score fallback.');
  const win = eligible[0].r;
  return {
    verdict: 'BUY',
    confidence: numSetting('llm_fallback_confidence', 55),
    selected_candidate_id: win.id,
    selected_mint: win.candidate.token.mint,
    selected_row: win,
    reason: `LLM unavailable — deterministic score fallback (q=${eligible[0].q}, risk=${eligible[0].risk}).`,
    risks: ['llm_fallback'],
    suggested_tp_percent: numSetting('default_tp_percent', 50),
    suggested_sl_percent: numSetting('default_sl_percent', -25),
    raw: { fallback: true },
  };
}

function baseWatch(reason) {
  return {
    verdict: 'WATCH', confidence: 0, selected_candidate_id: null,
    selected_mint: null, selected_row: null, reason,
    risks: ['llm_unavailable'],
    suggested_tp_percent: numSetting('default_tp_percent', 50),
    suggested_sl_percent: numSetting('default_sl_percent', -25),
    raw: null,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) return baseWatch('LLM disabled or LLM_API_KEY missing.');

  const maxRetries = numSetting('llm_max_retries', 2);
  const backoff = numSetting('llm_retry_backoff_ms', 1000);
  // ... build system+user (unchanged) ...

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const start = now();
      const res = await axios.post(endpoint, {
        model: LLM_MODEL, temperature: 0.2, stream: false,   // <-- FIX
        messages: [ { role: 'system', content: system },
                    { role: 'user', content: JSON.stringify(user) } ],
      }, { timeout: LLM_TIMEOUT_MS,
           headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' } });

      const content = res.data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string' || content.trim() === '') {
        const e = new Error('empty/stream response from LLM'); e.__parseEmpty = true; throw e;
      }
      const parsed = strictJsonFromText(content);
      const decision = normalizeDecision(parsed);
      const selectedId = Number(parsed.selected_candidate_id);
      const selectedMint = String(parsed.selected_mint || '');
      const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
      recordHealthSuccess('llm', 'chat_completion', now() - start);
      llmFailStreak = 0;
      return {
        ...decision,
        selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
        selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
        selected_row: decision.verdict === 'BUY' && row ? row : null,
      };
    } catch (err) {
      lastErr = err;
      if (attempt <= maxRetries && isRetryable(err)) { await sleep(backoff * attempt); continue; }
      break;
    }
  }

  // exhausted
  const desc = describeAxiosError(lastErr);
  recordHealthFailure('llm', 'chat_completion', new Error(desc));
  console.log(`[llm] batch failed after retries: ${desc}`);
  llmFailStreak++;
  if (llmFailStreak === numSetting('llm_alert_fail_streak', 5)) {
    try { await sendTelegram(`⚠️ <b>LLM down</b>\n${llmFailStreak}x gagal beruntun.\nError: ${escapeHtml(desc)}`); }
    catch { /* alert best-effort */ }
  }
  return deterministicFallbackDecision(rows);
}
```

> Catatan guard: `__parseEmpty` flag membuat respons SSE tak terduga ikut di-retry,
> bukan langsung jatuh ke fallback (endpoint mungkin flaky sesaat).

---

## 6. Default Values (eksplisit)

| Setting | Default | Netral? | Catatan |
|---|---|---|---|
| `llm_max_retries` | `2` | — | 3 attempt total |
| `llm_retry_backoff_ms` | `1000` | — | linear × attempt |
| `llm_fallback_enabled` | `true` | ya* | *fallback hanya beli bila confidence ≥ gate |
| `llm_fallback_min_quality` | `60` | — | quality_score gate |
| `llm_fallback_max_risk` | `45` | — | risk_score gate |
| `llm_fallback_confidence` | `55` | ya | < default gate (65/75) → tak beli kecuali di-opt-in |
| `llm_alert_fail_streak` | `5` | — | edge-trigger |

Semua dibaca via `numSetting/boolSetting(key, DEFAULT)` dengan DEFAULT tertulis di kode.
Karena `llm_fallback_confidence (55) < llm_min_confidence (65/75)`, **perilaku
default tetap konservatif**: memperbaiki LLM tidak diam-diam membuat agent agresif.

---

## 7. Error Path & Lifecycle (Layer 3)

- **Happy path:** request `stream:false` → JSON → parse → decision. ✅
- **Transien (timeout/5xx/429/empty):** retry ≤ maxRetries dengan backoff. ✅
- **4xx non-429:** tidak di-retry (request bug) → langsung describe + fallback. ✅
- **Exhausted:** `recordHealthFailure` dengan pesan deskriptif (bukan kosong),
  increment streak, alert sekali di ambang, return fallback. ✅
- **Alert gagal kirim:** dibungkus try/catch best-effort — tak boleh menggagalkan keputusan. ✅
- **No memory leak:** `llmFailStreak` integer modul-scope, reset saat sukses. ✅
- **Circular import:** `send.js` tidak meng-import `llm.js` → aman meng-import `sendTelegram`. **Verifikasi saat implementasi.**

---

## 8. Test / Verifikasi (tanpa framework)

Skrip manual `scripts/test-llm-tier1.mjs` (atau inline node), pakai **copy DB temp**:

1. **Live success:** panggil `decideCandidateBatch` dengan 1 row dummy → harus
   `recordHealthSuccess`, bukan WATCH-error. (Butuh endpoint hidup.)
2. **Root-cause regression:** assert request body mengandung `stream:false`
   (spy/log) — mencegah regresi.
3. **Retry:** mock axios throw `ECONNABORTED` 2×, sukses ke-3 → 1 hasil sukses, 2 sleep.
4. **4xx no-retry:** mock HTTP 400 → 1 attempt, langsung fallback.
5. **Fallback pick:** endpoint mati + rows punya satu q=70/risk=30 → fallback BUY q-r.
6. **Fallback empty:** semua risk tinggi → WATCH.
7. **Alert edge:** 5 gagal beruntun → `sendTelegram` dipanggil tepat 1×; gagal ke-6 tak alert lagi.
8. **Error surfacing:** assert `reason`/health `last_error` **tidak kosong** di semua jalur gagal.

Lalu: `npm run check` (node --check) harus hijau.

**Smoke test integrasi (manual, opsional):** jalankan agent sebentar di dry_run dengan
copy DB → lihat `llm_batches` baru: rasio sukses harus > 95%.

---

## 9. Audit Layer 1–9 (ringkas)

- **L1 Type:** semua optional pakai `?? default`; `Number()` + `Number.isFinite` di skor fallback. ✅
- **L2 Library:** axios `stream:false` di body (bukan responseType); `res.data` JSON saat content-type json — terverifikasi probe. ✅
- **L3 Error/lifecycle:** §7. ✅
- **L4 Konsistensi:** confidence fallback ↔ gate dijelaskan §3.6; default tabel §6 sinkron dgn pseudo-code. ✅
- **L5 Contoh:** pseudo-code §5 semua variabel terdefinisi (`baseWatch`, `escapeHtml` perlu di-import dari `format.js`). ✅
- **L6 Default:** §6 eksplisit + komentar. ✅
- **L7 Race:** `llmFailStreak` bisa di-increment dari batch konkuren (pipeline async). Edge-trigger `=== N` bisa terlewat bila dua kegagalan barengan lompati N. **Known edge case** (alert telat 1, bukan fatal) → gunakan `>=` dengan flag `alertedAtStreak` jika ingin ketat. Diputuskan: pakai `>=` + flag boolean `llmAlerted` reset saat sukses. (Revisi pseudo-code saat impl.) ✅
- **L8 Limitations:** lihat §10. ✅
- **L9 Portabilitas:** N/A (bukan modul standalone). ✅

> Revisi L7 yang mengikat implementasi: ganti `=== N` jadi
> `if (llmFailStreak >= N && !llmAlerted) { alert; llmAlerted = true; }`,
> dan `llmAlerted = false` saat sukses. Hindari alert terlewat/spam.

---

## 10. Known Limitations

- Fallback berbasis skor heuristik existing (`scoring.js`) yang **belum tervalidasi**
  prediktif (sampel kecil). Fallback default sengaja tak beli (confidence < gate).
- `llmFailStreak` in-memory → reset saat proses restart (alert bisa ulang sekali setelah restart). Diterima.
- Tidak menangani SSE inkremental (di luar scope — `stream:false` cukup).
