Sesuai 4 pilihan Anda: full pipeline (entry→exit) · real data semua upstream · mode observasi (bukan assertion) · real mint dari signal server.

Yang dilakukan script:
1. Boot komponen agent asli → paksa trading_mode=dry_run → boot DB
2. PHASE 1 — tarik signal real dari api.thecharon.xyz, alirkan lewat processCandidateFromSignals (buildCandidate → filter → score → LLM → posisi dry-run)
3. PHASE 2 — monitorPositions('fast'/'slow') sampai posisi exit (SL/TP/trailing)
4. PHASE 3 — dump candidates, decisions, decision_logs, positions, trades untuk inspeksi bareng

3 lapis pengaman live (penting karena [live] wallet loaded — wallet asli ter-load):
- DB throwaway temp (default) → posisi produksi tak tersentuh
- trading_mode di-set paksa ke dry_run di DB (bukan env, karena tradingMode() baca dari setting)
- hard abort kalau tradingMode() ternyata bukan dry_run

Satu edit pendukung: src/telegram/bot.js sekarang menghormati __E2E_NO_TELEGRAM=1 → stub no-op, supaya --no-telegram tidak spam chat asli / tak butuh token. npm run check lolos.

Cara pakai:
node scripts/e2e-dryrun.mjs --help                              # opsi lengkap
node scripts/e2e-dryrun.mjs --no-telegram --cycles 1 --monitor-secs 8   # offline-ish, cepat
node scripts/e2e-dryrun.mjs --cycles 3 --poll-interval 30000 --monitor-secs 180  # realistis, dengan Telegram