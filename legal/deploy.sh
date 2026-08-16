#!/usr/bin/env bash
#
# Deploy the Privacy and Terms pages to libertynet.ai/privacy and libertynet.ai/terms.
#
#     legal/deploy.sh
#
# WHY THESE ARE NOT IN THE DOCS SITE
# ----------------------------------
# They live at the apex, not under docs.libertynet.ai, because a link to your privacy policy is
# supposed to be short and stable and to keep working when the docs toolchain is replaced. They
# are three hand-written files with no build step for the same reason: these two pages must still
# render correctly in five years, on a browser nobody has tested, after everything else in this
# repository has been rewritten twice.
#
# WHY THEY ARE NOT DROPPED INTO /var/www/libertynet
# -------------------------------------------------
# That directory is hand-managed and is not a checkout of anything — which is exactly why the apex
# has no index page and nobody can say what is in it. Putting versioned files into an unversioned
# directory makes them unversioned. These get their own root and their own Caddy handle, so what
# is live is always what is in this repository.

set -euo pipefail

ZONE="asia-southeast1-b"
INSTANCE="libertynet-node-1"
REMOTE_ROOT="/var/www/libertynet-legal"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cyan() { printf '\033[38;5;43m%s\033[39m\n' "$1"; }
red()  { printf '\033[38;5;203m%s\033[39m\n' "$1"; }

cyan "› packing"
TAR="$(mktemp -d)/legal.tar.gz"
tar -czf "$TAR" -C "$HERE" privacy terms style.css

cyan "› shipping"
gcloud compute scp "$TAR" "$INSTANCE:/tmp/legal.tar.gz" --zone "$ZONE" >/dev/null

cyan "› unpacking"
# Unpacked beside the live directory and swapped, so a visitor never sees a half-written tree.
gcloud compute ssh "$INSTANCE" --zone "$ZONE" --command "
set -e
sudo mkdir -p ${REMOTE_ROOT}.new && sudo rm -rf ${REMOTE_ROOT}.new/*
sudo tar -xzf /tmp/legal.tar.gz -C ${REMOTE_ROOT}.new
sudo rm -rf ${REMOTE_ROOT}.prev
if [ -d ${REMOTE_ROOT} ]; then sudo mv ${REMOTE_ROOT} ${REMOTE_ROOT}.prev; fi
sudo mv ${REMOTE_ROOT}.new ${REMOTE_ROOT}
sudo chown -R root:root ${REMOTE_ROOT}
rm -f /tmp/legal.tar.gz
" >/dev/null

cyan "› verifying from outside"
fail=0
for path in /privacy /terms /legal-assets/style.css; do
  code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' -L "https://libertynet.ai${path}")"
  if [ "$code" = "200" ]; then
    printf '  %-24s %s\n' "$path" "$code"
  else
    red "  $path -> $code"
    fail=1
  fi
done

# Not just a 200. A 200 that is the SPA shell, or the apex 404 page, or a stale copy, is the
# failure this check exists to catch — and all three look identical to `curl -o /dev/null`.
for path in /privacy /terms; do
  if ! curl -s -m 15 -L "https://libertynet.ai${path}" | grep -q 'This is not legal advice'; then
    red "  $path returned 200 but is not the page we deployed"
    fail=1
  fi
done

[ "$fail" -eq 0 ] || { red "✗ deploy verified as broken"; exit 1; }
cyan "✓ live: https://libertynet.ai/privacy and https://libertynet.ai/terms"
