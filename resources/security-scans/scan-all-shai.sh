#!/bin/bash

# Scans all repositories against the Cobenian shai-hulud-detect cumulative IOC list.
#
# The list is permanently maintained and covers all known npm supply-chain attack
# campaigns (Sept 2025 onwards): keyv/cacheable wave, Chalk/debug, AsyncAPI, Axios,
# Mini Shai-Hulud (TanStack, AntV), RedHat/Miasma, Phantom Gyp, Mastra/easy-day-js,
# IRONWORM, and more.  Non-npm entries (pypi:, crates:, composer:, go:) are skipped.
#
# Reference: https://github.com/Cobenian/shai-hulud-detect
#
# Usage:
#   ./scan-all-shai.sh [--iocs /path/to/compromised-packages.txt] [root-dir]

IOC_URL="https://raw.githubusercontent.com/Cobenian/shai-hulud-detect/main/compromised-packages.txt"
IOC_FILE=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
# Default to the defra parent directory (three levels above this script's location)
PARENT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iocs)
      IOC_FILE="$2"
      shift 2
      ;;
    *)
      PARENT_DIR="$1"
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
if ! command -v python3 &> /dev/null; then
  echo "Error: python3 is required but not installed."
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "Error: jq is required but not installed."
  echo "  macOS: brew install jq"
  echo "  Ubuntu: apt install jq"
  exit 1
fi

# ---------------------------------------------------------------------------
# Fetch or validate the IOC list
# ---------------------------------------------------------------------------
if [ -n "$IOC_FILE" ]; then
  if [ ! -f "$IOC_FILE" ]; then
    echo "Error: IOC file not found: $IOC_FILE"
    exit 1
  fi
  echo "Using local IOC list: $IOC_FILE"
else
  IOC_FILE="$(mktemp /tmp/shai-hulud-XXXXXX.txt)"

  echo "Downloading Cobenian shai-hulud IOC list..."
  if ! curl -fsSL "$IOC_URL" -o "$IOC_FILE"; then
    echo "Error: Failed to download IOC list from $IOC_URL"
    echo "  You can supply a local copy with: --iocs /path/to/compromised-packages.txt"
    exit 1
  fi
  echo "  Downloaded $(wc -l < "$IOC_FILE") lines."
fi

# ---------------------------------------------------------------------------
# Parse the IOC list into a deduplicated TSV of "package TAB version"
# Format: [ecosystem:]package:version  (#-prefixed lines are comments)
# Only npm entries (bare or npm: prefix) are included.
# ---------------------------------------------------------------------------
PAIRS_FILE="$(mktemp /tmp/shai-hulud-pairs-XXXXXX.tsv)"
trap 'rm -f "$IOC_FILE" "$PAIRS_FILE"' EXIT

python3 - "$IOC_FILE" > "$PAIRS_FILE" << 'PYEOF'
import sys

NON_NPM_PREFIXES = ('pypi:', 'crates:', 'composer:', 'go:')
pairs = set()

with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if any(line.startswith(p) for p in NON_NPM_PREFIXES):
            continue
        if line.startswith('npm:'):
            line = line[4:]
        # rfind handles scoped packages like @scope/name:version correctly
        idx = line.rfind(':')
        if idx < 1:
            continue
        package, ver = line[:idx].strip(), line[idx+1:].strip()
        if package and ver:
            pairs.add((package, ver))

for package, ver in sorted(pairs):
    print(f"{package}\t{ver}")
PYEOF

total_packages=$(wc -l < "$PAIRS_FILE")

echo "
================================================================================
Supply-Chain Compromise Scanner (shai-hulud — Cobenian cumulative IOC list)
$total_packages npm package@version combinations loaded
Scanning under: $PARENT_DIR
================================================================================
"

total_hits=0
repos_affected=0
declare -a affected_repos=()

# ---------------------------------------------------------------------------
# Helper: check a single file for a package@version hit
# Returns match lines via stdout; sets $? to 0 on hit, 1 on miss
# ---------------------------------------------------------------------------
check_file_for_pkg() {
  local file="$1"
  local pkg="$2"
  local ver="$3"

  # Escape regex metacharacters in package name and version
  local escaped_pkg
  escaped_pkg=$(printf '%s' "$pkg" | sed 's|[.[\*^$()+?{|/]|\\&|g; s/@/\\@/g')
  local escaped_ver
  escaped_ver=$(printf '%s' "$ver" | sed 's/[.[\*^$()+?{|]/\\&/g')

  grep -nE "\"?${escaped_pkg}\"?[^:]*[:\"][ \"]*${escaped_ver}" "$file" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Find repositories: directories containing a lock file or package.json
# (outside node_modules)
# ---------------------------------------------------------------------------
mapfile -t repos < <(
  find "$PARENT_DIR" -type f \( \
    -name "package-lock.json" \
    -o -name "yarn.lock" \
    -o -name "bun.lock" \
    -o -name "package.json" \
  \) \
    ! -path "*/node_modules/*" \
    ! -path "*/.*" \
    -exec dirname {} \; | sort -u
)

total_repos=${#repos[@]}
current_repo=0

echo "Found $total_repos location(s) to scan."
echo ""

for repo_path in "${repos[@]}"; do
  ((current_repo++))
  relative_path="${repo_path#$PARENT_DIR/}"
  [ "$relative_path" = "$repo_path" ] && relative_path=$(basename "$repo_path")

  repo_hit=0
  repo_findings=""

  printf "[%d/%d] Scanning %s ...\n" "$current_repo" "$total_repos" "$relative_path" >&2

  # -------------------------------------------------------------------------
  # 1. Check package.json (direct / dev dependency declarations)
  # -------------------------------------------------------------------------
  pkg_json="$repo_path/package.json"
  if [ -f "$pkg_json" ]; then
    while IFS=$'\t' read -r pkg ver; do
      matches=$(check_file_for_pkg "$pkg_json" "$pkg" "$ver")
      if [ -n "$matches" ]; then
        repo_hit=1
        repo_findings+="    [package.json] ${pkg}@${ver}\n"
        repo_findings+="$(echo "$matches" | sed 's/^/      Line /')\n"
        ((total_hits++))
      fi
    done < "$PAIRS_FILE"
  fi

  # -------------------------------------------------------------------------
  # 2. Check lock files (resolved/transitive dependencies)
  # -------------------------------------------------------------------------
  for lock_file in \
    "$repo_path/package-lock.json" \
    "$repo_path/yarn.lock" \
    "$repo_path/bun.lock"; do
    [ -f "$lock_file" ] || continue
    lock_name=$(basename "$lock_file")

    while IFS=$'\t' read -r pkg ver; do
      matches=$(check_file_for_pkg "$lock_file" "$pkg" "$ver")
      if [ -n "$matches" ]; then
        repo_hit=1
        repo_findings+="    [${lock_name}] ${pkg}@${ver}\n"
        repo_findings+="$(echo "$matches" | sed 's/^/      Line /')\n"
        ((total_hits++))
      fi
    done < "$PAIRS_FILE"
  done

  # -------------------------------------------------------------------------
  # Report per-repo results
  # -------------------------------------------------------------------------
  if [ "$repo_hit" -eq 1 ]; then
    ((repos_affected++))
    affected_repos+=("$relative_path")
    echo "  *** HIT *** $relative_path"
    echo -e "$repo_findings"
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "================================================================================"
echo "SUMMARY"
echo "================================================================================"
echo "Locations scanned : $total_repos"
echo "Package@version combinations checked : $total_packages"
echo "Total hits        : $total_hits"
echo "Repos affected    : $repos_affected"
echo "================================================================================"

if [ "$repos_affected" -gt 0 ]; then
  echo ""
  echo "AFFECTED LOCATIONS:"
  for repo in "${affected_repos[@]}"; do
    echo "  - $repo"
  done
  echo ""
  echo "ACTION REQUIRED: Treat any matched environments as potentially compromised."
  echo "  Update the affected packages and rotate all secrets accessible from those"
  echo "  environments.  See the Wiz Research report for full remediation guidance."
  exit 1
else
  echo ""
  echo "No compromised package versions detected."
  exit 0
fi
