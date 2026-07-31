#!/usr/bin/env bash
#
# Publish the SDKs to npm and PyPI.
#
#     ./tools/publish.sh --dry-run     # verify everything, publish nothing
#     ./tools/publish.sh               # actually publish
#
# Everything except the final upload has already been done and verified — see
# TEST-EVIDENCE.md §P4. What this script needs from you is credentials, and it
# reads them from the environment so no token is ever typed into a prompt that
# might be logged, or committed to a file that might be pushed:
#
#     export NPM_TOKEN=...        # npmjs.com → Access Tokens → Automation
#     export PYPI_TOKEN=pypi-...  # pypi.org  → Account settings → API tokens
#
# Both packages are `0.1.0`. Publishing is irreversible: npm and PyPI do not
# allow re-uploading a version, even after an unpublish. Run --dry-run first.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

cyan() { printf '\033[38;5;43m%s\033[39m\n' "$1"; }
warn() { printf '\033[38;5;215m%s\033[39m\n' "$1"; }
fail() { printf '\033[38;5;210m%s\033[39m\n' "$1" >&2; exit 1; }

# --- names -------------------------------------------------------------------
# `@libertynet/sdk` is NOT ours — it was published in 2022 by an unrelated
# maintainer, so the whole `@libertynet` scope is unavailable. These names were
# checked against both registries and are free.
NPM_PKG="libertynet-sdk"
PYPI_PKG="libertynet"

cyan "› checking the names are still free"
npm_status=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/${NPM_PKG}")
pypi_status=$(curl -s -o /dev/null -w '%{http_code}' "https://pypi.org/pypi/${PYPI_PKG}/json")
printf '  npm  %-18s %s\n' "$NPM_PKG" "$([ "$npm_status" = 404 ] && echo free || echo "EXISTS (HTTP $npm_status)")"
printf '  pypi %-18s %s\n' "$PYPI_PKG" "$([ "$pypi_status" = 404 ] && echo free || echo "EXISTS (HTTP $pypi_status)")"

# --- tests -------------------------------------------------------------------
cyan "› running the full suite first"
node "$HERE/tools/check-all.mjs" || fail "suite failed — not publishing"

# --- npm ---------------------------------------------------------------------
cyan "› npm: building and packing"
cd "$HERE/sdk/typescript"
npm ci --silent --no-audit --no-fund 2>/dev/null || npm install --silent --no-audit --no-fund
npm run build

if $DRY_RUN; then
  npm pack --dry-run 2>&1 | tail -8
else
  [[ -n "${NPM_TOKEN:-}" ]] || fail "NPM_TOKEN is not set. See the header of this script."
  # Written to a temp file rather than ~/.npmrc so the token never lands in a
  # dotfile that outlives this run.
  NPMRC="$(mktemp)"
  trap 'rm -f "$NPMRC"' EXIT
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
  npm publish --userconfig "$NPMRC" --access public
  cyan "  published https://www.npmjs.com/package/${NPM_PKG}"
fi

# --- PyPI --------------------------------------------------------------------
cyan "› pypi: building and checking"
cd "$HERE/sdk/python"
rm -rf dist build ./*.egg-info
python3 -m venv /tmp/ln-publish-venv >/dev/null
/tmp/ln-publish-venv/bin/pip install --quiet build twine
/tmp/ln-publish-venv/bin/python -m build --outdir dist
/tmp/ln-publish-venv/bin/python -m twine check dist/*

if $DRY_RUN; then
  ls -lh dist/
else
  [[ -n "${PYPI_TOKEN:-}" ]] || fail "PYPI_TOKEN is not set. See the header of this script."
  TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_TOKEN" \
    /tmp/ln-publish-venv/bin/python -m twine upload dist/*
  cyan "  published https://pypi.org/project/${PYPI_PKG}/"
fi

# --- after -------------------------------------------------------------------
if $DRY_RUN; then
  echo
  warn "Dry run — nothing was published."
  echo "  Set NPM_TOKEN and PYPI_TOKEN, then run without --dry-run."
else
  cyan "✓ published"
  echo
  echo "  Verify from a clean machine:"
  echo "    npm install ${NPM_PKG}"
  echo "    pip install ${PYPI_PKG}"
  echo
  warn "  Then remove the 'not published yet' notices from the docs:"
  echo "    docs-site/sdk/overview.mdx · typescript.mdx · python.mdx · cli.mdx"
  echo "  Those notices exist so the docs never claim an install command works"
  echo "  before it does. They come out in the same commit that makes it true."
fi
