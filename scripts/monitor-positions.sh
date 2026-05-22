#!/bin/bash
# Position monitoring script for Charon trading bot
# Copies DB from container to temp file, queries positions, reports to Discord

set -euo pipefail

CONTAINER_NAME="charon-engine"
DB_TMP="/tmp/charon-monitor.db"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Helper: run docker via sg if direct access fails
docker_cmd() {
  if docker ps >/dev/null 2>&1; then
    docker "$@"
  else
    sg docker "docker $*"
  fi
}

# Check if container is running
RUNNING=$(docker_cmd ps --format '{{.Names}}' 2>/dev/null | grep -c "^${CONTAINER_NAME}$" || true)
if [ "$RUNNING" -eq 0 ]; then
  echo "❌ Container ${CONTAINER_NAME} is not running"
  exit 1
fi

# Copy database from container
docker_cmd cp "${CONTAINER_NAME}:/app/data/charon.db" "$DB_TMP" 2>/dev/null || {
  echo "❌ Failed to copy database from container"
  exit 1
}

# Query positions
QUERY="SELECT 
  id, symbol, mint, entry_price, entry_mcap, high_water_price, high_water_mcap,
  size_sol, tp_percent, sl_percent, opened_at_ms, pnl_percent, pnl_sol
FROM dry_run_positions 
WHERE status = 'open' 
ORDER BY opened_at_ms DESC
LIMIT 10;"

RESULT=$(sqlite3 "$DB_TMP" -separator '|' "$QUERY" 2>&1) || {
  echo "❌ Database query failed: $RESULT"
  rm -f "$DB_TMP"
  exit 1
}

# Cleanup
rm -f "$DB_TMP"

# Empty result = no positions
if [ -z "$RESULT" ]; then
  echo "📍 **Charon Position Monitor**"
  echo "No open positions"
  exit 0
fi

# Count
POSITION_COUNT=$(echo "$RESULT" | wc -l)

# Calculate aggregate PnL
TOTAL_PNL_SOL=$(echo "$RESULT" | awk -F'|' '{sum+=$13} END {printf "%.4f", sum}')
AVG_PNL_PCT=$(echo "$RESULT" | awk -F'|' '{sum+=$12; n++} END {if(n>0) printf "%+.2f", sum/n; else print "0"}')

# Header
echo "📍 **Charon Position Monitor**"
echo "${POSITION_COUNT} open · Avg PnL: ${AVG_PNL_PCT}% · Total: ${TOTAL_PNL_SOL} SOL"
echo ""

# Format each position
echo "$RESULT" | while IFS='|' read -r id symbol mint entry_price entry_mcap hw_price hw_mcap size_sol tp sl opened_ms pnl_pct pnl_sol; do
  # PnL emoji
  if awk "BEGIN {exit !($pnl_pct >= 0)}"; then
    pnl_emoji="📈"
  else
    pnl_emoji="📉"
  fi
  
  # Time since open
  now_ms=$(date +%s%3N)
  age_ms=$((now_ms - opened_ms))
  age_min=$((age_ms / 60000))
  if [ "$age_min" -lt 60 ]; then
    age_str="${age_min}m"
  elif [ "$age_min" -lt 1440 ]; then
    age_str="$((age_min / 60))h $((age_min % 60))m"
  else
    age_str="$((age_min / 1440))d"
  fi
  
  # Format numbers
  entry_p=$(awk "BEGIN {printf \"%.6f\", $entry_price}")
  curr_p=$(awk "BEGIN {printf \"%.6f\", $hw_price}")
  entry_mc=$(awk "BEGIN {printf \"%.0f\", $entry_mcap}")
  curr_mc=$(awk "BEGIN {printf \"%.0f\", $hw_mcap}")
  size_f=$(awk "BEGIN {printf \"%.4f\", $size_sol}")
  pnl_p=$(awk "BEGIN {printf \"%+.2f\", $pnl_pct}")
  pnl_s=$(awk "BEGIN {printf \"%+.4f\", $pnl_sol}")
  tp_f=$(awk "BEGIN {printf \"%+.0f\", $tp}")
  sl_f=$(awk "BEGIN {printf \"%+.0f\", $sl}")
  
  echo "${pnl_emoji} **${symbol}** \`#${id}\` (${age_str})"
  echo "  Entry: \$${entry_p} @ \$${entry_mc}"
  echo "  Now:   \$${curr_p} @ \$${curr_mc}"
  echo "  PnL:   ${pnl_p}% (${pnl_s} SOL)"
  echo "  Size:  ${size_f} SOL · TP ${tp_f}% / SL ${sl_f}%"
  echo ""
done

exit 0
