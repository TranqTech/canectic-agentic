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
        resetOnNewline: true,   // Reset pipe codes on newlines (\r)
        terminalWidth: 80       // Terminal width in characters (height is infinite)
    };
    
    const opts = { ...defaults, ...options };
    
    // Create virtual terminal buffer with infinite height
    const terminal = new VirtualTerminal(opts.terminalWidth);
    
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
    
    // Process text with all escape sequences
    const escapeRegex = /(\x1b\[([0-9;]*)([ABCDEFGHJKfHlmsu])|\033\[([0-9;]*)([ABCDEFGHJKfHlmsu])|\|(\d{2}))/g;
    
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
    constructor(width = 80) {
        this.width = width;
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
        
        switch (mode) {
            case 0: // Clear from cursor to end
                for (let x = this.cursorX; x < this.width; x++) {
                    this.buffer[y][x] = { char: ' ', fg: '', bg: '' };
                }
                break;
            case 1: // Clear from start to cursor
                for (let x = 0; x <= this.cursorX && x < this.width; x++) {
                    this.buffer[y][x] = { char: ' ', fg: '', bg: '' };
                }
                break;
            case 2: // Clear entire line
                for (let x = 0; x < this.width; x++) {
                    this.buffer[y][x] = { char: ' ', fg: '', bg: '' };
                }
                break;
        }
    }
    
    setCursor(x, y) {
        this.cursorX = Math.max(0, Math.min(x - 1, this.width - 1));
        this.cursorY = Math.max(0, y - 1);
        this.ensureLine(this.cursorY);
    }
    
    moveCursor(dx, dy) {
        this.cursorX = Math.max(0, Math.min(this.cursorX + dx, this.width - 1));
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
                this.cursorX = Math.min(nextTab, this.width - 1);
            } else if (char === '\n') {
                // Ignore \n since we use \r for newlines in Fidonet
                continue;
            } else {
                // Regular character
                this.ensureLine(this.cursorY);
                
                if (this.cursorX < this.width) {
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
            
            // Check if line has any non-space content
            for (let x = 0; x < this.width; x++) {
                if (this.buffer[y] && this.buffer[y][x] && this.buffer[y][x].char !== ' ') {
                    lineHasContent = true;
                    break;
                }
            }
            
            // Skip completely empty lines at the end
            if (!lineHasContent && y === linesToProcess - 1) {
                break;
            }
            
            for (let x = 0; x < this.width; x++) {
                const cell = (this.buffer[y] && this.buffer[y][x]) || { char: ' ', fg: '', bg: '' };
                const classes = [cell.fg, cell.bg].filter(Boolean).join(' ');
                
                // Handle span opening/closing
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
                
                // Add character (convert spaces to &nbsp; if requested)
                let char = cell.char;
                if (opts.replaceAllSpaces && char === ' ') {
                    char = '&nbsp;';
                }
                lineHTML += char;
            }
            
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

export{
    formatTerminalText,
    stripTerminalCodes
}