#!/usr/bin/env bash
# scripts/check.sh
# Runs the full pre-demo check suite: type-check + tests.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== TypeScript type-check ==="
npm run typecheck

echo ""
echo "=== Test suite ==="
npm test

echo ""
echo "=== All checks passed ==="
