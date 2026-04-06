#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Canectic BBS — Update Script
# =============================================================================
#
# Updates an existing Canectic BBS installation from a source directory
# (git clone or extracted release archive). Overwrites code files, prompts
# before overwriting modified data/config files, installs dependencies,
# and runs database migrations.
#
# Usage:
#   ./setup/update.sh                  # interactive -- prompts for target
#   ./setup/update.sh /opt/canectic    # specify target directly
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

info()  { echo -e "${CYAN}->${NC} $1"; }
ok()    { echo -e "${GREEN}+${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
err()   { echo -e "${RED}x${NC} $1"; }

# --- Code directories (always overwritten) ---
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

# --- Data directories (merge-prompted on update) ---
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

# =============================================================================
# Target directory selection
# =============================================================================

select_target() {
    if [[ -n "${1:-}" ]]; then
        TARGET_DIR="$1"
        return
    fi

    echo ""
    echo -e "${BOLD}Canectic BBS -- Update${NC}"
    echo ""
    echo "Select installation directory to update:"
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
# Sanity checks
# =============================================================================

preflight() {
    # Don't update from the installation directory itself
    if [[ "$(realpath "$TARGET_DIR")" == "$(realpath "$SOURCE_DIR")" ]]; then
        err "Target directory is the same as source directory."
        err "Run this script from a separate source repo or release archive."
        exit 1
    fi

    # Check source looks like a Canectic repo
    if [[ ! -f "$SOURCE_DIR/package.json" ]] || [[ ! -d "$SOURCE_DIR/src" ]]; then
        err "Source directory doesn't look like a Canectic BBS repo: $SOURCE_DIR"
        exit 1
    fi

    # Check target looks like an existing installation
    if [[ ! -f "$TARGET_DIR/package.json" ]] || [[ ! -d "$TARGET_DIR/src" ]]; then
        err "Target doesn't look like an existing Canectic installation: $TARGET_DIR"
        err "Use setup/install.sh for fresh installations."
        exit 1
    fi

    # Check .env exists
    if [[ ! -f "$TARGET_DIR/.env" ]]; then
        warn "No .env file found in $TARGET_DIR -- configuration may be missing."
    fi
}

# =============================================================================
# Data directory merge -- prompts for modified files
# =============================================================================

merge_data_dir() {
    local dir="$1"

    if [[ ! -d "$TARGET_DIR/$dir" ]]; then
        info "Adding new directory: $dir/"
        cp -a "$SOURCE_DIR/$dir" "$TARGET_DIR/"
        return
    fi

    local src_dir="$SOURCE_DIR/$dir"

    while IFS= read -r -d '' src_file; do
        local rel_path="${src_file#$src_dir/}"
        local tgt_file="$TARGET_DIR/$dir/$rel_path"

        # New file in source -- always copy
        if [[ ! -e "$tgt_file" ]]; then
            local tgt_parent
            tgt_parent="$(dirname "$tgt_file")"
            mkdir -p "$tgt_parent"
            cp -a "$src_file" "$tgt_file"
            continue
        fi

        # Skip if identical
        if cmp -s "$src_file" "$tgt_file"; then
            continue
        fi

        # Files differ -- check if target is newer
        if [[ "$tgt_file" -nt "$src_file" ]]; then
            echo ""
            warn "$dir/$rel_path has been modified locally (and is newer)"
            echo "  Source: $(stat -c '%y' "$src_file" 2>/dev/null || stat -f '%Sm' "$src_file" 2>/dev/null)"
            echo "  Target: $(stat -c '%y' "$tgt_file" 2>/dev/null || stat -f '%Sm' "$tgt_file" 2>/dev/null)"
            read -rp "  Overwrite with source version? [y/N/d(iff)]: " answer
            case "${answer,,}" in
                y|yes)
                    cp -a "$src_file" "$tgt_file"
                    ok "  Overwritten"
                    ;;
                d|diff)
                    diff --color=auto "$tgt_file" "$src_file" || true
                    read -rp "  Overwrite? [y/N]: " answer2
                    if [[ "${answer2,,}" == "y" || "${answer2,,}" == "yes" ]]; then
                        cp -a "$src_file" "$tgt_file"
                        ok "  Overwritten"
                    else
                        info "  Kept local version"
                    fi
                    ;;
                *)
                    info "  Kept local version"
                    ;;
            esac
        else
            # Source is newer -- overwrite silently
            cp -a "$src_file" "$tgt_file"
        fi
    done < <(find "$src_dir" -type f -print0 2>/dev/null)
}

# =============================================================================
# Main update
# =============================================================================

do_update() {
    echo ""
    info "Updating Canectic BBS at: $TARGET_DIR"
    echo ""

    # Overwrite code directories
    for dir in "${CODE_DIRS[@]}"; do
        if [[ -d "$SOURCE_DIR/$dir" ]]; then
            info "Updating $dir/"
            rm -rf "$TARGET_DIR/$dir"
            cp -a "$SOURCE_DIR/$dir" "$TARGET_DIR/"
        fi
    done

    # Overwrite code root files
    for f in "${CODE_FILES[@]}"; do
        if [[ -f "$SOURCE_DIR/$f" ]]; then
            cp -a "$SOURCE_DIR/$f" "$TARGET_DIR/"
        fi
    done

    # Merge data directories
    for dir in "${DATA_DIRS[@]}"; do
        if [[ -d "$SOURCE_DIR/$dir" ]]; then
            merge_data_dir "$dir"
        fi
    done

    # Ensure logs directory exists
    mkdir -p "$TARGET_DIR/logs/production"

    echo ""
    ok "Files updated."
    echo ""

    # Install/update dependencies
    info "Installing dependencies..."
    cd "$TARGET_DIR"
    npm install --omit=dev 2>&1 | tail -5
    echo ""
    ok "Dependencies installed."
    echo ""

    # Run database migrations
    info "Running database migrations..."
    node src/tools/dbmigrations.js 2>&1
    echo ""
    ok "Database migrations complete."
    echo ""

    # Done
    echo -e "${GREEN}${BOLD}Update complete!${NC}"
    echo ""
    echo -e "${BOLD}Remaining steps:${NC}"
    echo ""
    echo "  Restart services:"
    echo -e "     ${CYAN}pm2 restart all${NC}"
    echo ""
}

# =============================================================================
# Entry point
# =============================================================================

select_target "${1:-}"
preflight

echo ""
info "Source: $SOURCE_DIR"
info "Target: $TARGET_DIR"
echo ""
read -rp "Update this installation? [Y/n]: " confirm
if [[ "${confirm,,}" == "n" || "${confirm,,}" == "no" ]]; then
    info "Aborted."
    exit 0
fi

do_update
