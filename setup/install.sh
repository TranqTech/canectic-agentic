#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Canectic BBS — Install Script
# =============================================================================
#
# Copies application files from a source directory (git clone or extracted
# release archive) into a run directory, keeping user data and configuration
# intact across updates.
#
# Installs only. If it finds an existing installation it refuses and points
# at setup/update.sh rather than doing it itself.
#
# It used to have an update mode, and the two drifted: update.sh moved public/
# out of CODE_DIRS into an overlay so sysop-added assets and custom.css survive,
# and this script never received that change, so its update mode deleted them.
# Rather than duplicate the categorisation a second time, the mode is gone.
# See issue #44.
#
# Usage:
#   ./setup/install.sh              # interactive — prompts for everything
#   ./setup/install.sh /opt/canectic  # specify target directly
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }

# --- Code directories (copied on install) ---
CODE_DIRS=(
    bin
    db
    docs
    examples
    public
    setup
    src
    tests
)

# --- Code files in project root (always overwritten) ---
CODE_FILES=(
    package.json
    package-lock.json
    ecosystem.config.cjs
    .mocharc.yml
)

# --- Data directories (created on install) ---
DATA_DIRS=(
    config
    txtfiles
    ftn
    qwk
    qnet
    files
    xtrn
    logs
    tmp
    export
)

# --- Files/dirs to never copy ---
EXCLUDE=(
    node_modules
    .git
    .gitignore
    .env
    .claude
    CLAUDE.md
    GEMINI.md
    reference
)

# =============================================================================
# Target directory selection
# =============================================================================

select_target() {
    if [[ -n "${1:-}" ]]; then
        TARGET_DIR="$1"
        return
    fi

    echo ""
    echo -e "${BOLD}Canectic BBS — Install / Update${NC}"
    echo ""
    echo "Select installation directory:"
    echo ""
    echo "  1) /opt/canectic"
    echo "  2) ~/canectic"
    echo "  3) Specify custom path"
    echo ""
    read -rp "Choice [1-3]: " choice

    case "$choice" in
        1) TARGET_DIR="/opt/canectic" ;;
        2) TARGET_DIR="$HOME/canectic" ;;
        3)
            read -rp "Enter full path: " custom_path
            TARGET_DIR="${custom_path%/}"
            ;;
        *)
            err "Invalid choice"
            exit 1
            ;;
    esac
}

# =============================================================================
# Detect install vs update
# =============================================================================

detect_mode() {
    if [[ -f "$TARGET_DIR/package.json" ]] && grep -q '"door-server"' "$TARGET_DIR/package.json" 2>/dev/null; then
        MODE="update"
    elif [[ -d "$TARGET_DIR/src" ]] && [[ -d "$TARGET_DIR/bin" ]]; then
        MODE="update"
    else
        MODE="install"
    fi
}

# =============================================================================
# Sanity checks
# =============================================================================

preflight() {
    # Don't install into the source directory itself
    if [[ "$(realpath "$TARGET_DIR")" == "$(realpath "$SOURCE_DIR")" ]]; then
        err "Target directory is the same as source directory."
        err "The install script copies files FROM the repo TO a separate run directory."
        exit 1
    fi

    # Check source looks like a Canectic repo
    if [[ ! -f "$SOURCE_DIR/package.json" ]] || [[ ! -d "$SOURCE_DIR/src" ]]; then
        err "Source directory doesn't look like a Canectic BBS repo: $SOURCE_DIR"
        exit 1
    fi
}

# =============================================================================
# Install (fresh)
# =============================================================================

do_install() {
    echo ""
    info "Installing Canectic BBS to: $TARGET_DIR"
    echo ""

    # Create target if needed
    if [[ ! -d "$TARGET_DIR" ]]; then
        mkdir -p "$TARGET_DIR" || {
            err "Failed to create $TARGET_DIR — do you need sudo?"
            exit 1
        }
    fi

    # Copy code directories
    for dir in "${CODE_DIRS[@]}"; do
        if [[ -d "$SOURCE_DIR/$dir" ]]; then
            info "Copying $dir/"
            cp -a "$SOURCE_DIR/$dir" "$TARGET_DIR/"
        fi
    done

    # Copy code root files
    for f in "${CODE_FILES[@]}"; do
        if [[ -f "$SOURCE_DIR/$f" ]]; then
            cp -a "$SOURCE_DIR/$f" "$TARGET_DIR/"
        fi
    done

    # Copy .gitignore (useful even outside git for editor ignore patterns)
    if [[ -f "$SOURCE_DIR/.gitignore" ]]; then
        cp -a "$SOURCE_DIR/.gitignore" "$TARGET_DIR/"
    fi

    # Create data directories (empty)
    for dir in "${DATA_DIRS[@]}"; do
        if [[ -d "$SOURCE_DIR/$dir" ]]; then
            # Copy with contents (default config, themes, text files)
            info "Copying $dir/"
            cp -a "$SOURCE_DIR/$dir" "$TARGET_DIR/"
        else
            mkdir -p "$TARGET_DIR/$dir"
        fi
    done

    # Create logs subdirectory
    mkdir -p "$TARGET_DIR/logs/production"

    # Create standard art directories (terminal formats + web art)
    local ART_FORMATS=(ans asc utf8 sixel rip webart)
    local ART_TYPES=(screens headers logon login logoff goodbye register welcome misc random)
    for fmt in "${ART_FORMATS[@]}"; do
        for atype in "${ART_TYPES[@]}"; do
            mkdir -p "$TARGET_DIR/txtfiles/$fmt/$atype"
        done
    done
    info "Created art directory structure in txtfiles/"

    # Create FTN subdirectories
    mkdir -p "$TARGET_DIR/ftn/in" "$TARGET_DIR/ftn/out" "$TARGET_DIR/ftn/tossed" "$TARGET_DIR/ftn/bad" "$TARGET_DIR/ftn/tmp" "$TARGET_DIR/ftn/filebox"
    info "Created FTN directory structure"

    # Copy .env.example as .env if no .env exists
    if [[ ! -f "$TARGET_DIR/.env" ]]; then
        if [[ -f "$SOURCE_DIR/examples/env.example" ]]; then
            cp "$SOURCE_DIR/examples/env.example" "$TARGET_DIR/.env"
            warn "Created .env from template — edit it with your database credentials"
        fi
    fi

    echo ""
    ok "Installation complete!"
    echo ""
    post_install_message
}

# =============================================================================
# Post-install messages
# =============================================================================

post_install_message() {
    echo -e "${BOLD}Next steps:${NC}"
    echo ""
    echo "  1. Edit your configuration:"
    echo -e "     ${CYAN}cd $TARGET_DIR${NC}"
    echo -e "     ${CYAN}\$EDITOR .env${NC}"
    echo ""
    echo "  2. Set up PostgreSQL (if not done):"
    echo -e "     ${CYAN}bash setup/create_pg_db_user.sh${NC}"
    echo ""
    echo "  3. Install Node.js dependencies:"
    echo -e "     ${CYAN}npm install${NC}"
    echo ""
    echo "  4. Run database migrations:"
    echo -e "     ${CYAN}node src/tools/dbmigrations.js${NC}"
    echo ""
    echo "  5. Start the BBS:"
    echo -e "     ${CYAN}pm2 start ecosystem.config.cjs${NC}"
    echo ""
    echo "  6. Register your first account (auto-promoted to Sysop):"
    echo -e "     Web:      ${CYAN}http://localhost:8080/users/register${NC}"
    echo -e "     Terminal: ${CYAN}telnet localhost 2023${NC}"
    echo ""
}

post_update_message() {
    echo -e "${BOLD}Post-update steps:${NC}"
    echo ""
    echo "  1. Install/update dependencies:"
    echo -e "     ${CYAN}cd $TARGET_DIR${NC}"
    echo -e "     ${CYAN}npm install${NC}"
    echo ""
    echo "  2. Run database migrations:"
    echo -e "     ${CYAN}node src/tools/dbmigrations.js${NC}"
    echo ""
    echo "  3. Restart services:"
    echo -e "     ${CYAN}pm2 restart all${NC}"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

select_target "${1:-}"
preflight
detect_mode

if [[ "$MODE" == "update" ]]; then
    echo ""
    err "That is an existing Canectic installation. This script only installs."
    echo ""
    echo "  Use the update script instead:"
    echo ""
    echo -e "      ${CYAN}./setup/update.sh $TARGET_DIR${NC}"
    echo ""
    echo "  It is not an alias. update.sh preserves things this script would"
    echo "  delete: public/ is overlaid rather than replaced, so sysop-added"
    echo "  door icons, collection images and branding survive, and"
    echo "  public/css/custom.css is never overwritten once it exists."
    echo ""
    exit 1
fi

echo ""
info "Mode: ${BOLD}Fresh Install${NC}"
info "Source: $SOURCE_DIR"
info "Target: $TARGET_DIR"
echo ""
read -rp "Continue? [Y/n]: " confirm
if [[ "${confirm,,}" == "n" || "${confirm,,}" == "no" ]]; then
    info "Aborted."
    exit 0
fi

do_install
