# Charon Docker Deployment

Production-ready Docker setup for Charon with persistent data, health checks, and optional monitoring stack.

## Quick Start

### 1. Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- Signal server access (contact maintainer)
- Telegram bot token
- Solana RPC endpoint (Helius/QuickNode)

### 2. Configuration

```bash
# Copy example env
cp .env.docker.example .env

# Edit with your credentials
nano .env
```

**Required variables:**
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `SIGNAL_SERVER_URL`
- `SIGNAL_SERVER_KEY`
- `SOLANA_RPC_URL`
- `SOLANA_WS_URL`

**For live trading (optional):**
- `SOLANA_PRIVATE_KEY`
- `JUPITER_API_KEY`
- Set `TRADING_MODE=live`

### 3. Build and Run

```bash
# Build image
docker compose build

# Start in background
docker compose up -d

# View logs
docker compose logs -f charon

# Check status
docker compose ps
```

### 4. Verify

```bash
# Check syntax
docker compose run --rm charon npm run check

# View SQLite data
docker compose exec charon ls -lh /app/data/

# Test Telegram connection (check bot responds)
# Send /menu to your configured Telegram chat
```

## Data Persistence

SQLite database and logs persist in Docker volumes:

```bash
# List volumes
docker volume ls | grep charon

# Backup database
docker compose exec charon cat /app/data/charon.db > backup-$(date +%Y%m%d).db

# Restore database
docker compose cp backup-20260521.db charon:/app/data/charon.db
docker compose restart charon
```

## Monitoring (Optional)

Uncomment Prometheus + Grafana services in `docker-compose.yml`:

```bash
docker compose up -d prometheus grafana
```

Access:
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3001 (admin/admin)

## Maintenance

### Update to latest code

```bash
git pull origin main
docker compose build
docker compose up -d
```

### View resource usage

```bash
docker stats charon-engine
```

### Clean up

```bash
# Stop and remove containers
docker compose down

# Remove volumes (WARNING: deletes all data)
docker compose down -v
```

## Troubleshooting

### Container exits immediately

Check logs:
```bash
docker compose logs charon
```

Common issues:
- Missing required env vars
- Invalid Telegram token
- Signal server unreachable
- SQLite permission error

### Database locked

```bash
# Stop container
docker compose stop charon

# Check for stale lock
docker compose exec charon ls -lh /app/data/

# Remove WAL files if safe
docker compose exec charon rm /app/data/charon.db-shm /app/data/charon.db-wal

# Restart
docker compose start charon
```

### Out of memory

Increase Docker memory limit or reduce:
- `LLM_CANDIDATE_PICK_COUNT`
- `POSITION_CHECK_MS` (increase interval)
- `SIGNAL_POLL_MS` (increase interval)

## Security Notes

- **Never commit `.env` to git**
- Keep `SOLANA_PRIVATE_KEY` encrypted at rest
- Use read-only RPC endpoints when possible
- Start with `TRADING_MODE=dry_run`
- Test thoroughly before `TRADING_MODE=live`
- Monitor wallet balance and open positions daily
- Set conservative risk limits (Phase 2 enhancements)

## Production Checklist

- [ ] `.env` configured with real credentials
- [ ] `TRADING_MODE=dry_run` for initial testing
- [ ] Telegram bot responds to `/menu`
- [ ] Signal server returns data
- [ ] GMGN enrichment working (if enabled)
- [ ] LLM screening working (if enabled)
- [ ] Database persists across restarts
- [ ] Logs are readable and not flooding
- [ ] Wallet reconciliation tested (Phase 2)
- [ ] Risk limits configured (Phase 2)
- [ ] Backup strategy in place

## Support

For issues:
1. Check logs: `docker compose logs -f charon`
2. Verify config: `docker compose config`
3. Test connectivity: `docker compose exec charon ping -c 3 api.thecharon.xyz`
4. Review implementation plan: `docs/IMPLEMENTATION_PLAN.md`
