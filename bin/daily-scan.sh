#!/bin/bash
# Daily arbitrage scout: stock → scan → trends → arbitrage → platforms
# Run via cron: 0 13 * * * ~/Projects/arbitrage-scout-ts/bin/daily-scan.sh
# (6am Pacific = 13:00 UTC)

set -euo pipefail
cd ~/Projects/arbitrage-scout-ts

LOG="data/daily-$(date +%Y-%m-%d).log"
exec &>> "$LOG"
echo "=== $(date) ==="

# Load env
set -a
source .env.local 2>/dev/null || true
set +a
export DB_PATH=data/scout-v2.db

# 1. Download fresh PriceCharting CSVs
echo "[1/6] Downloading CSVs..."
curl -so /tmp/pc-videogames.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}"
curl -so /tmp/pc-pokemon.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=pokemon-cards"
curl -so /tmp/pc-magic.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=magic-cards"
echo "CSVs downloaded"

# 2. Stock catalog with fresh prices (new price_points for today)
echo "[2/6] Stocking catalog..."
npx tsx src/cli.ts stock

# 3. Scan all marketplaces
echo "[3/6] Scanning marketplaces..."
npx tsx src/cli.ts scan

# 4. Trend detection
echo "[4/6] Detecting trends..."
npx tsx src/cli.ts trends

# 5. Cross-marketplace arbitrage
echo "[5/6] Finding arbitrage..."
npx tsx src/cli.ts arbitrage

# 6. Platform analysis
echo "[6/6] Analyzing platforms..."
npx tsx src/cli.ts platforms

echo "=== Done $(date) ==="
