#!/usr/bin/env bash
# The one release gate. CI runs exactly this. Prints ALL GREEN only if every step passed.
# Default run needs no AWS keys and spends no money: OVERHEAR_MODELS=mock, OVERHEAR_STORE=local.
# Live AWS checks live behind `verify.sh --live` (adapter contract tests + latency bench).
set -euo pipefail

LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1

step() { printf '\n== %s\n' "$*"; }

step "install";        npm ci --no-audit --no-fund
step "format";         npx prettier --check .
step "typecheck";      npx tsc -b --pretty false
step "typecheck:web";  npm run --silent typecheck -w @overhear/sim-web
step "lint";           npx eslint . --max-warnings 0
step "unit+property";  npx vitest run --reporter=dot
step "licences";       node scripts/check-licences.mjs
step "audit";          npm audit --omit=dev --audit-level=high
step "build";          npx tsc -b
step "build:web";      npm run --silent build -w @overhear/sim-web

step "server up";      OVERHEAR_DATA_DIR="$(mktemp -d)" OVERHEAR_MEDIA_DIR="$(mktemp -d)" OVERHEAR_MODELS=mock OVERHEAR_STORE=local OVERHEAR_TOKENS_FILE=fixtures/server-tokens-2 node packages/server/dist/main.js &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
node scripts/wait-for.mjs http://127.0.0.1:8787/health 30

step "conformance";    node packages/conformance/dist/cli.js http://127.0.0.1:8787/mcp --token-file fixtures/test-token --token2-file fixtures/test-token2 --timeout 60000
step "e2e session";    node scripts/e2e-session.mjs --mock
step "ui gates";       node scripts/ui-gates.mjs

if [[ "$LIVE" == "1" ]]; then
  step "live adapters"; OVERHEAR_LIVE_TESTS=1 npx vitest run packages/server/src/adapters
  step "latency bench"; node scripts/bench-latency.mjs
fi

echo
echo "ALL GREEN"
