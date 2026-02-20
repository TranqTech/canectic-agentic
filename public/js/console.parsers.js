function parsePipeColorCodes() {
    // Get all elements with class "messagebody"
    const messageBodyElements = document.querySelectorAll('.messagebody');
    
    // Color code mappings based on your pipe codes document
    const colorMappings = {
        // Foreground colors
        '00': 'fg-black',
        '01': 'fg-darkblue',
        '02': 'fg-green',
        '03': 'fg-cyan',
        '04': 'fg-red',
        '05': 'fg-magenta',
        '06': 'fg-yellow',
        '07': 'fg-grey',
        '08': 'fg-brightgrey',
        '09': 'fg-brightblue',
        '10': 'fg-brightgreen',
        '11': 'fg-brightcyan',
        '12': 'fg-brightred',
        '13': 'fg-brightmagenta',
        '14': 'fg-brightyellow',
        '15': 'fg-white',
        
        // Background colors
        '16': 'bg-black',
        '17': 'bg-darkblue',
        '18': 'bg-green',
        '19': 'bg-cyan',
        '20': 'bg-red',
        '21': 'bg-magenta',
        '22': 'bg-yellow',
        '23': 'bg-grey',
        
        // ICE colors (bright backgrounds) - using best available matches
        '24': 'bg-brightgrey',
        '25': 'bg-brightblue',
        '26': 'bg-brightgreen',
        '27': 'bg-brightcyan',
        '28': 'bg-brightred',
        '29': 'bg-brightmagenta',
        '30': 'bg-brightyellow',
        '31': 'bg-brightwhite'
    };
    
    messageBodyElements.forEach(element => {
        let content = element.innerHTML;
        let currentFgClass = '';
        let currentBgClass = '';
        
        // Regular expression to match pipe codes: |## format
        const pipeRegex = /\|(\d{2})/g;
        let lastIndex = 0;
        let result = '';
        let match;
        
        while ((match = pipeRegex.exec(content)) !== null) {
            const code = match[1];
            const beforeMatch = content.slice(lastIndex, match.index);
            
            // Process text before this pipe code, checking for newlines
            if (beforeMatch) {
                const segments = beforeMatch.split(/(\n|<br\s*\/?>)/i);
                
                for (let i = 0; i < segments.length; i++) {
                    const segment = segments[i];
                    
                    if (segment === '\n' || segment.match(/<br\s*\/?>/i)) {
                        // Reset colors on newline and add the newline
                        if (currentFgClass || currentBgClass) {
                            // Close any open span before the newline
                            result += segment;
                        } else {
                            result += segment;
                        }
                        currentFgClass = '';
                        currentBgClass = '';
                    } else if (segment) {
                        // Add text with current styling
                        if (currentFgClass || currentBgClass) {
                            const classes = [currentFgClass, currentBgClass].filter(Boolean).join(' ');
                            result += `<span class="${classes}">${segment}</span>`;
                        } else {
                            result += segment;
                        }
                    }
                }
            }
            
            // Update current classes based on the code
            if (colorMappings[code]) {
                const newClass = colorMappings[code];
                if (newClass.startsWith('fg-')) {
                    currentFgClass = newClass;
                } else if (newClass.startsWith('bg-')) {
                    currentBgClass = newClass;
                }
            }
            
            lastIndex = pipeRegex.lastIndex;
        }
        
        // Add any remaining text after the last pipe code
        const remainingText = content.slice(lastIndex);
        if (remainingText) {
            const segments = remainingText.split(/(\n|<br\s*\/?>)/i);
            
            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];
                
                if (segment === '\n' || segment.match(/<br\s*\/?>/i)) {
                    // Reset colors on newline and add the newline
                    result += segment;
                    currentFgClass = '';
                    currentBgClass = '';
                } else if (segment) {
                    // Add text with current styling
                    if (currentFgClass || currentBgClass) {
                        const classes = [currentFgClass, currentBgClass].filter(Boolean).join(' ');
                        result += `<span class="${classes}">${segment}</span>`;
                    } else {
                        result += segment;
                    }
                }
            }
        }
        
        // Update the element's innerHTML with the processed content
        element.innerHTML = result;
    });
}

// Alternative version that processes a specific element
function parsePipeColorCodesForElement(element) {
    if (!element) return;
    
    const colorMappings = {
        // Foreground colors
        '00': 'fg-black',
        '01': 'fg-darkblue',
        '02': 'fg-green',
        '03': 'fg-cyan',
        '04': 'fg-red',
        '05': 'fg-magenta',
        '06': 'fg-yellow',
        '07': 'fg-grey',
        '08': 'fg-brightgrey',
        '09': 'fg-brightblue',
        '10': 'fg-brightgreen',
        '11': 'fg-brightcyan',
        '12': 'fg-brightred',
        '13': 'fg-brightmagenta',
        '14': 'fg-brightyellow',
        '15': 'fg-white',
        
        // Background colors
        '16': 'bg-black',
        '17': 'bg-darkblue',
        '18': 'bg-green',
        '19': 'bg-cyan',
        '20': 'bg-red',
        '21': 'bg-magenta',
        '22': 'bg-yellow',
        '23': 'bg-grey',
        
        // ICE colors (bright backgrounds)
        '24': 'bg-brightgrey',
        '25': 'bg-brightblue',
        '26': 'bg-brightgreen',
        '27': 'bg-brightcyan',
        '28': 'bg-brightred',
        '29': 'bg-brightmagenta',
        '30': 'bg-brightyellow',
        '31': 'bg-brightwhite'
    };
    
    let content = element.innerHTML;
    let currentFgClass = '';
    let currentBgClass = '';
    
    const pipeRegex = /\|(\d{2})/g;
    let lastIndex = 0;
    let result = '';
    let match;
    
    while ((match = pipeRegex.exec(content)) !== null) {
        const code = match[1];
        const beforeMatch = content.slice(lastIndex, match.index);
        
        // Process text before this pipe code, checking for newlines
        if (beforeMatch) {
            const segments = beforeMatch.split(/(\n|<br\s*\/?>)/i);
            
            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];
                
                if (segment === '\n' || segment.match(/<br\s*\/?>/i)) {
                    // Reset colors on newline and add the newline
                    result += segment;
                    currentFgClass = '';
                    currentBgClass = '';
                } else if (segment) {
                    // Add text with current styling
                    if (currentFgClass || currentBgClass) {
                        const classes = [currentFgClass, currentBgClass].filter(Boolean).join(' ');
                        result += `<span class="${classes}">${segment}</span>`;
                    } else {
                        result += segment;
                    }
                }
            }
        }
        
        // Update current classes based on the code
        if (colorMappings[code]) {
            const newClass = colorMappings[code];
            if (newClass.startsWith('fg-')) {
                currentFgClass = newClass;
            } else if (newClass.startsWith('bg-')) {
                currentBgClass = newClass;
            }
        }
        
        lastIndex = pipeRegex.lastIndex;
    }
    
    // Add any remaining text after the last pipe code
    const remainingText = content.slice(lastIndex);
    if (remainingText) {
        const segments = remainingText.split(/(\n|<br\s*\/?>)/i);
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            
            if (segment === '\n' || segment.match(/<br\s*\/?>/i)) {
                // Reset colors on newline and add the newline
                result += segment;
                currentFgClass = '';
                currentBgClass = '';
            } else if (segment) {
                // Add text with current styling
                if (currentFgClass || currentBgClass) {
                    const classes = [currentFgClass, currentBgClass].filter(Boolean).join(' ');
                    result += `<span class="${classes}">${segment}</span>`;
                } else {
                    result += segment;
                }
            }
        }
    }
    
    element.innerHTML = result;
}


// //Ansi

// /**
//  * Parse ANSI escape codes and apply appropriate CSS classes to all .messagebody elements
//  * Or parse a specific text string if provided
//  */
// function parseAnsiColorCodes(text = null) {
//     // If no text provided, process all .messagebody elements
//     if (text === null) {
//         const elements = document.querySelectorAll('.messagebody');
//         elements.forEach(element => {
//             element.innerHTML = parseAnsiColorCodesForText(element.innerHTML);
//         });
//         return;
//     }
    
//     // If text provided, parse and return it
//     return parseAnsiColorCodesForText(text);
// }

// /**
//  * Internal function to parse ANSI codes in text
//  */
// function parseAnsiColorCodesForText(text) {
//     if (!text || typeof text !== 'string') {
//         return text;
//     }
    
//     // ANSI color code mappings based on your CSS classes
//     const ansiMappings = {
//         // Reset
//         '0': 'reset',
        
//         // Standard foreground colors (30-37)
//         '30': 'fg-black',
//         '31': 'fg-red',
//         '32': 'fg-green', 
//         '33': 'fg-yellow',
//         '34': 'fg-blue',
//         '35': 'fg-magenta',
//         '36': 'fg-cyan',
//         '37': 'fg-white',
        
//         // Bright foreground colors (90-97)
//         '90': 'fg-brightgrey',     // Dark grey (closest to bright black)
//         '91': 'fg-brightred',
//         '92': 'fg-brightgreen',
//         '93': 'fg-brightyellow',
//         '94': 'fg-brightblue',
//         '95': 'fg-brightmagenta',
//         '96': 'fg-brightcyan',
//         '97': 'fg-brightwhite',
        
//         // Standard background colors (40-47)
//         '40': 'bg-black',
//         '41': 'bg-red',
//         '42': 'bg-green',
//         '43': 'bg-yellow',
//         '44': 'bg-blue',
//         '45': 'bg-magenta',
//         '46': 'bg-cyan',
//         '47': 'bg-white',
        
//         // Bright background colors (100-107)
//         '100': 'bg-brightgrey',
//         '101': 'bg-brightred',
//         '102': 'bg-brightgreen',
//         '103': 'bg-brightyellow',
//         '104': 'bg-brightblue',
//         '105': 'bg-brightmagenta',
//         '106': 'bg-brightcyan',
//         '107': 'bg-brightwhite'
//     };
    
//     let currentFgClass = '';
//     let currentBgClass = '';
//     let result = '';
    
//     // Regex to match ANSI escape sequences: \x1b[XXm or \033[XXm
//     // Also handles sequences like \x1b[31;42m (multiple codes)
//     const ansiRegex = /\x1b\[([0-9;]*)m|\033\[([0-9;]*)m/g;
    
//     let lastIndex = 0;
//     let match;
    
//     while ((match = ansiRegex.exec(text)) !== null) {
//         // Get the codes (either from group 1 or 2)
//         const codes = (match[1] || match[2]).split(';').filter(code => code !== '');
        
//         // Add any text before this ANSI code
//         const beforeMatch = text.slice(lastIndex, match.index);
//         if (beforeMatch) {
//             if (currentFgClass || currentBgClass) {
//                 const classes = [currentFgClass, currentBgClass].filter(Boolean).join(' ');
//                 result += `<span class="${classes}">${beforeMatch}</span>`;
//             } else {
//                 result += beforeMatch;
//             }
//         }
        
//         // Process each code in the sequence
//         for (const code of codes) {
//             if (code === '0' || code === '') {
//                 // Reset all colors
//                 currentFgClass = '';
//                 currentBgClass = '';
//             } else if (ansiMappings[code]) {
//                 const cssClass = ansiMappings[code];
//                 if (cssClass.startsWith('fg-')) {
//                     currentFgClass = cssClass;
//                 } else if (cssClass.startsWith('bg-')) {
//                     currentBgClass = cssClass;
//                 }
//             }
//             // Ignore unknown codes
//         }
        
//         lastIndex = ansiRegex.lastIndex;
//     }
    
//     // Add any remaining text after the last ANSI code
//     const remainingText = text.slice(lastIndex);
//     if (remainingText) {
//         if (currentFgClass || currentBgClass) {
//             const classes = [currentFgClass, currentBgClass].filter(Boolean).join(' ');
//             result += `<span class="${classes}">${remainingText}</span>`;
//         } else {
//             result += remainingText;
//         }
//     }
    
//     return result;
// }

// /**
//  * Parse ANSI codes for elements with a specific class
//  * @param {string} className - Class name to search for (default: 'messagebody')
//  */
// function parseAnsiColorCodesForElements(className = 'messagebody') {
//     const elements = document.querySelectorAll(`.${className}`);
    
//     elements.forEach(element => {
//         element.innerHTML = parseAnsiColorCodes(element.innerHTML);
//     });
// }

// /**
//  * Parse ANSI codes for a specific element
//  * @param {HTMLElement} element - The element to process
//  */
// function parseAnsiColorCodesForElement(element) {
//     if (!element) return;
//     element.innerHTML = parseAnsiColorCodesForText(element.innerHTML);
// }

// /**
//  * Strip ANSI codes from text (useful for getting plain text)
//  * @param {string} text - Text containing ANSI codes
//  * @returns {string} Text with ANSI codes removed
//  */
// function stripAnsiCodes(text) {
//     if (!text || typeof text !== 'string') {
//         return text;
//     }
    
//     return text.replace(/\x1b\[[0-9;]*m|\033\[[0-9;]*m/g, '');
// }

// /**
//  * Convert common ANSI codes to their numeric equivalents for reference
//  */
// const ANSI_CODES = {
//     // Reset
//     RESET: '\x1b[0m',
    
//     // Foreground colors
//     FG_BLACK: '\x1b[30m',
//     FG_RED: '\x1b[31m',
//     FG_GREEN: '\x1b[32m',
//     FG_YELLOW: '\x1b[33m',
//     FG_BLUE: '\x1b[34m',
//     FG_MAGENTA: '\x1b[35m',
//     FG_CYAN: '\x1b[36m',
//     FG_WHITE: '\x1b[37m',
    
//     // Bright foreground colors
//     FG_BRIGHT_BLACK: '\x1b[90m',
//     FG_BRIGHT_RED: '\x1b[91m',
//     FG_BRIGHT_GREEN: '\x1b[92m',
//     FG_BRIGHT_YELLOW: '\x1b[93m',
//     FG_BRIGHT_BLUE: '\x1b[94m',
//     FG_BRIGHT_MAGENTA: '\x1b[95m',
//     FG_BRIGHT_CYAN: '\x1b[96m',
//     FG_BRIGHT_WHITE: '\x1b[97m',
    
//     // Background colors
//     BG_BLACK: '\x1b[40m',
//     BG_RED: '\x1b[41m',
//     BG_GREEN: '\x1b[42m',
//     BG_YELLOW: '\x1b[43m',
//     BG_BLUE: '\x1b[44m',
//     BG_MAGENTA: '\x1b[45m',
//     BG_CYAN: '\x1b[46m',
//     BG_WHITE: '\x1b[47m',
    
//     // Bright background colors
//     BG_BRIGHT_BLACK: '\x1b[100m',
//     BG_BRIGHT_RED: '\x1b[101m',
//     BG_BRIGHT_GREEN: '\x1b[102m',
//     BG_BRIGHT_YELLOW: '\x1b[103m',
//     BG_BRIGHT_BLUE: '\x1b[104m',
//     BG_BRIGHT_MAGENTA: '\x1b[105m',
//     BG_BRIGHT_CYAN: '\x1b[106m',
//     BG_BRIGHT_WHITE: '\x1b[107m'
// };

// // Usage examples:
// /*
// // Process all .messagebody elements (most common usage)
// parseAnsiColorCodes();

// // Parse specific text and return result
// const ansiText = "Hello \x1b[31mred text\x1b[0m and \x1b[32mgreen text\x1b[0m!";
// const htmlOutput = parseAnsiColorCodes(ansiText);
// console.log(htmlOutput);
// // Output: "Hello <span class=\"fg-red\">red text</span> and <span class=\"fg-green\">green text</span>!"

// // Multiple codes in one sequence
// const complexAnsi = "Normal \x1b[31;42mred on green\x1b[0m normal again";
// const htmlComplex = parseAnsiColorCodes(complexAnsi);
// console.log(htmlComplex);
// // Output: "Normal <span class=\"fg-red bg-green\">red on green</span> normal again"

// // Colors persist across newlines (unlike pipe codes)
// const multilineAnsi = "Start \x1b[34mblue text\nstill blue on new line\x1b[0m\nreset now";
// const htmlMultiline = parseAnsiColorCodes(multilineAnsi);
// console.log(htmlMultiline);
// // Output: "Start <span class=\"fg-blue\">blue text\nstill blue on new line</span>\nreset now"

// // Parse specific element
// const element = document.getElementById('myElement');
// parseAnsiColorCodesForElement(element);

// // Strip ANSI codes to get plain text
// const plainText = stripAnsiCodes(ansiText);
// console.log(plainText); // "Hello red text and green text!"
// */