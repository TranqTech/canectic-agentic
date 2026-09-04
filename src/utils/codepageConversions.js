// CP437 to Unicode mapping table (characters 128-255)
const CP437_TO_UNICODE = [
    0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7, // 128-135
    0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5, // 136-143
    0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9, // 144-151
    0x00FF, 0x00D6, 0x00DC, 0x00A2, 0x00A3, 0x00A5, 0x20A7, 0x0192, // 152-159
    0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA, // 160-167
    0x00BF, 0x2310, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB, // 168-175
    0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, // 176-183
    0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510, // 184-191
    0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F, // 192-199
    0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567, // 200-207
    0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B, // 208-215
    0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580, // 216-223
    0x03B1, 0x00DF, 0x0393, 0x03C0, 0x03A3, 0x03C3, 0x00B5, 0x03C4, // 224-231
    0x03A6, 0x0398, 0x03A9, 0x03B4, 0x221E, 0x03C6, 0x03B5, 0x2229, // 232-239
    0x2261, 0x00B1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00F7, 0x2248, // 240-247
    0x00B0, 0x2219, 0x00B7, 0x221A, 0x207F, 0x00B2, 0x25A0, 0x00A0  // 248-255
];

// Create reverse mapping (Unicode to CP437)
const UNICODE_TO_CP437 = new Map();
for (let i = 0; i < CP437_TO_UNICODE.length; i++) {
    UNICODE_TO_CP437.set(CP437_TO_UNICODE[i], i + 128);
}

/**
 * Convert CP437 encoded data to UTF-8 string
 * @param {Uint8Array|Array|string} cp437Data - CP437 encoded data
 * @returns {string} UTF-8 string
 */
function cp437ToUtf8(cp437Data) {
    let result = '';
    
    // Handle different input types
    let bytes;
    if (typeof cp437Data === 'string') {
        // If string, get character codes
        bytes = [];
        for (let i = 0; i < cp437Data.length; i++) {
            bytes.push(cp437Data.charCodeAt(i));
        }
    } else if (cp437Data instanceof Uint8Array) {
        bytes = Array.from(cp437Data);
    } else {
        bytes = cp437Data;
    }
    
    for (let byte of bytes) {
        if (byte < 128) {
            // Standard ASCII (0-127) - same in both encodings
            result += String.fromCharCode(byte);
        } else {
            // Extended ASCII (128-255) - use mapping table
            const unicodeChar = CP437_TO_UNICODE[byte - 128];
            result += String.fromCharCode(unicodeChar);
        }
    }
    
    return result;
}

/**
 * Convert UTF-8 string to CP437 encoded data
 * @param {string} utf8String - UTF-8 string
 * @param {boolean} returnUint8Array - If true, return Uint8Array, otherwise return regular array
 * @returns {Uint8Array|Array} CP437 encoded data
 */
function utf8ToCp437(utf8String, returnUint8Array = false) {
    const result = [];
    
    for (let i = 0; i < utf8String.length; i++) {
        const charCode = utf8String.charCodeAt(i);
        
        if (charCode < 128) {
            // Standard ASCII (0-127) - same in both encodings
            result.push(charCode);
        } else {
            // Check if character exists in CP437
            const cp437Code = UNICODE_TO_CP437.get(charCode);
            if (cp437Code !== undefined) {
                result.push(cp437Code);
            } else {
                // Character not available in CP437, use replacement character (usually '?')
                result.push(63); // ASCII code for '?'
            }
        }
    }
    
    return returnUint8Array ? new Uint8Array(result) : result;
}

/**
 * Check if a string can be fully represented in CP437
 * @param {string} utf8String - UTF-8 string to check
 * @returns {object} Object with {canRepresent: boolean, unsupportedChars: Array}
 */
function canRepresentInCp437(utf8String) {
    const unsupportedChars = [];
    
    for (let i = 0; i < utf8String.length; i++) {
        const charCode = utf8String.charCodeAt(i);
        
        if (charCode >= 128 && !UNICODE_TO_CP437.has(charCode)) {
            unsupportedChars.push({
                char: utf8String[i],
                charCode: charCode,
                position: i
            });
        }
    }
    
    return {
        canRepresent: unsupportedChars.length === 0,
        unsupportedChars: unsupportedChars
    };
}

/**
 * Get the CP437 character for a given code (0-255)
 * @param {number} code - CP437 character code
 * @returns {string} The character
 */
function cp437CharFromCode(code) {
    if (code < 0 || code > 255) {
        throw new Error('CP437 code must be between 0 and 255');
    }
    
    if (code < 128) {
        return String.fromCharCode(code);
    } else {
        return String.fromCharCode(CP437_TO_UNICODE[code - 128]);
    }
}

/**
 * Get the CP437 code for a given character
 * @param {string} char - Character to encode
 * @returns {number|null} CP437 code or null if not representable
 */
function cp437CodeFromChar(char) {
    if (char.length !== 1) {
        throw new Error('Input must be a single character');
    }
    
    const charCode = char.charCodeAt(0);
    
    if (charCode < 128) {
        return charCode;
    } else {
        return UNICODE_TO_CP437.get(charCode) || null;
    }
}

function cp437ToUtf8StringConv(cp437string){
    let byteEncode = new TextEncoder();
    var cp437Bytes = byteEncode.encode(cp437string);
    var utf8String = cp437ToUtf8(cp437Bytes)
    return utf8String
}

// Usage examples:
/*
// Convert CP437 bytes to UTF-8 string
const cp437Bytes = [72, 101, 108, 108, 111, 32, 177, 32, 178]; // "Hello ± ²"
const utf8String = cp437ToUtf8(cp437Bytes);
console.log(utf8String); // "Hello ± ²"

// Convert UTF-8 string to CP437 bytes
const utf8Text = "Café ñ";
const cp437Array = utf8ToCp437(utf8Text);
console.log(cp437Array); // [67, 97, 102, 130, 32, 164]

// Check if string can be represented in CP437
const check = canRepresentInCp437("Hello 世界"); // Contains Chinese characters
console.log(check); // {canRepresent: false, unsupportedChars: [...]}

// Get specific CP437 character
const boxChar = cp437CharFromCode(186); // ╣
console.log(boxChar);

// Get CP437 code for character  
const code = cp437CodeFromChar('±');
console.log(code); // 241
*/


/**
 * Replace leading and trailing spaces with &nbsp; while preserving spaces between words
 * @param {string} str - The input string
 * @returns {string} String with leading/trailing spaces replaced with &nbsp;
 */
function replaceEdgeSpaces(str) {
    if (!str || typeof str !== 'string') {
        return str;
    }
    
    // Match leading spaces
    const leadingSpaces = str.match(/^ +/);
    const leadingCount = leadingSpaces ? leadingSpaces[0].length : 0;
    
    // Match trailing spaces
    const trailingSpaces = str.match(/ +$/);
    const trailingCount = trailingSpaces ? trailingSpaces[0].length : 0;
    
    // Get the middle content (without leading/trailing spaces)
    const middleContent = str.slice(leadingCount, str.length - trailingCount);
    
    // Build result with &nbsp; for leading/trailing spaces
    const leadingNbsp = '&nbsp;'.repeat(leadingCount);
    const trailingNbsp = '&nbsp;'.repeat(trailingCount);
    
    return leadingNbsp + middleContent + trailingNbsp;
}

/**
 * Process multiple lines, replacing leading/trailing spaces on each line
 * @param {string} text - Multi-line text
 * @returns {string} Text with leading/trailing spaces replaced with &nbsp; on each line
 */
function replaceEdgeSpacesMultiline(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    
    return text.split('\n').map(line => replaceEdgeSpaces(line)).join('\n');
}

/**
 * Alternative version using regex replacement
 * @param {string} str - The input string
 * @returns {string} String with leading/trailing spaces replaced with &nbsp;
 */
function replaceEdgeSpacesRegex(str) {
    if (!str || typeof str !== 'string') {
        return str;
    }
    
    return str
        // Replace leading spaces
        .replace(/^ +/, match => '&nbsp;'.repeat(match.length))
        // Replace trailing spaces
        .replace(/ +$/, match => '&nbsp;'.repeat(match.length))
}

/**
 * Process text for HTML output, handling both edge spaces and newlines
 * @param {string} text - Input text
 * @param {boolean} preserveNewlines - Whether to convert \n to <br>
 * @returns {string} HTML-formatted text
 */
function formatTextForHtml(text, preserveNewlines = true) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    
    let result = text;
    
    // Escape HTML entities before any formatting to prevent XSS
    result = result
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    
    // Process each line separately
    result = result.split('\r').map(line => replaceEdgeSpaces(line)).join("\r");
    result = replaceMultipleSpaces(result)
    
    // Convert newlines to <br> if requested
    if (preserveNewlines) {
        result = result.replace(/\r/g, '<br>');
    }
    
    return result;
}

function replaceMultipleSpaces(str) {
    if (!str || typeof str !== 'string') {
        return str;
    }
    
    // Replace all sequences of 2 or more spaces with the same number of &nbsp;
    return str.replace(/ {2,}/g, match => '&nbsp;'.repeat(match.length));
}

/**
 * Fast CP437 -> UTF-8 decode for a whole buffer.
 *
 * cp437ToUtf8() appends one character at a time, which is fine for short
 * strings but allocation-heavy when decoding millions of message bodies during
 * a message base import. This maps bytes through a lookup table and joins once.
 *
 * The table is built from cp437ToUtf8() itself, so output is identical by
 * construction and the two can never drift apart.
 *
 * @param {Uint8Array|Buffer|Array} bytes - CP437 encoded bytes
 * @returns {string} UTF-8 string
 */
var CP437_CHAR_TABLE = null;

function cp437CharTable() {
    if (!CP437_CHAR_TABLE) {
        CP437_CHAR_TABLE = new Array(256);
        for (var i = 0; i < 256; i++) {
            CP437_CHAR_TABLE[i] = cp437ToUtf8([i]);
        }
    }
    return CP437_CHAR_TABLE;
}

function cp437BufferToUtf8(bytes) {
    if (!bytes || bytes.length === 0) return '';
    var table = cp437CharTable();
    var out = new Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) {
        out[i] = table[bytes[i]];
    }
    return out.join('');
}

export{
    cp437ToUtf8,
    cp437BufferToUtf8,
    utf8ToCp437,
    cp437ToUtf8StringConv,
    replaceEdgeSpaces,
    formatTextForHtml,
    replaceMultipleSpaces
}