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
sudo rm -rf ${REMOTE_ROOT}.old
if [ -d ${REMOTE_ROOT} ]; then sudo mv ${REMOTE_ROOT} ${REMOTE_ROOT}.old; fi
sudo mv ${REMOTE_ROOT}.new ${REMOTE_ROOT}
sudo rm -rf ${REMOTE_ROOT}.old
rm -f /tmp/docs-dist.tgz
echo \"  \$(sudo find ${REMOTE_ROOT} -type f | wc -l) files, \$(sudo du -sh ${REMOTE_ROOT} | cut -f1)\"
"

rm -f "$TARBALL"

cyan "› verifying"
# Served through Caddy itself with a Host header rather than a throwaway HTTP
# server: it exercises the real vhost, and it avoids pkill — which, matching on a
# command line, cheerfully killed its own SSH session the first time round.
gcloud compute ssh "$INSTANCE" --zone "$ZONE" --quiet --command "
for p in / /quickstart /ar/quickstart /ja/quickstart /llms.txt /sitemap.xml; do
  code=\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: docs.libertynet.ai' http://localhost\$p)
  # 308 is Caddy redirecting to HTTPS, which is the correct answer over plain HTTP.
  printf '  %-24s %s\n' \"\$p\" \"\$code\"
done
echo
echo \"  on disk: \$(sudo find ${REMOTE_ROOT} -type f | wc -l) files\"
"

cyan "✓ deployed"
echo
echo "  Live at https://docs.libertynet.ai once DNS resolves."
echo "  Until then Caddy cannot obtain a certificate, because ACME needs the"
echo "  name to point here first. Nothing else is missing:"
echo
echo "    A  docs  →  34.21.237.177   (Namecheap, libertynet.ai zone)"
echo
echo "  Caddy issues the certificate automatically within about a minute of"
echo "  that record propagating. No further deploy is needed."
