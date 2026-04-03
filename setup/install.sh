#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Canectic BBS — Install / Update Script
# =============================================================================
#
# Copies application files from a source directory (git clone or extracted
# release archive) into a run directory, keeping user data and configuration
# intact across updates.
#
# Install mode:  copies everything, creates directory structure, copies
#                .env.example as .env template if no .env exists.
#
# Update mode:   overwrites code files, prompts before overwriting data/config
#                files that the user may have modified.
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

# --- Code directories (always overwritten on update) ---
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

# --- Data directories (created on install, merge-prompted on update) ---
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
# Update (existing installation)
# =============================================================================

do_update() {
    echo ""
    info "Updating Canectic BBS at: $TARGET_DIR"
    echo ""

    # Overwrite code directories
    for dir in "${CODE_DIRS[@]}"; do
        if [[ -d "$SOURCE_DIR/$dir" ]]; then
            info "Updating $dir/"
            # Remove old code dir and replace — ensures deleted files don't linger
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

    # Merge data directories — prompt for files newer in target
    for dir in "${DATA_DIRS[@]}"; do
        if [[ -d "$SOURCE_DIR/$dir" ]]; then
            merge_data_dir "$dir"
        fi
    done

    # Ensure logs directory exists
    mkdir -p "$TARGET_DIR/logs/production"

    echo ""
    ok "Update complete!"
    echo ""
    post_update_message
}

# =============================================================================
# Data directory merge — prompts for modified files
# =============================================================================

merge_data_dir() {
    local dir="$1"

    if [[ ! -d "$TARGET_DIR/$dir" ]]; then
        # Target doesn't have this dir yet — copy wholesale
        info "Adding new directory: $dir/"
        cp -a "$SOURCE_DIR/$dir" "$TARGET_DIR/"
        return
    fi

    # Walk source files and compare
    local src_dir="$SOURCE_DIR/$dir"
    local changed=0

    while IFS= read -r -d '' src_file; do
        local rel_path="${src_file#$src_dir/}"
        local tgt_file="$TARGET_DIR/$dir/$rel_path"

        # New file in source — always copy
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

        # Files differ — check if target is newer
        if [[ "$tgt_file" -nt "$src_file" ]]; then
            # Target is newer — prompt
            changed=1
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
            # Source is newer — overwrite silently
            cp -a "$src_file" "$tgt_file"
        fi
    done < <(find "$src_dir" -type f -print0 2>/dev/null)
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

echo ""
if [[ "$MODE" == "install" ]]; then
    info "Mode: ${BOLD}Fresh Install${NC}"
else
    info "Mode: ${BOLD}Update${NC} (existing installation detected)"
fi
info "Source: $SOURCE_DIR"
info "Target: $TARGET_DIR"
echo ""
read -rp "Continue? [Y/n]: " confirm
if [[ "${confirm,,}" == "n" || "${confirm,,}" == "no" ]]; then
    info "Aborted."
    exit 0
fi

if [[ "$MODE" == "install" ]]; then
    do_install
else
    do_update
fi
