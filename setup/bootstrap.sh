#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Canectic BBS - bootstrap installer
# =============================================================================
#
# The only thing a new sysop touches. It resolves a release, downloads it,
# verifies its checksum, extracts it, and hands off to that release's own
# installer.
#
# No git clone, and no second tree afterwards. The old shape had the sysop
# keeping a source directory whose only purpose was to install the thing beside
# it, which could be stale, on the wrong branch, or at an untagged commit, with
# nothing checking.
#
# This script is deliberately small and deliberately dumb. Everything version
# specific happens in the installer inside the release, so a release can ship a
# fixed installer and it takes effect for THAT install rather than the next one.
# The same split as the updater's handoff, for the same reason.
#
# Verify before you run. This audience cares about provenance and it costs one
# line:
#
#   curl -fsSLO https://canectic.tranqsoft.com/releases/bootstrap.sh
#   curl -fsSLO https://canectic.tranqsoft.com/releases/bootstrap.sh.sha256
#   sha256sum -c bootstrap.sh.sha256 && bash bootstrap.sh
#
# Piping straight into a shell works and is not recommended.
#
# Usage:
#   ./bootstrap.sh                              newest stable into /opt/canectic
#   ./bootstrap.sh --target ~/bbs               somewhere else
#   ./bootstrap.sh --channel development        track development builds
#   ./bootstrap.sh --version 0.9.6a             a specific release
#   ./bootstrap.sh --from ./dist/releases       artifacts already on disk
#   ./bootstrap.sh --download-only              fetch and verify, do not install
#   ./bootstrap.sh --extract-only ./canectic    unpack it and stop, so you can
#                                               read the docs and run the setup
#                                               scripts before installing
# =============================================================================

BASE_URL="${CANECTIC_RELEASES:-https://canectic.tranqsoft.com/releases}"
CHANNEL="stable"
VERSION=""
TARGET=""
FROM=""
DOWNLOAD_ONLY=false
EXTRACT_TO=
INSTALL_ARGS=()

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${CYAN}->${NC} $1"; }
ok()   { echo -e "${GREEN}+${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
die()  { echo -e "${RED}x${NC} $1" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)         TARGET="$2"; shift 2 ;;
        --channel)        CHANNEL="$2"; shift 2 ;;
        --version)        VERSION="$2"; shift 2 ;;
        --url)            BASE_URL="${2%/}"; shift 2 ;;
        --from)           FROM="$2"; shift 2 ;;
        --download-only)  DOWNLOAD_ONLY=true; shift ;;
        --extract-only)   EXTRACT_TO="$2"; shift 2 ;;
        --help|-h)        sed -n '6,40p' "$0"; exit 0 ;;
        # Anything else is for the installer inside the release, so a flag it
        # gains does not need this script changed.
        *)                INSTALL_ARGS+=("$1"); shift ;;
    esac
done

# -----------------------------------------------------------------------------
# What we need, checked up front rather than failing partway through a download
# -----------------------------------------------------------------------------

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is needed and was not found"; }
need unzip
need sha256sum

if [[ -z "$FROM" ]]; then
    if command -v curl >/dev/null 2>&1; then
        FETCH="curl -fsSL"
        FETCH_OUT="curl -fsSL -o"
    elif command -v wget >/dev/null 2>&1; then
        FETCH="wget -qO-"
        FETCH_OUT="wget -qO"
    else
        die "neither curl nor wget is installed"
    fi
fi

command -v node >/dev/null 2>&1 || die "Node is needed and was not found. Install Node 22 or later; nvm is recommended. See docs/sysop/INSTALL.md"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
    die "Node $(node -p 'process.versions.node') is too old; 22 or later is needed"
fi

# -----------------------------------------------------------------------------
# Fetch a published file, from a URL or a directory. Both paths land in the same
# place so verification and extraction do not care which was used, and a sysop
# who fetched an artifact down a file echo uses the identical code.
# -----------------------------------------------------------------------------

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() {
    local name="$1" dest="$2"
    if [[ -n "$FROM" ]]; then
        [[ -f "$FROM/$name" ]] || die "not found in $FROM: $name"
        cp "$FROM/$name" "$dest"
    else
        $FETCH_OUT "$dest" "$BASE_URL/$name" || die "could not fetch $BASE_URL/$name"
    fi
}

fetch_text() {
    local name="$1"
    if [[ -n "$FROM" ]]; then
        [[ -f "$FROM/$name" ]] || die "not found in $FROM: $name"
        cat "$FROM/$name"
    else
        $FETCH "$BASE_URL/$name" || die "could not fetch $BASE_URL/$name"
    fi
}

# -----------------------------------------------------------------------------
# Resolve
# -----------------------------------------------------------------------------

echo ""
echo -e "${BOLD}Canectic BBS${NC}"
echo ""

if [[ -z "$VERSION" ]]; then
    info "looking at the $CHANNEL channel"
    INDEX="$(fetch_text "index-${CHANNEL}.json")"
    # The index is newest first, so the first version is the one we want. Parsed
    # with node rather than with sed: this is a JSON document and the release
    # tooling that writes it is entitled to add fields.
    VERSION="$(printf '%s' "$INDEX" | node -e '
        var s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            var i = JSON.parse(s);
            if (!i.releases || !i.releases.length) { process.exit(3); }
            process.stdout.write(i.releases[0].version);
        });
    ')" || die "the $CHANNEL channel has no releases published"
fi

ok "release $VERSION"

META="$WORK/meta.json"
fetch "canectic-${VERSION}.json" "$META"

ARTIFACT="$(node -p "require('$META').artifact")"
EXPECTED="$(node -p "require('$META').sha256")"
IS_DELTA="$(node -p "require('$META').delta === true")"

if [[ "$IS_DELTA" == "true" ]]; then
    die "$VERSION is a development build, which is a delta against a stable release and cannot be installed from nothing. Install the stable it names first, then update to this."
fi

# -----------------------------------------------------------------------------
# Download and verify. Nothing is unpacked unverified: the artifact may have
# come a long way, and extraction is the point at which a substituted archive
# gets a say in what runs.
# -----------------------------------------------------------------------------

info "downloading $ARTIFACT"
fetch "$ARTIFACT" "$WORK/$ARTIFACT"

ACTUAL="$(sha256sum "$WORK/$ARTIFACT" | cut -d' ' -f1)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    die "$ARTIFACT does not match its published checksum.
  expected $EXPECTED
  got      $ACTUAL
  It has NOT been unpacked."
fi
ok "checksum verified"

# A signature is checked when one is published and gpg is here. No key is
# published yet, so its absence is a warning rather than a refusal; when one is,
# this becomes the default and the flag to skip it becomes deliberate.
if [[ -z "$FROM" ]] && command -v gpg >/dev/null 2>&1; then
    if $FETCH_OUT "$WORK/SHA256SUMS.asc" "$BASE_URL/SHA256SUMS.asc" 2>/dev/null && \
       $FETCH_OUT "$WORK/SHA256SUMS" "$BASE_URL/SHA256SUMS" 2>/dev/null; then
        if gpg --verify "$WORK/SHA256SUMS.asc" "$WORK/SHA256SUMS" >/dev/null 2>&1; then
            ok "signature verified"
        else
            warn "the published checksums carry a signature this system cannot verify"
            warn "that means either the signing key is not in your keyring, or something is wrong"
        fi
    fi
fi

# Unpack and stop. The docs and the setup scripts live inside the release, so
# without this there is no moment at which a sysop can read INSTALL.md or run
# create_pg_db_user.sh before committing to an install: the bootstrap unpacks
# into a temporary directory and deletes it on the way out.
if [[ -n "$EXTRACT_TO" ]]; then
    info "extracting to $EXTRACT_TO"
    mkdir -p "$EXTRACT_TO"
    unzip -q -o "$WORK/$ARTIFACT" -d "$WORK"
    cp -a "$WORK/canectic-${VERSION}/." "$EXTRACT_TO/"
    ok "Canectic $VERSION unpacked into $EXTRACT_TO"
    echo ""
    echo "  Read first:   $EXTRACT_TO/docs/sysop/INSTALL.md"
    echo "  Database:     cd $EXTRACT_TO && bash setup/create_pg_db_user.sh"
    echo "  Then install: cd $EXTRACT_TO && node src/tools/install.js --target /opt/canectic"
    echo ""
    exit 0
fi

if [[ "$DOWNLOAD_ONLY" == "true" ]]; then
    DEST="${TARGET:-$PWD}"
    cp "$WORK/$ARTIFACT" "$DEST/"
    cp "$META" "$DEST/canectic-${VERSION}.json"
    ok "downloaded and verified into $DEST"
    echo ""
    echo "  To install it yourself:"
    echo "    unzip $ARTIFACT && cd canectic-$VERSION"
    echo "    less docs/sysop/INSTALL.md"
    echo "    bash setup/create_pg_db_user.sh"
    echo "    node src/tools/install.js --target /opt/canectic"
    echo ""
    exit 0
fi

# -----------------------------------------------------------------------------
# Extract and hand off
# -----------------------------------------------------------------------------

info "extracting"
unzip -q -o "$WORK/$ARTIFACT" -d "$WORK"
TREE="$WORK/canectic-${VERSION}"
[[ -d "$TREE" ]] || die "the archive did not contain canectic-${VERSION}/"
[[ -f "$TREE/src/tools/install.js" ]] || die "this release ships no installer. Extract it and follow docs/sysop/INSTALL.md"

echo ""
info "handing off to ${VERSION}'s own installer"
echo ""

# The release installs itself. Installing is version specific, so a release
# should do its own rather than be installed by whatever fetched it.
ARGS=()
[[ -n "$TARGET" ]] && ARGS+=(--target "$TARGET")
[[ ${#INSTALL_ARGS[@]} -gt 0 ]] && ARGS+=("${INSTALL_ARGS[@]}")

cd "$TREE"
exec node src/tools/install.js "${ARGS[@]}"
