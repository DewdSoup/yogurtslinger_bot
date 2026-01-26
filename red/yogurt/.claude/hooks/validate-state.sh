#!/bin/bash
# State Validation Hook
#
# Purpose: Validate CURRENT_STATE.json after edits
# Triggers: After edits to CURRENT_STATE.json
#
# Checks:
# - JSON syntax validity
# - Required fields present
# - No workaround references

set -e

STATE_FILE="CURRENT_STATE.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${YELLOW}Validating CURRENT_STATE.json${NC}"
echo "=============================="
echo ""

# Check 1: JSON syntax
echo -n "JSON syntax: "
if jq empty "$STATE_FILE" 2>/dev/null; then
    echo -e "${GREEN}VALID${NC}"
else
    echo -e "${RED}INVALID${NC}"
    echo "Fix JSON syntax errors before proceeding."
    exit 1
fi

# Check 2: Required fields
echo -n "Required fields: "
REQUIRED_FIELDS=("lastUpdated" "activeLayer" "currentVenue" "venueStatus" "nextActions")
MISSING=""

for field in "${REQUIRED_FIELDS[@]}"; do
    if ! jq -e ".$field" "$STATE_FILE" > /dev/null 2>&1; then
        MISSING="$MISSING $field"
    fi
done

if [ -z "$MISSING" ]; then
    echo -e "${GREEN}PRESENT${NC}"
else
    echo -e "${RED}MISSING:$MISSING${NC}"
    exit 1
fi

# Check 3: No NEW workaround implementations
# Note: Historical references in removedWorkarounds, decisions, etc. are allowed
echo -n "Workaround check: "

# Check if any workaround is being proposed as a FIX (not as a historical removal)
# Look for patterns in the issues array with status != "QUARANTINED" or "REMOVED"
BAD_FIX=$(jq -r '
  .venueStatus | to_entries[] | .value.issues[]? |
  select(.status != "QUARANTINED" and .status != "REMOVED" and .status != "FIXED") |
  select(.fix? | test("feeOracle|feeOverrideBps|--dynamic-fee|learnedFee|observedFee"; "i") // false) |
  .id
' "$STATE_FILE" 2>/dev/null)

if [ -n "$BAD_FIX" ]; then
    echo -e "${RED}WORKAROUND PROPOSED AS FIX${NC}"
    echo ""
    echo "Issue(s) proposing workarounds: $BAD_FIX"
    exit 1
else
    echo -e "${GREEN}CLEAN${NC}"
fi

# Check 4: No forbidden terminology
echo -n "Terminology: "
FORBIDDEN_TERMS="\"simulation\"|\"phase\"|\"workaround\""

# Allow terms in historical context (removedWorkarounds, decisions about workarounds)
if grep -E "$FORBIDDEN_TERMS" "$STATE_FILE" | grep -vE "removedWorkarounds|Workaround|workaround that" > /dev/null 2>&1; then
    echo -e "${YELLOW}WARNING - Review terminology${NC}"
else
    echo -e "${GREEN}OK${NC}"
fi

echo ""
echo -e "${GREEN}Validation passed.${NC}"
echo ""
