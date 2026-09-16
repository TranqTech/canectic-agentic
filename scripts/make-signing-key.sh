#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Canectic BBS - generate the release signing key
# =============================================================================
#
# Run once, ever. Maintainer tooling, not shipped in a release.
#
# Produces a certify-only primary key with a signing subkey under it, then takes
# the primary's secret half off this machine. The primary is the identity every
# board pins; the subkey is what touches the build. If this box is ever
# compromised you revoke and replace the subkey, and every sysop who pinned the
# fingerprint carries on. Without the split, the identity itself is burned and
# everyone has to re-trust a new key, which across a BBS network means a long
# tail of people who never see the notice.
#
# Ed25519 rather than RSA. The compatibility argument does not apply: anything
# verifying this is already required to run Node 22, and nothing that new ships
# a GnuPG too old for it.
#
# Afterwards `gpg -K` must show "sec#". The # is the whole point of the
# exercise: it means the secret primary is not here.
# =============================================================================

REAL_NAME="Canectic BBS Release Signing"
EMAIL="releases@tranqsoft.com"
PRIMARY_EXPIRY="5y"
SUBKEY_EXPIRY="2y"
BACKUP_DIR="${1:-$HOME/canectic-signing-key-backup}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_KEY="$ROOT/setup/canectic-release.asc"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${CYAN}->${NC} $1"; }
ok()   { echo -e "${GREEN}+${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
die()  { echo -e "${RED}x${NC} $1" >&2; exit 1; }

command -v gpg  >/dev/null 2>&1 || die "gpg is not installed"
command -v gpgv >/dev/null 2>&1 || warn "gpgv is not installed; it is what verifies a release on a board"

# -----------------------------------------------------------------------------
# Refuse to run twice. A second key under the same identity is the one mistake
# here that is expensive to undo, because boards pin the first one.
# -----------------------------------------------------------------------------

if gpg --list-keys "$EMAIL" >/dev/null 2>&1; then
    die "a key for $EMAIL already exists in this keyring.
  There is meant to be exactly one, and boards pin its fingerprint.
  If you are deliberately replacing it, delete the old one by hand first."
fi
[[ -e "$PUBLIC_KEY" ]] && die "$PUBLIC_KEY already exists; the key it holds is the one to use"
[[ -e "$BACKUP_DIR" ]] && die "$BACKUP_DIR already exists; move it aside rather than writing over a key backup"

echo ""
echo -e "${BOLD}Canectic release signing key${NC}"
echo ""
echo "  name     $REAL_NAME"
echo "  email    $EMAIL"
echo "  primary  ed25519, certify only, expires in $PRIMARY_EXPIRY"
echo "  subkey   ed25519, signing, expires in $SUBKEY_EXPIRY"
echo "  backup   $BACKUP_DIR"
echo ""
echo "You will be asked for a passphrase. It protects the secret key material,"
echo "including the copy going to the backup directory. Use a real one and put"
echo "it wherever you keep things you cannot regenerate."
echo ""
read -r -p "Go ahead? [y/N] " reply
[[ "$reply" =~ ^[Yy]$ ]] || die "nothing was created"

# -----------------------------------------------------------------------------
# Generate
# -----------------------------------------------------------------------------

info "generating the primary key"
gpg --quick-generate-key "$REAL_NAME <$EMAIL>" ed25519 cert "$PRIMARY_EXPIRY"

FPR="$(gpg --list-keys --with-colons "$EMAIL" | awk -F: '/^fpr/{print $10; exit}')"
[[ -n "$FPR" ]] || die "the key was generated but its fingerprint could not be read"
ok "primary $FPR"

info "adding the signing subkey"
gpg --quick-add-key "$FPR" ed25519 sign "$SUBKEY_EXPIRY"
ok "signing subkey added"

# -----------------------------------------------------------------------------
# Back up, and prove the backup is readable BEFORE removing anything. An export
# that silently produced nothing, followed by a delete, loses the identity.
# -----------------------------------------------------------------------------

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

info "exporting the secret primary"
gpg --armor --export-secret-keys "$FPR" > "$BACKUP_DIR/primary-secret.asc"
gpg --armor --export-secret-subkeys "$FPR" > "$BACKUP_DIR/subkeys-secret.asc"
gpg --armor --export "$FPR" > "$BACKUP_DIR/public.asc"
chmod 600 "$BACKUP_DIR"/*.asc

REVOKE="$(gpg --list-keys --with-colons "$FPR" | awk -F: '/^fpr/{print $10; exit}')"
if [[ -n "${GNUPGHOME:-}" && -f "${GNUPGHOME}/openpgp-revocs.d/$REVOKE.rev" ]]; then
    cp "${GNUPGHOME}/openpgp-revocs.d/$REVOKE.rev" "$BACKUP_DIR/"
elif [[ -f "$HOME/.gnupg/openpgp-revocs.d/$REVOKE.rev" ]]; then
    cp "$HOME/.gnupg/openpgp-revocs.d/$REVOKE.rev" "$BACKUP_DIR/"
else
    warn "could not find the revocation certificate; look for openpgp-revocs.d/$REVOKE.rev"
fi

info "checking the backup round-trips before removing anything"
PROBE="$(mktemp -d)"
chmod 700 "$PROBE"
if ! GNUPGHOME="$PROBE" gpg --batch --import "$BACKUP_DIR/primary-secret.asc" >/dev/null 2>&1; then
    rm -rf "$PROBE"
    die "the exported primary could not be re-imported. NOTHING has been removed.
  Your key is intact in this keyring. Work out why the export is unreadable first."
fi
PROBE_FPR="$(GNUPGHOME="$PROBE" gpg --list-secret-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')"
rm -rf "$PROBE"
[[ "$PROBE_FPR" == "$FPR" ]] || die "the backup holds $PROBE_FPR, not $FPR. NOTHING has been removed."
ok "backup verified"

# -----------------------------------------------------------------------------
# Take the primary off this machine
# -----------------------------------------------------------------------------

info "removing the secret primary from this keyring"
gpg --batch --yes --delete-secret-keys "$FPR"
gpg --batch --import "$BACKUP_DIR/subkeys-secret.asc"

# Field 15 of the sec record carries the availability marker: "#" when the
# secret primary is a stub and not on this machine, "+" when it is here. Field 1
# is "sec" either way, which is the trap.
SEC_STATE="$(gpg --list-secret-keys --with-colons "$FPR" | awk -F: '/^sec:/{print $15; exit}')"
if [[ "$SEC_STATE" != "#" ]]; then
    die "the secret primary is still present (marker '${SEC_STATE:-none}', expected '#').
  Do not publish this key yet. Your backup in $BACKUP_DIR is intact."
fi
ok "secret primary is off this machine; gpg -K shows sec#"

# -----------------------------------------------------------------------------
# The public half, which ships
# -----------------------------------------------------------------------------

gpg --armor --export "$FPR" > "$PUBLIC_KEY"
ok "public key at ${PUBLIC_KEY#$ROOT/}"

echo ""
echo -e "${BOLD}Fingerprint${NC}"
echo ""
gpg --fingerprint "$FPR" | sed -n '2p'
echo ""
echo "  This is what every board pins. It goes in INSTALL.md, README.md and the"
echo "  release notes, and it does not change if the release host ever moves."
echo ""
echo -e "${BOLD}Still yours to do${NC}"
echo ""
echo "  1. Move $BACKUP_DIR onto offline media and delete it from this disk."
echo "     It holds the secret primary and the revocation certificate. On this"
echo "     box they are exactly what the split above was meant to prevent."
echo "  2. Upload the public key somewhere that outlives the release host:"
echo "     gpg --keyserver keys.openpgp.org --send-keys $FPR"
echo "  3. Commit setup/canectic-release.asc"
echo ""
