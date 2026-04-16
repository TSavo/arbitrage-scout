#!/bin/bash
# Daily arbitrage scout: stock → scan → verify → trends → arbitrage → platforms
# Runs inside the battleaxe Docker container (WORKDIR /app, env from compose)
# or from the Mac checkout. Detects its environment via pwd.

set -euo pipefail

# Container has app at /app; Mac has it under ~/Projects. Both ship env via
# compose (container) or shell-sourced .env.local (Mac).
if [ -d /app ] && [ "$(pwd)" = "/app" ]; then
  : # container — env is already set from compose, pwd is /app
else
  cd ~/Projects/arbitrage-scout-ts
  set -a; source .env.local 2>/dev/null || true; set +a
fi

mkdir -p data
LOG="data/daily-$(date +%Y-%m-%d).log"
exec >> "$LOG" 2>&1
echo "=== $(date) ==="

# 1. Download fresh PriceCharting CSVs
echo "[1/7] Downloading CSVs..."
curl --max-time 120 -so /tmp/pc-videogames.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}"
curl --max-time 120 -so /tmp/pc-pokemon.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=pokemon-cards"
curl --max-time 120 -so /tmp/pc-magic.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=magic-cards"
curl --max-time 120 -so /tmp/pc-yugioh.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=yugioh-cards"
curl --max-time 120 -so /tmp/pc-onepiece.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=one-piece-cards"
curl --max-time 120 -so /tmp/pc-funko.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=funko-pops"
curl --max-time 120 -so /tmp/pc-lego.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=lego-sets"
curl --max-time 120 -so /tmp/pc-comics.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=comics"
curl --max-time 120 -so /tmp/pc-coins.csv "https://www.pricecharting.com/price-guide/download-custom?t=${PC_API_KEY}&category=coins"
echo "CSVs downloaded"

# 2. Stock catalog with fresh prices + embed new products
echo "[2/7] Stocking catalog..."
npx tsx src/cli.ts stock

# 3. Scan all marketplaces (headless — no Cloudflare interaction)
echo "[3/7] Scanning marketplaces..."
npx tsx src/cli.ts scan

# 4. Verify opportunity URLs are still valid
echo "[4/7] Verifying opportunities..."
npx tsx src/cli.ts verify

# 5. Trend detection
echo "[5/7] Detecting trends..."
npx tsx src/cli.ts trends

# 6. Cross-marketplace arbitrage
echo "[6/7] Finding arbitrage..."
npx tsx src/cli.ts arbitrage

# 7. Platform analysis
echo "[7/7] Analyzing platforms..."
npx tsx src/cli.ts platforms

echo "=== Done $(date) ==="
