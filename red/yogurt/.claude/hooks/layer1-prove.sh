#!/bin/bash
# Layer 1 Change Notification Hook
#
# Purpose: Remind to verify Layer 1 changes via proving run
# Triggers: After edits to src/sim/math/, src/decode/programs/, src/cache/
#
# This hook does NOT block - it only suggests next steps.

set -e

# Colors for output
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo ""
echo -e "${YELLOW}Layer 1 Change Detected${NC}"
echo "========================"
echo ""
echo "A Layer 1 file was modified. To verify your changes:"
echo ""
echo -e "${GREEN}1. Typecheck:${NC}"
echo "   pnpm typecheck"
echo ""
echo -e "${GREEN}2. Build:${NC}"
echo "   pnpm build"
echo ""
echo -e "${GREEN}3. Prove:${NC}"
echo "   npx tsx scripts/prove-infrastructure.ts --venue pumpswap --limit 5000"
echo ""
echo "Remember: NO BANDAIDS - fixes must be in Layer 1 infrastructure."
echo ""
