#!/usr/bin/env bash
#
# Build and deploy the docs site to node-1.
#
#     ./site/deploy.sh
#
# Self-hosted on the box that already serves libertynet.ai and
# registry.libertynet.ai, behind the same Caddy. No vendor account sits between a
# docs change and it being live.
#
# node-1 has no rsync, so this ships a tarball over `gcloud compute scp` and
# unpacks it there — the same approach the Operator Console deploy uses.

set -euo pipefail

ZONE="asia-southeast1-b"
INSTANCE="libertynet-node-1"
REMOTE_ROOT="/var/www/libertynet-docs"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cyan() { printf '\033[38;5;43m%s\033[39m\n' "$1"; }

cyan "› building"
node "$HERE/build.mjs"

cyan "› packing"
TARBALL="$(mktemp -t docs-dist).tgz"
tar czf "$TARBALL" -C "$HERE/dist" .
printf '  %s\n' "$(du -h "$TARBALL" | cut -f1)"

cyan "› uploading"
gcloud compute scp "$TARBALL" "$INSTANCE:/tmp/docs-dist.tgz" --zone "$ZONE" --quiet

cyan "› installing"
# Unpack into a staging directory and swap, so a half-extracted tree is never
# the thing being served. The swap itself is two renames.
gcloud compute ssh "$INSTANCE" --zone "$ZONE" --quiet --command "
set -e
sudo rm -rf ${REMOTE_ROOT}.new
sudo mkdir -p ${REMOTE_ROOT}.new
sudo tar xzf /tmp/docs-dist.tgz -C ${REMOTE_ROOT}.new
sudo rm -rf ${REMOTE_ROOT}.prev
if [ -d ${REMOTE_ROOT} ]; then sudo cp -a ${REMOTE_ROOT} ${REMOTE_ROOT}.prev; fi
sudo rm -rf ${REMOTE_ROOT}.old
if [ -d ${REMOTE_ROOT} ]; then sudo mv ${REMOTE_ROOT} ${REMOTE_ROOT}.old; fi
sudo mv ${REMOTE_ROOT}.new ${REMOTE_ROOT}
sudo rm -rf ${REMOTE_ROOT}.old
rm -f /tmp/docs-dist.tgz
echo \"  \$(sudo find ${REMOTE_ROOT} -type f | wc -l) files, \$(sudo du -sh ${REMOTE_ROOT} | cut -f1)\"
"

rm -f "$TARBALL"

cyan "› verifying (against the real https:// URL)"

# The gate that matters.
#
# Everything before this point proves files reached a disk. It does not prove
# the site works, and the difference is not academic: a syntax error in site.js
# once killed every interactive feature in production while twenty suites
# stayed green, because all of them asserted about files, HTML and HTTP status
# and none of them asked a browser to run the page.
#
# So the deploy is not finished until Chromium has driven the deployed site at
# its real public URL. If that fails, the previous release goes back — a broken
# build does not get to stay up while somebody investigates.
rollback() {
  printf '\033[38;5;203m%s\033[39m\n' "✗ post-deploy checks FAILED — rolling back"
  gcloud compute ssh "$INSTANCE" --zone "$ZONE" --quiet --command "
    set -e
    if [ -d ${REMOTE_ROOT}.prev ]; then
      sudo rm -rf ${REMOTE_ROOT}.bad
      sudo mv ${REMOTE_ROOT} ${REMOTE_ROOT}.bad
      sudo mv ${REMOTE_ROOT}.prev ${REMOTE_ROOT}
      echo '  restored the previous release'
    else
      echo '  NO PREVIOUS RELEASE TO RESTORE — the site is left as deployed'
      exit 1
    fi
  "
  printf '\033[38;5;203m%s\033[39m\n' "  rolled back; the bad build is at ${REMOTE_ROOT}.bad on ${INSTANCE}"
  exit 1
}

# Caddy holds HTML for 300s. Ask for the fresh copy so the gate reads what was
# just deployed rather than what was cached a minute ago.
sleep 3

if ! LN_SMOKE_BASE="https://docs.libertynet.ai" node "$HERE/test/smoke.browser.mjs"; then
  rollback
fi

# A page whose HTML points at an asset that is not there renders unstyled and
# inert, and no console error necessarily says so.
cyan "› asset references resolve"
ASSETS="$(curl -s https://docs.libertynet.ai/quickstart | grep -oE '(src|href)="/(site|theme)\.[^"]*"' | sed 's/.*="//;s/"$//' | sort -u)"
for a in $ASSETS; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://docs.libertynet.ai$a")"
  cc="$(curl -sI "https://docs.libertynet.ai$a" | grep -i cache-control | tr -d '\r' | cut -d' ' -f2-)"
  printf '  %-28s %s  %s\n' "$a" "$code" "$cc"
  [ "$code" = "200" ] || rollback
done

cyan "✓ deployed and verified live"
echo
echo "  https://docs.libertynet.ai"
