// Internal imports for formatBodyHtml
import { formatTextForHtml } from './codepageConversions.js';
import { detectAnsiArt, reflowText } from './termMsgFormat.js';

/**
 * Terminal Text Formatter for Node.js - Fidonet Packet Support
 * Converts terminal text with escape codes to HTML with proper cursor positioning
 * @param {string} text - Raw terminal text from Fidonet packet
 * @param {Object} options - Formatting options
 * @returns {string} Formatted HTML with appropriate span classes
 */
function formatTerminalText(text, options = {}) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    
    const defaults = {
        replaceAllSpaces: true, // Convert all spaces to &nbsp;
        handlePipeCodes: true,  // Process |XX pipe codes
        handleAnsiCodes: true,  // Process ANSI escape codes
        handleCtrlACodes: true, // Process Synchronet Ctrl-A attribute codes
        resetOnNewline: true,   // Reset pipe codes on newlines (\r)
        terminalWidth: 80,      // Terminal width in characters (height is infinite)
        noWrap: false           // If true, lines extend without wrapping (CSS handles layout)
    };
    
    const opts = { ...defaults, ...options };
    
    // Create virtual terminal buffer with infinite height
    const terminal = new VirtualTerminal(opts.terminalWidth, opts.noWrap);
    
    // Color code mappings
    const ansiMappings = {
        '0': 'reset',
        // Standard foreground colors (30-37)
        '30': 'fg-grey', '31': 'fg-red', '32': 'fg-green', '33': 'fg-yellow',
        '34': 'fg-blue', '35': 'fg-magenta', '36': 'fg-cyan', '37': 'fg-white',
        // Bright foreground colors (90-97)
        '90': 'fg-brightblack', '91': 'fg-brightred', '92': 'fg-brightgreen', '93': 'fg-brightyellow',
        '94': 'fg-brightblue', '95': 'fg-brightmagenta', '96': 'fg-brightcyan', '97': 'fg-brightwhite',
        // Standard background colors (40-47)
        '40': 'bg-black', '41': 'bg-red', '42': 'bg-green', '43': 'bg-yellow',
        '44': 'bg-blue', '45': 'bg-magenta', '46': 'bg-cyan', '47': 'bg-white',
        // Bright background colors (100-107)
        '100': 'bg-brightblack', '101': 'bg-brightred', '102': 'bg-brightgreen', '103': 'bg-brightyellow',
        '104': 'bg-brightblue', '105': 'bg-brightmagenta', '106': 'bg-brightcyan', '107': 'bg-brightwhite'
    };
    
    const pipeCodeMappings = {
        // Foreground colors (00-15)
        '00': 'fg-black', '01': 'fg-darkblue', '02': 'fg-green', '03': 'fg-cyan',
        '04': 'fg-red', '05': 'fg-magenta', '06': 'fg-yellow', '07': 'fg-grey',
        '08': 'fg-brightgrey', '09': 'fg-brightblue', '10': 'fg-brightgreen', '11': 'fg-brightcyan',
        '12': 'fg-brightred', '13': 'fg-brightmagenta', '14': 'fg-brightyellow', '15': 'fg-white',
        // Background colors (16-31)
        '16': 'bg-black', '17': 'bg-darkblue', '18': 'bg-green', '19': 'bg-cyan',
        '20': 'bg-red', '21': 'bg-magenta', '22': 'bg-yellow', '23': 'bg-grey',
        '24': 'bg-brightgrey', '25': 'bg-brightblue', '26': 'bg-brightgreen', '27': 'bg-brightcyan',
        '28': 'bg-brightred', '29': 'bg-brightmagenta', '30': 'bg-brightyellow', '31': 'bg-brightwhite'
    };
    
    // Synchronet Ctrl-A attribute code mappings
    // Foreground: letter codes (case-insensitive)
    const ctrlAFgNormal = {
        'K': 'fg-black',   'B': 'fg-darkblue', 'G': 'fg-green',   'C': 'fg-cyan',
        'R': 'fg-red',     'M': 'fg-magenta',  'Y': 'fg-yellow',  'W': 'fg-grey'
    };
    const ctrlAFgBright = {
        'K': 'fg-brightgrey',    'B': 'fg-brightblue',    'G': 'fg-brightgreen',
        'C': 'fg-brightcyan',    'R': 'fg-brightred',     'M': 'fg-brightmagenta',
        'Y': 'fg-brightyellow',  'W': 'fg-brightwhite'
    };
    // Background: digit codes 0-7
    const ctrlABg = {
        '0': 'bg-black',   '1': 'bg-darkblue', '2': 'bg-green',   '3': 'bg-cyan',
        '4': 'bg-red',     '5': 'bg-magenta',  '6': 'bg-yellow',  '7': 'bg-grey'
    };
    
    // Track Ctrl-A high intensity state
    let ctrlAHighIntensity = false;
    
    // Process text with all escape sequences
    // Groups: 1=full ANSI1, 2=ansiParams1, 3=ansiCmd1, 4=ansiParams2, 5=ansiCmd2,
    //         6=pipeCode, 7=ctrlA char
    const escapeRegex = /(\x1b\[([0-9;]*)([ABCDEFGHJKfHlmsu])|\033\[([0-9;]*)([ABCDEFGHJKfHlmsu])|\|(\d{2})|\x01(.))/g;
    
    let lastIndex = 0;
    let match;
    
    while ((match = escapeRegex.exec(text)) !== null) {
        // Add any text before this escape sequence
        const beforeMatch = text.slice(lastIndex, match.index);
        if (beforeMatch) {
            terminal.writeText(beforeMatch, opts);
        }
        
        const fullMatch = match[0];
        const ansiParams1 = match[2];
        const ansiCommand1 = match[3];
        const ansiParams2 = match[4]; 
        const ansiCommand2 = match[5];
        const pipeCode = match[6];
        const ctrlAChar = match[7];
        
        // Handle ANSI escape sequences
        if (opts.handleAnsiCodes && (ansiCommand1 || ansiCommand2)) {
            const params = (ansiParams1 || ansiParams2 || '').split(';').map(p => parseInt(p) || 0);
            const command = ansiCommand1 || ansiCommand2;
            
            switch (command) {
                case 'A': // Cursor up
                    terminal.moveCursor(0, -(params[0] || 1));
                    break;
                case 'B': // Cursor down
                    terminal.moveCursor(0, params[0] || 1);
                    break;
                case 'C': // Cursor right
                    terminal.moveCursor(params[0] || 1, 0);
                    break;
                case 'D': // Cursor left
                    terminal.moveCursor(-(params[0] || 1), 0);
                    break;
                case 'H': case 'f': // Cursor position
                    terminal.setCursor(params[1] || 1, params[0] || 1);
                    break;
                case 'J': // Clear screen
                    if (params[0] === 2) terminal.clearScreen();
                    break;
                case 'K': // Clear line
                    terminal.clearLine(params[0] || 0);
                    break;
                case 's': // Save cursor
                    terminal.saveCursor();
                    break;
                case 'u': // Restore cursor
                    terminal.restoreCursor();
                    break;
                case 'm': // Color codes
                    for (const param of params) {
                        const paramStr = param.toString();
                        if (paramStr === '0' || paramStr === '') {
                            terminal.setColors('', '');
                        } else if (ansiMappings[paramStr]) {
                            const cssClass = ansiMappings[paramStr];
                            if (cssClass.startsWith('fg-')) {
                                terminal.setColors(cssClass, null);
                            } else if (cssClass.startsWith('bg-')) {
                                terminal.setColors(null, cssClass);
                            }
                        }
                    }
                    break;
            }
        } 
        // Handle pipe codes
        else if (opts.handlePipeCodes && pipeCode) {
            if (pipeCodeMappings[pipeCode]) {
                const cssClass = pipeCodeMappings[pipeCode];
                if (cssClass.startsWith('fg-')) {
                    terminal.setColors(cssClass, null);
                } else if (cssClass.startsWith('bg-')) {
                    terminal.setColors(null, cssClass);
                }
            }
        }
        // Handle Synchronet Ctrl-A attribute codes
        else if (opts.handleCtrlACodes && ctrlAChar) {
            const ch = ctrlAChar.toUpperCase();
            
            if (ch === '\x01') {
                // \x01\x01 = literal Ctrl-A character — write it as text
                terminal.writeText('\x01', opts);
            } else if (ch === 'N') {
                // Normal — reset all attributes
                terminal.setColors('', '');
                ctrlAHighIntensity = false;
            } else if (ch === 'H') {
                // High intensity — subsequent fg colors become bright
                ctrlAHighIntensity = true;
                // If there's already an fg color active, promote it to bright
                if (terminal.currentFg && !terminal.currentFg.includes('bright')) {
                    const currentLetter = Object.keys(ctrlAFgNormal).find(
                        k => ctrlAFgNormal[k] === terminal.currentFg
                    );
                    if (currentLetter) {
                        terminal.setColors(ctrlAFgBright[currentLetter], null);
                    }
                }
            } else if (ch === 'I') {
                // Blink — no direct CSS equivalent, could map to a class
                // For now, treat as no-op (most web renderers ignore blink)
            } else if (ch === '-') {
                // Normal if high — reset high intensity, keep colors at normal
                if (ctrlAHighIntensity) {
                    ctrlAHighIntensity = false;
                    // Demote current bright fg back to normal if possible
                    if (terminal.currentFg && terminal.currentFg.includes('bright')) {
                        const currentLetter = Object.keys(ctrlAFgBright).find(
                            k => ctrlAFgBright[k] === terminal.currentFg
                        );
                        if (currentLetter) {
                            terminal.setColors(ctrlAFgNormal[currentLetter], null);
                        }
                    }
                }
            } else if (ctrlAFgNormal[ch]) {
                // Foreground color letter — use bright or normal based on H state
                const fgClass = ctrlAHighIntensity ? ctrlAFgBright[ch] : ctrlAFgNormal[ch];
                terminal.setColors(fgClass, null);
            } else if (ctrlABg[ctrlAChar]) {
                // Background color digit (use original char, not uppercased)
                terminal.setColors(null, ctrlABg[ctrlAChar]);
            }
        }
        
        lastIndex = escapeRegex.lastIndex;
    }
    
    // Add any remaining text
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
        terminal.writeText(remainingText, opts);
    }
    
    return terminal.toHTML(opts);
}

/**
 * Virtual Terminal Buffer Class - Infinite Height Version for Fidonet
 */
class VirtualTerminal {
    constructor(width = 80, noWrap = false) {
        this.width = width;
        this.noWrap = noWrap;
        this.buffer = [];
        this.cursorX = 0;
        this.cursorY = 0;
        this.savedCursorX = 0;
        this.savedCursorY = 0;
        this.currentFg = '';
        this.currentBg = '';
        this.maxY = 0; // Track highest line used
        
        // Start with one empty line
        this.addLine();
    }
    
    addLine() {
        const line = [];
        for (let x = 0; x < this.width; x++) {
            line[x] = {
                char: ' ',
                fg: '',
                bg: ''
            };
        }
        this.buffer.push(line);
        return this.buffer.length - 1;
    }
    
    ensureLine(y) {
        while (y >= this.buffer.length) {
            this.addLine();
        }
        this.maxY = Math.max(this.maxY, y);
    }
    
    clearScreen() {
        this.buffer = [];
        this.cursorX = 0;
        this.cursorY = 0;
        this.maxY = 0;
        this.addLine();
    }
    
    clearLine(mode = 0) {
        this.ensureLine(this.cursorY);
        const y = this.cursorY;
        var lineLen = this.buffer[y] ? this.buffer[y].length : this.width;
        
        switch (mode) {
            case 0: // Clear from cursor to end
                for (let x = this.cursorX; x < lineLen; x++) {
                    this.buffer[y][x] = { char: ' ', fg: '', bg: '' };
                }
                break;
            case 1: // Clear from start to cursor
                for (let x = 0; x <= this.cursorX && x < lineLen; x++) {
                    this.buffer[y][x] = { char: ' ', fg: '', bg: '' };
                }
                break;
            case 2: // Clear entire line
                for (let x = 0; x < lineLen; x++) {
                    this.buffer[y][x] = { char: ' ', fg: '', bg: '' };
                }
                break;
        }
    }
    
    setCursor(x, y) {
        if (this.noWrap) {
            this.cursorX = Math.max(0, x - 1);
        } else {
            this.cursorX = Math.max(0, Math.min(x - 1, this.width - 1));
        }
        this.cursorY = Math.max(0, y - 1);
        this.ensureLine(this.cursorY);
    }
    
    moveCursor(dx, dy) {
        if (this.noWrap) {
            this.cursorX = Math.max(0, this.cursorX + dx);
        } else {
            this.cursorX = Math.max(0, Math.min(this.cursorX + dx, this.width - 1));
        }
        this.cursorY = Math.max(0, this.cursorY + dy);
        this.ensureLine(this.cursorY);
    }
    
    saveCursor() {
        this.savedCursorX = this.cursorX;
        this.savedCursorY = this.cursorY;
    }
    
    restoreCursor() {
        this.cursorX = this.savedCursorX;
        this.cursorY = this.savedCursorY;
        this.ensureLine(this.cursorY);
    }
    
    setColors(fg, bg) {
        if (fg !== null) this.currentFg = fg;
        if (bg !== null) this.currentBg = bg;
        if (fg === '' && bg === '') {
            this.currentFg = '';
            this.currentBg = '';
        }
    }
    
    writeText(text, opts) {
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            
            if (char === '\r') {
                // Fidonet uses \r for newlines
                this.cursorX = 0;
                this.cursorY++;
                this.ensureLine(this.cursorY);
                
                // Reset pipe colors on newline if requested
                if (opts.resetOnNewline && opts.handlePipeCodes) {
                    this.currentFg = '';
                    this.currentBg = '';
                }
            } else if (char === '\t') {
                // Tab to next 8-character boundary
                const nextTab = Math.ceil((this.cursorX + 1) / 8) * 8;
                if (this.noWrap) {
                    this.cursorX = nextTab;
                } else {
                    this.cursorX = Math.min(nextTab, this.width - 1);
                }
            } else if (char === '\n') {
                // Ignore \n since we use \r for newlines in Fidonet
                continue;
            } else {
                // Regular character
                this.ensureLine(this.cursorY);
                
                if (this.noWrap) {
                    // No-wrap mode: extend line buffer as needed
                    var line = this.buffer[this.cursorY];
                    while (line.length <= this.cursorX) {
                        line.push({ char: ' ', fg: '', bg: '' });
                    }
                    line[this.cursorX] = {
                        char: char,
                        fg: this.currentFg,
                        bg: this.currentBg
                    };
                    this.cursorX++;
                } else if (this.cursorX < this.width) {
                    this.buffer[this.cursorY][this.cursorX] = {
                        char: char,
                        fg: this.currentFg,
                        bg: this.currentBg
                    };
                    this.cursorX++;
                    
                    // Wrap to next line if needed
                    if (this.cursorX >= this.width) {
                        this.cursorX = 0;
                        this.cursorY++;
                        this.ensureLine(this.cursorY);
                    }
                }
            }
        }
    }
    
    toHTML(opts) {
        let html = '';
        let currentSpanClasses = '';
        let inSpan = false;
        
        // Only process lines up to maxY + 1
        const linesToProcess = Math.min(this.buffer.length, this.maxY + 1);
        
        for (let y = 0; y < linesToProcess; y++) {
            let lineHasContent = false;
            let lineHTML = '';
            
            // Line width: in noWrap mode, lines can be longer than this.width
            var lineWidth = this.buffer[y] ? this.buffer[y].length : this.width;
            
            // Check if line has any non-space content
            for (let x = 0; x < lineWidth; x++) {
                if (this.buffer[y] && this.buffer[y][x] && this.buffer[y][x].char !== ' ') {
                    lineHasContent = true;
                    break;
                }
            }
            
            // Skip completely empty lines at the end
            if (!lineHasContent && y === linesToProcess - 1) {
                break;
            }
            
            // In noWrap mode, we need to be smart about spaces:
            //   - Leading spaces → &nbsp; (preserve indentation)
            //   - Runs of 2+ consecutive spaces → &nbsp; (preserve alignment)
            //   - Single spaces between words → regular space (allow browser word-wrap)
            // In fixed-width mode (ANSI art), all spaces → &nbsp; (exact column layout).
            //
            // Strategy: buffer space cells, flush them when we hit a non-space.
            // Then decide &nbsp; vs regular space based on context.
            var pendingSpaces = []; // buffered space cells (with their span classes)
            var seenNonSpace = false; // have we seen any non-space on this line?
            
            for (let x = 0; x < lineWidth; x++) {
                const cell = (this.buffer[y] && this.buffer[y][x]) || { char: ' ', fg: '', bg: '' };
                const classes = [cell.fg, cell.bg].filter(Boolean).join(' ');
                
                if (cell.char === ' ') {
                    // Buffer the space — we'll decide how to emit it later
                    pendingSpaces.push(classes);
                    continue;
                }
                
                // Non-space character — flush any pending spaces first
                if (pendingSpaces.length > 0) {
                    // Decide: &nbsp; or regular space?
                    // In noWrap mode: single spaces between words stay as regular spaces
                    //   so the browser can word-wrap. Leading spaces and runs of 2+
                    //   use &nbsp; to preserve formatting.
                    // In fixed-width mode (no noWrap): all spaces → &nbsp; for exact layout.
                    var useNbsp;
                    if (this.noWrap) {
                        useNbsp = !seenNonSpace || pendingSpaces.length > 1;
                    } else {
                        useNbsp = !!opts.replaceAllSpaces;
                    }
                    var spChar = useNbsp ? '&nbsp;' : ' ';
                    for (var s = 0; s < pendingSpaces.length; s++) {
                        var spClasses = pendingSpaces[s];
                        if (spClasses !== currentSpanClasses) {
                            if (inSpan) { lineHTML += '</span>'; inSpan = false; }
                            if (spClasses) {
                                lineHTML += '<span class="' + spClasses + '">';
                                inSpan = true;
                            }
                            currentSpanClasses = spClasses;
                        }
                        lineHTML += spChar;
                    }
                    pendingSpaces = [];
                }
                
                seenNonSpace = true;
                
                // Handle span opening/closing for this character
                if (classes !== currentSpanClasses) {
                    if (inSpan) {
                        lineHTML += '</span>';
                        inSpan = false;
                    }
                    if (classes) {
                        lineHTML += `<span class="${classes}">`;
                        inSpan = true;
                    }
                    currentSpanClasses = classes;
                }
                
                lineHTML += cell.char;
            }
            
            // Don't flush trailing pending spaces — they get trimmed anyway
            
            // Close any open span at end of line
            if (inSpan) {
                lineHTML += '</span>';
                inSpan = false;
                currentSpanClasses = '';
            }
            
            // Remove trailing spaces/nbsp from line end
            lineHTML = lineHTML.replace(/(&nbsp;|\s)+$/, '');
            
            html += lineHTML;
            
            // Add line break if not the last line
            if (y < linesToProcess - 1) {
                html += '<br>';
            }
        }
        
        return html;
    }
}

/**
 * Strip all terminal codes and return plain text
 * @param {string} text - Text with terminal codes
 * @returns {string} Plain text
 */
function stripTerminalCodes(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    
    return text
        // Remove all ANSI escape sequences
        .replace(/\x1b\[[0-9;]*[ABCDEFGHJKfHlmsu]/g, '')
        .replace(/\033\[[0-9;]*[ABCDEFGHJKfHlmsu]/g, '')
        // Remove pipe codes
        .replace(/\|(\d{2})/g, '')
        // Remove Synchronet Ctrl-A codes (\x01 followed by any char)
        // \x01\x01 (escaped literal) becomes a single \x01
        .replace(/\x01\x01/g, '\x01')
        .replace(/\x01./g, '')
        // Convert \r to \n for plain text output
        .replace(/\r/g, '\n');
}

// Node.js module export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        formatTerminalText,
        stripTerminalCodes
    };
}

// Usage examples for Node.js:
/*
const { formatTerminalText, stripTerminalCodes } = require('./terminal-formatter');

// Fidonet message with \r line endings
const fidonetText = "Hello \x1b[31mred text\x1b[0m\rSecond line with |02green|15 pipe code\r";
const html = formatTerminalText(fidonetText);
console.log(html);

// Custom options
const customHtml = formatTerminalText(fidonetText, {
    replaceAllSpaces: false,
    handlePipeCodes: false,
    terminalWidth: 40
});

// Strip codes for plain text
const plainText = stripTerminalCodes(fidonetText);
console.log(plainText);
*/

// ---------------------------------------------------------------------------
// formatBodyHtml — shared HTML formatter for all tossers (FTN, NNTP, QWK).
//
// Converts raw message body text to HTML with color spans.
// Pipeline:
//   1. Paragraph reflow — reassembles text from wider editors
//   2. ANSI art detection — cursor positioning means fixed-width layout
//   3. Color code routing:
//      - ANSI art → fixed-width virtual terminal (terminalWidth, wrap enabled)
//      - Color codes only → virtual terminal with noWrap (CSS handles layout)
//      - Plain text with alignment → formatTextForHtml (preserves spacing)
//      - Plain text → simple <br> replacement
//
// Optional forceWidth parameter: if set, wraps all output at that column width
// instead of letting CSS handle it. Useful for fixed-width preview contexts.
//
// Non-fatal — returns null on failure so message import continues without HTML.
// ---------------------------------------------------------------------------

async function formatBodyHtml(displayText, forceWidth) {
	if (!displayText) return null;

	try {
		var wrapAt = forceWidth || 80;

		// Ask whether this is art BEFORE touching it, and skip reflow if it
		// is. The order used to be the other way round, and it cost the art:
		// reflowParagraphs joins any consecutive line at or above 80% of the
		// wrap width, which every 78-to-80 column art row is, so three rows
		// became one line and detection then ran on the wreckage. Nothing
		// downstream can put the breaks back, and body_html is written once
		// at toss time. This is what processMessageBody already does for the
		// terminal (termMsgFormat.js: detect on raw text, guard the reflow).
		var isArt = detectAnsiArt(displayText);
		var reflowed = isArt ? displayText : reflowText(displayText, wrapAt);

		if (reflowed.includes("\x1b[") ||
			/\|\d{2}/.test(reflowed) ||
			reflowed.includes("\x01")) {
			return await formatTerminalText(reflowed, {
				terminalWidth: wrapAt,
				noWrap: !isArt && !forceWidth,
				replaceAllSpaces: true,
				handlePipeCodes: true,
				handleAnsiCodes: true,
				handleCtrlACodes: true,
				resetOnNewline: true
			});
		}

		// Plain text — preserve spacing if it has alignment (3+ consecutive spaces).
		// Trailing spaces go first (#60). formatTextForHtml turns them into
		// &nbsp;, which a browser can neither drop nor let hang past the edge,
		// and many systems pad every line out to the full width: OTHERNETS
		// posts carried lines of 81-85 characters, text plus padding. Sized to
		// 80 columns on a phone, the padding overflowed and the card's
		// break-word put it on a line of its own, so the message read as
		// double spaced. They are invisible anyway, and the ANSI path above
		// already drops them.
		if (reflowed.includes("   ")) {
			return formatTextForHtml(reflowed.replace(/[ \t]+(?=\r|$)/g, ''));
		}

		return reflowed.replace(/\r/g, '<br>');
	} catch (_) {
		return null;
	}
}

export{
    formatTerminalText,
    formatBodyHtml,
    stripTerminalCodes
}