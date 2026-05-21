# Charon Setup Checklist

Langkah-langkah yang **harus lu kerjain manual** sebelum run Charon.

---

## 1. Telegram Bot Setup

### Bikin bot baru
1. Buka Telegram, cari `@BotFather`
2. Kirim `/newbot`
3. Kasih nama bot (contoh: `My Charon Bot`)
4. Kasih username bot (harus diakhiri `bot`, contoh: `my_charon_bot`)
5. Copy **token** yang dikasih BotFather

### Dapetin Chat ID
1. Start chat sama bot lu (klik link dari BotFather atau search username bot)
2. Kirim message apa aja ke bot (contoh: `/start`)
3. Buka browser, paste URL ini (ganti `<TOKEN>` sama token bot lu):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Cari bagian `"chat":{"id":123456789,...}` — angka itu **chat ID** lu
5. Atau kalau mau pake group:
   - Add bot ke group
   - Kirim message di group
   - Cek `/getUpdates` lagi, cari chat ID yang negatif (contoh: `-1001234567890`)

### Isi ke `.env`
```bash
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=123456789
```

---

## 2. Signal Server Access

**Charon butuh signal server buat dapetin data pump token real-time.**

### Cara dapetin akses
1. Contact maintainer repo asli: **yunus-0x** (cek GitHub profile atau README)
2. Minta:
   - `SIGNAL_SERVER_URL` (default: `https://api.thecharon.xyz/api`)
   - `SIGNAL_SERVER_KEY`

### Isi ke `.env`
```bash
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_key_here
```

⚠️ **Tanpa ini bot gak bisa jalan** — signal server adalah sumber data utama.

---

## 3. Solana RPC Endpoint

**Butuh RPC buat baca blockchain + execute trade.**

### Option 1: Helius (recommended, free tier cukup)
1. Daftar di https://helius.dev
2. Create project baru
3. Copy API key
4. Isi ke `.env`:
   ```bash
   HELIUS_API_KEY=your_helius_key_here
   ```
   Atau langsung:
   ```bash
   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_key
   SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=your_key
   ```

### Option 2: QuickNode
1. Daftar di https://quicknode.com
2. Create Solana mainnet endpoint
3. Copy HTTP + WSS URLs
4. Isi ke `.env`:
   ```bash
   SOLANA_RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/xxxxx/
   SOLANA_WS_URL=wss://your-endpoint.solana-mainnet.quiknode.pro/xxxxx/
   ```

---

## 4. Wallet Private Key (HANYA kalau mau live trading)

⚠️ **SKIP ini kalau cuma mau dry-run testing.**

### Export private key dari wallet
**Phantom:**
1. Settings → Show Secret Recovery Phrase
2. Export private key (base58 format)

**Solflare:**
1. Settings → Export Private Key
2. Copy base58 string

### Isi ke `.env`
```bash
SOLANA_PRIVATE_KEY=your_base58_private_key_here
```

⚠️ **JANGAN COMMIT `.env` KE GIT** — private key ini akses penuh ke wallet lu.

---

## 5. Jupiter API Key (HANYA kalau mau live trading)

### Dapetin key
1. Buka https://station.jup.ag/api-keys
2. Connect wallet
3. Generate API key
4. Copy key

### Isi ke `.env`
```bash
JUPITER_API_KEY=your_jupiter_key_here
```

---

## 6. GMGN API Key (Optional, tapi recommended)

**GMGN nambah data holder count, liquidity, fee, social links.**

### Dapetin key
1. Daftar di https://gmgn.ai
2. Generate API key dari dashboard
3. Copy key

### Isi ke `.env`
```bash
GMGN_ENABLED=true
GMGN_API_KEY=your_gmgn_key_here
```

Kalau gak mau pake GMGN:
```bash
GMGN_ENABLED=false
```

---

## 7. LLM API Key (Optional, tapi recommended)

**LLM screening bantu pilih token terbaik dari kandidat.**

### Option 1: MiniMax (default)
1. Daftar di https://platform.minimaxi.com
2. Create API key
3. Isi ke `.env`:
   ```bash
   ENABLE_LLM=true
   LLM_BASE_URL=https://api.minimax.io/v1
   LLM_API_KEY=your_minimax_key_here
   LLM_MODEL=MiniMax-M2.7
   ```

### Option 2: OpenAI
```bash
ENABLE_LLM=true
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

### Option 3: Anthropic
```bash
ENABLE_LLM=true
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-3-5-sonnet-20241022
```

Kalau gak mau pake LLM (rule-based only):
```bash
ENABLE_LLM=false
```

---

## 8. Trading Mode

**Pilih mode operasi:**

```bash
# Dry-run: simulasi aja, gak execute trade beneran (AMAN buat testing)
TRADING_MODE=dry_run

# Confirm: minta konfirmasi via Telegram sebelum tiap buy
TRADING_MODE=confirm

# Live: auto-execute (BAHAYA - test dulu pake dry_run/confirm)
TRADING_MODE=live
```

⚠️ **Mulai dari `dry_run` dulu**, baru naik ke `confirm`, baru ke `live` setelah yakin.

---

## Checklist Final

Sebelum run `docker compose up`:

- [ ] `TELEGRAM_BOT_TOKEN` diisi
- [ ] `TELEGRAM_CHAT_ID` diisi
- [ ] `SIGNAL_SERVER_KEY` diisi (contact yunus-0x kalau belum punya)
- [ ] `SOLANA_RPC_URL` + `SOLANA_WS_URL` atau `HELIUS_API_KEY` diisi
- [ ] `TRADING_MODE=dry_run` (jangan langsung live)
- [ ] Kalau mau live: `SOLANA_PRIVATE_KEY` + `JUPITER_API_KEY` diisi
- [ ] Optional: `GMGN_API_KEY` diisi (recommended)
- [ ] Optional: `LLM_API_KEY` diisi (recommended)
- [ ] `.env` **TIDAK** di-commit ke git (udah ada di `.gitignore`)

---

## Test Connection

Setelah `.env` diisi, test dulu sebelum run full:

```bash
# Test Telegram bot
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getMe"

# Test RPC
curl -X POST <YOUR_RPC_URL> \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

# Test signal server (kalau udah punya key)
curl -H "Authorization: Bearer <YOUR_KEY>" \
  "https://api.thecharon.xyz/api/signals?limit=1"
```

---

## Run Charon

Setelah semua diisi:

```bash
cd /var/lib/morph-agency/projects/charon

# Build image
docker compose build

# Run (background)
docker compose up -d

# Check logs
docker compose logs -f charon

# Test bot via Telegram
# Kirim /menu ke bot lu
```

---

## Troubleshooting

### Bot gak respond di Telegram
- Cek `TELEGRAM_BOT_TOKEN` bener
- Cek `TELEGRAM_CHAT_ID` match sama chat lu
- Cek logs: `docker compose logs charon | grep -i telegram`

### "Signal server unreachable"
- Cek `SIGNAL_SERVER_KEY` valid
- Contact yunus-0x kalau belum punya akses

### "RPC error" / "Failed to connect"
- Cek `SOLANA_RPC_URL` valid
- Test manual pake curl (lihat di atas)
- Cek quota RPC provider (Helius free tier ada limit)

### Container exit immediately
- Cek logs: `docker compose logs charon`
- Biasanya missing env var atau invalid config

---

## Security Reminder

- **JANGAN share `.env` file**
- **JANGAN commit private key ke git**
- **Mulai dari dry_run, test dulu sebelum live**
- **Monitor wallet balance tiap hari kalau udah live**
- **Set risk limits (Phase 2) sebelum production**
