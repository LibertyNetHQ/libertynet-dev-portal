#!/usr/bin/env bash
#
# Deploy the canonical demo node to node-1.
#
#     ./demo-node/deploy.sh
#
# Runs on 127.0.0.1:3100 and is exposed by the existing Caddy at
# https://libertynet.ai/demo-node/ — a path on a domain that already has a
# certificate, so this needs no new DNS record and no new TLS setup.
#
# The node generates its own Ed25519 identity on first run and keeps it at 0600.
# That key signs its registration, its heartbeats and its demo responses, and
# nothing else. It is not David's key and it guards nothing of value.

set -euo pipefail

ZONE="asia-southeast1-b"
INSTANCE="libertynet-node-1"
PUBLIC_URL="https://libertynet.ai/demo-node"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cyan() { printf '\033[38;5;43m%s\033[39m\n' "$1"; }

cyan "› uploading"
gcloud compute scp "$HERE/server.py" "$INSTANCE:/tmp/demo-node-server.py" --zone "$ZONE" --quiet

cyan "› installing"
gcloud compute ssh "$INSTANCE" --zone "$ZONE" --quiet --command "
set -e
sudo mkdir -p /opt/libertynet-demo-node /var/lib/libertynet-demo-node
sudo mv /tmp/demo-node-server.py /opt/libertynet-demo-node/server.py
sudo chmod 755 /opt/libertynet-demo-node/server.py

# A venv rather than system packages: node-1 also runs the registry, and this
# demo has no business changing its interpreter's dependency set.
if [ ! -x /opt/libertynet-demo-node/venv/bin/python ]; then
  sudo apt-get install -y -qq python3-venv >/dev/null 2>&1 || true
  sudo python3 -m venv /opt/libertynet-demo-node/venv
  sudo /opt/libertynet-demo-node/venv/bin/pip install --quiet --upgrade pip
  sudo /opt/libertynet-demo-node/venv/bin/pip install --quiet cryptography
fi

sudo tee /etc/systemd/system/libertynet-demo-node.service > /dev/null <<UNIT
[Unit]
Description=LibertyNet canonical demo node
Documentation=https://docs.libertynet.ai/quickstart
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/libertynet-demo-node/venv/bin/python /opt/libertynet-demo-node/server.py \\
  --host 127.0.0.1 --port 3100 \\
  --endpoint ${PUBLIC_URL} \\
  --key /var/lib/libertynet-demo-node/identity.key \\
  --region asia-southeast
Restart=always
RestartSec=5

# It listens on loopback only, holds one key that guards nothing, and needs no
# access to anything else on the box. Lock it down accordingly.
DynamicUser=no
User=root
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/libertynet-demo-node
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=128M

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now libertynet-demo-node
sleep 3
systemctl is-active libertynet-demo-node
"

cyan "› wiring Caddy"
gcloud compute ssh "$INSTANCE" --zone "$ZONE" --quiet --command "
set -e
if sudo grep -q 'demo-node' /etc/caddy/Caddyfile; then
  echo '  route already present'
else
  sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-demonode
  # Insert the handler inside the existing libertynet.ai block, immediately
  # after its opening brace, so it takes precedence over the static file_server.
  sudo python3 - <<'PY'
path = '/etc/caddy/Caddyfile'
src = open(path).read()
marker = 'libertynet.ai {'
i = src.index(marker) + len(marker)
block = '''
	# Canonical demo node — a real, publicly reachable LibertyNet node so the
	# quickstart's discover -> verify -> act loop is true from outside.
	handle /demo-node* {
		reverse_proxy localhost:3100
	}
'''
open(path, 'w').write(src[:i] + block + src[i:])
PY
  sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && echo '  config valid'
  sudo systemctl reload caddy
fi
"

cyan "› verifying from the public internet"
sleep 4
for p in /health /identity; do
  printf '  %-12s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "${PUBLIC_URL}${p}")"
done

cyan "✓ deployed"
echo
echo "  ${PUBLIC_URL}/health"
echo "  ${PUBLIC_URL}/identity"
echo "  curl -s -X POST ${PUBLIC_URL}/echo -d '{\"nonce\":\"hello\"}'"
