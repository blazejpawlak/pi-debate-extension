#!/usr/bin/env bash
# Fake-runner + offline tests only. Spends NO tokens.
# Real-token tests are run explicitly: test/runner-direct.test.ts (WP4).
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
for t in test/wp1.test.ts test/ledger.test.ts test/roles.test.ts test/wp5-fixes.test.ts test/e2e-fake.ts test/wp6.test.ts test/wp7.test.ts test/runner-direct-offline.test.ts; do
  printf '%-42s ' "$t"
  out=$(npx tsx "$t" 2>&1) || fail=1
  echo "$out" | tail -1
done
tsc_bin=""
type_roots=""
if [ -x ./node_modules/.bin/tsc ]; then
  tsc_bin="./node_modules/.bin/tsc"
  type_roots="./node_modules/@types"
elif [ -x /tmp/tscheck/node_modules/.bin/tsc ]; then
  tsc_bin="/tmp/tscheck/node_modules/.bin/tsc"
  type_roots="/tmp/tscheck/node_modules/@types"
fi
if [ -n "$tsc_bin" ]; then
  printf '%-42s ' "typecheck"
  "$tsc_bin" --noEmit --skipLibCheck --module esnext --target es2022 \
    --moduleResolution bundler --allowImportingTsExtensions --strict \
    --typeRoots "$type_roots" \
    config.ts paths.ts command.ts ledger.ts excerpts.ts prompts.ts verdict.ts \
    manifest.ts orchestrator.ts runner/*.ts test/*.ts && echo "clean" || { echo "ERRORS"; fail=1; }
fi
exit $fail
