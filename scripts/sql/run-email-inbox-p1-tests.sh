#!/usr/bin/env bash
# Runs the email inbox P1 migration + behavior tests inside one transaction on
# the LINKED project and rolls everything back. Dev only: refuses any ref but yukti-dev.
set -euo pipefail
cd "$(dirname "$0")/../.."

DEV_REF="hcpzbnmumbykdqveyjhr"
LINKED_REF="$(cat supabase/.temp/project-ref)"
if [ "$LINKED_REF" != "$DEV_REF" ]; then
  echo "linked ref ($LINKED_REF) is not yukti-dev; refusing" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
{
  echo "BEGIN;"
  cat supabase/migrations/20261023112240_email_inbox_p1.sql
  cat supabase/migrations/20261023133017_email_inbox_p1_hardening.sql
  cat scripts/sql/email_inbox_p1_behavior.sql
  echo "ROLLBACK;"
} > "$TMP/run.sql"

npx supabase db query --linked --file "$TMP/run.sql"
