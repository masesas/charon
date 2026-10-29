# Lihat config saat ini
node scripts/update-params.mjs smart_money --list

# Preview perubahan (TIDAK menulis)
node scripts/update-params.mjs smart_money sl_percent=-15 trailing_percent=20 --dry-run

# Terapkan (dengan reason untuk audit)
node scripts/update-params.mjs smart_money sl_percent=-15 --reason "tighten SL" --yes

# Update settings table global
node scripts/update-params.mjs settings llm_min_confidence=60 --yes


node scripts/update-params.mjs smart_money min_liquidity_usd=5000 --yes