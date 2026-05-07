#!/usr/bin/env bash
# RestaurantIQ smoke check — runs on SessionStart so Claude has a fresh
# health snapshot of the project before any work begins. Non-blocking:
# results print regardless of pass/fail.

set -u

ROOT="/Volumes/Untitled/RestaurantIQ/RestaurantIQ"
BE="$ROOT/restaurantiq-backend"
FE="$ROOT/restaurantiq-frontend"

results=""
ok()   { results+="  ✓ $1"$'\n'; }
fail() { results+="  ✗ $1"$'\n'; }

# 1. env files present and non-empty
[ -s "$BE/.env" ] && ok "backend  .env present"   || fail "backend  .env missing/empty"
[ -s "$FE/.env" ] && ok "frontend .env present"   || fail "frontend .env missing/empty"

# 2. key dependencies installed
[ -d "$BE/node_modules/jose" ]                    && ok "backend  dep: jose"                 || fail "backend  dep missing: jose"
[ -d "$BE/node_modules/square" ]                  && ok "backend  dep: square"               || fail "backend  dep missing: square"
[ -d "$BE/node_modules/@supabase/supabase-js" ]   && ok "backend  dep: @supabase/supabase-js" || fail "backend  dep missing: @supabase/supabase-js"
[ -d "$FE/node_modules/@supabase/supabase-js" ]   && ok "frontend dep: @supabase/supabase-js" || fail "frontend dep missing: @supabase/supabase-js"

# 3. backend typecheck
if (cd "$BE" && npx tsc --noEmit) >/tmp/riq-be-tsc.log 2>&1; then
  ok "backend  tsc --noEmit clean"
else
  fail "backend  tsc --noEmit failed (see /tmp/riq-be-tsc.log)"
fi

# 4. frontend typecheck
if (cd "$FE" && npx tsc --noEmit) >/tmp/riq-fe-tsc.log 2>&1; then
  ok "frontend tsc --noEmit clean"
else
  fail "frontend tsc --noEmit failed (see /tmp/riq-fe-tsc.log)"
fi

msg="RestaurantIQ smoke check:
$results"

# Emit JSON so the hook system shows the message + injects it into context
jq -Rn --arg m "$msg" '{
  systemMessage: $m,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $m }
}'
