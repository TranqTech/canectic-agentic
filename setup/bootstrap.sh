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
    # tooling that writes it is entitled to add fields. A withdrawn release is
    # not listed at all; the skip is for the first withdrawal format, which
    # left the entry in place and marked it.
    VERSION="$(printf '%s' "$INDEX" | node -e '
        var s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            var i = JSON.parse(s);
            var r = (i.releases || []).filter(function (x) { return x && !x.superseded_by; });
            if (!r.length) { process.exit(3); }
            process.stdout.write(r[0].version);
        });
    ')" || die "the $CHANNEL channel has no releases published"
else
    # A version asked for by name is still looked up, so a withdrawn release is
    # refused rather than installed. No index (an artifact directory copied by
    # hand) is not a reason to refuse anything.
    NAMED_CHANNEL="$CHANNEL"
    [[ "$VERSION" =~ \.[0-9]{8}(\.[0-9]+)?$ ]] && NAMED_CHANNEL="development"
    INDEX="$(fetch_text "index-${NAMED_CHANNEL}.json" 2>/dev/null)" || INDEX=""
    if [[ -n "$INDEX" ]]; then
        WITHDRAWN="$(printf '%s' "$INDEX" | NAMED="$VERSION" node -e '
            var s = ""; process.stdin.on("data", d => s += d).on("end", () => {
                var i; try { i = JSON.parse(s); } catch (e) { return; }
                var v = process.env.NAMED;
                var w = (i.withdrawn || []).filter(function (x) { return x && x.version === v; })[0] ||
                    (i.releases || []).filter(function (x) { return x && x.version === v && x.superseded_by; })[0];
                if (!w) return;
                var why = w.withdrawn_reason || w.superseded_reason;
                process.stdout.write(v + " has been withdrawn" + (why ? " (" + why + ")" : "") +
                    (w.superseded_by ? "; install " + w.superseded_by + " instead" : ""));
            });
        ')"
        [[ -n "$WITHDRAWN" ]] && die "$WITHDRAWN"
    fi
fi

ok "release $VERSION"

# -----------------------------------------------------------------------------
# Trust, in order.
#
# SHA256SUMS is fetched FIRST and everything else is checked against it, because
# it is the only file with a signature over it. The previous shape checked the
# archive against the sha256 inside its own metadata JSON, then verified the
# signature over SHA256SUMS and never opened the file: the metadata that the
# archive was actually trusted against was vouched for by nothing, while the
# sysop was told "signature verified". Anyone able to write to the host swapped
# the archive and the metadata together, left the genuine signed list alone, and
# both checks passed.
#
# The chain now runs signature -> SHA256SUMS -> metadata -> artifact, and every
# link is checked. The metadata's own sha256 is still compared at the end as an
# independent second statement of the same fact.
# -----------------------------------------------------------------------------

SUMS="$WORK/SHA256SUMS"
HAVE_SUMS=false
SIGNED=false

fetch_optional() {
    local name="$1" dest="$2"
    if [[ -n "$FROM" ]]; then
        [[ -f "$FROM/$name" ]] && cp "$FROM/$name" "$dest" && return 0
        return 1
    fi
    $FETCH_OUT "$dest" "$BASE_URL/$name" 2>/dev/null
}

# What SHA256SUMS says a file should hash to, empty when it says nothing.
sums_expects() {
    awk -v n="$1" '$2 == n { print $1; exit }' "$SUMS"
}

# Check a file we already hold against the signed list. A file the list does not
# mention is a refusal and not a pass: a published release lists everything it
# publishes, so an absent line means either the list or the file is not the one
# it should be.
check_against_sums() {
    local name="$1" file="$2"
    local expected actual
    expected="$(sums_expects "$name")"
    [[ -n "$expected" ]] || die "SHA256SUMS does not mention $name.
  Either the checksum list or $name is not from this release. Nothing has been unpacked."
    actual="$(sha256sum "$file" | cut -d' ' -f1)"
    [[ "$actual" == "$expected" ]] || die "$name does not match the published checksum list.
  expected $expected
  got      $actual
  Nothing has been unpacked."
}

# The Canectic release key's PRIMARY fingerprint, the number docs/sysop/INSTALL.md
# tells you to compare. A signature counts only when gpg says this key made it.
# Checking "some key in your keyring signed it" accepted a signature by ANY key
# you happened to hold. The override exists to test this script itself.
RELEASE_KEY_FPR="F3F16D3659AF25FBF9474C6DB5D8AB143016761F"
if [[ -n "${CANECTIC_RELEASE_KEY_FPR:-}" ]]; then
    RELEASE_KEY_FPR="$(printf '%s' "$CANECTIC_RELEASE_KEY_FPR" | tr -d ' ' | tr 'abcdef' 'ABCDEF')"
    warn "using the release key fingerprint from CANECTIC_RELEASE_KEY_FPR, not the one built into this script"
fi

spaced_fpr() { printf '%s' "$1" | sed 's/.\{4\}/& /g; s/ $//'; }

# Check SHA256SUMS.asc against the pinned key. Sets SIGNED, warns when it cannot
# check at all, and refuses when a signature is there and is not the release
# key's. The key comes from the release directory into a private gpg home, so
# nothing depends on, or changes, your own keyring.
verify_sums_signature() {
    local asc="$WORK/SHA256SUMS.asc" home="$WORK/gnupg" status primary held=false
    mkdir -m 700 "$home"
    if fetch_optional "canectic-release.asc" "$WORK/canectic-release.asc" \
        && gpg --homedir "$home" --batch --import "$WORK/canectic-release.asc" >/dev/null 2>&1; then
        local served
        served="$(gpg --homedir "$home" --batch --with-colons --list-keys 2>/dev/null \
            | awk -F: '$1=="pub"{want=1; next} $1=="fpr" && want{print $10; exit}')"
        if [[ "$served" != "$RELEASE_KEY_FPR" ]]; then
            gpgconf --homedir "$home" --kill all >/dev/null 2>&1 || true
            die "the release directory's signing key is not the Canectic release key.
  expected $(spaced_fpr "$RELEASE_KEY_FPR")
  got      $(spaced_fpr "${served:-nothing readable}")
  Nothing has been unpacked."
        fi
        held=true
        status="$(gpg --homedir "$home" --batch --status-fd 1 --verify "$asc" "$SUMS" 2>/dev/null || true)"
    else
        # No key in the release directory: fall back to your own keyring.
        status="$(gpg --batch --status-fd 1 --verify "$asc" "$SUMS" 2>/dev/null || true)"
    fi
    gpgconf --homedir "$home" --kill all >/dev/null 2>&1 || true

    if grep -q '^\[GNUPG:\] BADSIG ' <<<"$status"; then
        die "the published checksum list does not match its own signature. Something is wrong with this publish; nothing has been unpacked."
    fi
    if grep -qE '^\[GNUPG:\] (EXPKEYSIG|REVKEYSIG) ' <<<"$status"; then
        die "the published checksum list is signed with a key that has expired or been revoked. Nothing has been unpacked."
    fi
    primary="$(awk '/^\[GNUPG:\] VALIDSIG /{print $NF; exit}' <<<"$status")"
    if [[ -n "$primary" && "$primary" != "$RELEASE_KEY_FPR" ]]; then
        die "the published checksum list is signed by a key that is not the Canectic release key ($(spaced_fpr "$primary")). Nothing has been unpacked."
    fi
    if [[ -z "$primary" ]]; then
        if $held; then
            # We hold the release key and the signature is still not its: gpg
            # reports that as a missing key, not a bad signature, and treating
            # it as "cannot check" let a re-signed checksum list through.
            die "the published checksum list is not signed by the Canectic release key. Nothing has been unpacked."
        fi
        warn "the published checksums carry a signature this system could not check (no copy of the release key)"
        warn "the checksums are still checked; import canectic-release.asc to check the signature too"
        return 0
    fi
    SIGNED=true
    ok "signature verified (Canectic release key $(spaced_fpr "$RELEASE_KEY_FPR"))"
}

if fetch_optional "SHA256SUMS" "$SUMS"; then
    HAVE_SUMS=true
    if command -v gpg >/dev/null 2>&1 && fetch_optional "SHA256SUMS.asc" "$WORK/SHA256SUMS.asc"; then
        verify_sums_signature
    fi
else
    # A file echo delivers an archive and nothing else, so this is the normal
    # shape there rather than a fault. The archive still carries a signed
    # MANIFEST inside it, which is what verifies a release that arrived that way.
    warn "no SHA256SUMS alongside the release; falling back to the checksum in its own metadata"
fi

META="$WORK/meta.json"
fetch "canectic-${VERSION}.json" "$META"
if $HAVE_SUMS; then check_against_sums "canectic-${VERSION}.json" "$META"; fi

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

if $HAVE_SUMS; then check_against_sums "$ARTIFACT" "$WORK/$ARTIFACT"; fi

ACTUAL="$(sha256sum "$WORK/$ARTIFACT" | cut -d' ' -f1)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    die "$ARTIFACT does not match its published checksum.
  expected $EXPECTED
  got      $ACTUAL
  It has NOT been unpacked."
fi
ok "checksum verified"

if ! $SIGNED; then
    warn "this release was not signature checked"
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
