// src/utils/configvars.js
// Variable substitution engine for command lines, paths, and configuration strings.
//
// Modeled after Synchronet/Mystic BBS @-code and %-code systems.
// Any admin-configurable string (door cmd, dropfile dir, door dir, door args, etc.)
// can contain %X tokens that are replaced at runtime with system, session, and
// door-specific values.
//
// Usage:
//   import { substitute } from '../utils/configvars.js';
//
//   var expandedCmd = substitute(doorConfig.cmd, call, doorConfig);
//   var expandedDir = substitute(doorConfig.dropfileDir, call, doorConfig);
//
// The call and doorConfig arguments are optional — unknown or unavailable
// variables resolve to empty string rather than crashing.

import appConfig from "../config/appConfig.js";

// --- Variable definitions ---
// Each entry: { token, description, resolve(call, doorConfig) }
// Tokens are case-insensitive in substitution.

const VARIABLE_DEFS = [
	// --- Node / Session ---
	{ token: '%N',  description: 'Node number',                              resolve: (c) => c?.nodenum ?? '' },
	{ token: '%#',  description: 'Node number (same as %N)',                  resolve: (c) => c?.nodenum ?? '' },
	{ token: '%*',  description: 'Node number (zero-padded to 3 digits)',     resolve: (c) => c?.nodenum !== undefined ? String(c.nodenum).padStart(3, '0') : '' },
	{ token: '%I',  description: 'Session UUID',                             resolve: (c) => c?.uuid ?? '' },

	// --- User ---
	{ token: '%U',  description: 'Username (alias)',                          resolve: (c) => c?.caller_username ?? '' },
	{ token: '%A',  description: 'Username (alias, same as %U)',              resolve: (c) => c?.caller_username ?? '' },
	{ token: '%R',  description: 'Real name (fullname)',                      resolve: (c) => c?.caller_fullname ?? '' },
	{ token: '%1',  description: 'User record ID',                           resolve: (c) => c?.user_record?.id ?? '' },
	{ token: '%2',  description: 'User record ID (zero-padded to 2 digits)', resolve: (c) => c?.user_record?.id !== undefined ? String(c.user_record.id).padStart(2, '0') : '' },
	{ token: '%3',  description: 'User record ID (zero-padded to 3 digits)', resolve: (c) => c?.user_record?.id !== undefined ? String(c.user_record.id).padStart(3, '0') : '' },
	{ token: '%4',  description: 'User record ID (zero-padded to 4 digits)', resolve: (c) => c?.user_record?.id !== undefined ? String(c.user_record.id).padStart(4, '0') : '' },
	{ token: '%$',  description: 'User security level',                      resolve: (c) => c?.security ?? '' },
	{ token: '%L',  description: 'User location',                            resolve: (c) => c?.caller_location ?? '' },

	// --- Terminal ---
	{ token: '%W',  description: 'Terminal width (columns)',                  resolve: (c) => c?.term_width ?? 80 },
	{ token: '%H',  description: 'Terminal height (rows)',                    resolve: (c) => c?.term_height ?? 24 },
	{ token: '%E',  description: 'Terminal encoding (e.g. CP437, utf-8)',     resolve: (c) => c?.term_encoding ?? '' },
	{ token: '%Y',  description: 'Terminal type (e.g. ANSI, Dumb)',           resolve: (c) => c?.term_type ?? '' },

	// --- Connection ---
	{ token: '%B',  description: 'Baud rate (DTE)',                           resolve: (c) => c?.baudRate ?? 38400 },
	{ token: '%T',  description: 'Time left (seconds)',                       resolve: (c) => c?.timeleft ?? 9999 },
	{ token: '%C',  description: 'Connection type (TCP, WebSocket, Telnet)',  resolve: (c) => c?.connection_type ?? '' },
	{ token: '%P',  description: 'Port number',                               resolve: (c) => c?.port ?? 0 },

	// --- Door config ---
	{ token: '%D',  description: 'Door directory (from door config)',                resolve: (c, d) => d?.doorDir ?? '' },
	{ token: '%F',  description: 'Dropfile directory (from door config)',             resolve: (c, d) => d?.dropfileDir ?? '' },
	{ token: '%S',  description: 'Door script filename (from door config)',           resolve: (c, d) => d?.doorScript ?? '' },
	{ token: '%X',  description: 'Door command (from door config)',                   resolve: (c, d) => d?.cmd ?? '' },
	{ token: '%G',  description: 'Door slug',                                        resolve: (c, d) => d?.slug ?? '' },

	// --- System directories (from env) ---
	{ token: '%!',  description: 'Door base directory',                       resolve: () => appConfig.get('doordir', '') },
	{ token: '%Z',  description: 'Text/art directory',                        resolve: () => appConfig.get('textdir', '') },
	{ token: '%K',  description: 'Config directory (cwd/config)',             resolve: () => process.cwd() + '/config' },
	{ token: '%J',  description: 'Data directory (cwd/data)',                 resolve: () => process.cwd() + '/data' },
	{ token: '%M',  description: 'DOSemu drive C',                           resolve: () => appConfig.get('dosemu_drive_c') || process.env.HOME + '/.dosemu/drive_c' },

	// --- System info ---
	{ token: '%O',  description: 'Board name',                               resolve: () => appConfig.get('boardname', '') },
	{ token: '%Q',  description: 'System name',                              resolve: () => appConfig.get('system_name', '') },
	{ token: '%V',  description: 'Web port',                                 resolve: () => appConfig.get('webport', '') },

	// --- Escape ---
	{ token: '%%',  description: 'Literal percent sign',                      resolve: () => '%' },
];

// Build a lookup map: uppercase token → resolve function
var _tokenMap = null;
function _getTokenMap() {
	if (_tokenMap) return _tokenMap;
	_tokenMap = new Map();
	// Sort by token length descending so %% and %* match before single-char tokens
	var sorted = VARIABLE_DEFS.slice().sort((a, b) => b.token.length - a.token.length);
	for (var def of sorted) {
		_tokenMap.set(def.token.toUpperCase(), def.resolve);
	}
	return _tokenMap;
}

// --- Public API ---

/**
 * Replace all %X tokens in a template string with runtime values.
 *
 * @param {string} template  - The string containing %X variable tokens
 * @param {object} [call]    - The IncomingCall object (node, user, terminal data)
 * @param {object} [doorConfig] - The normalized door config object
 * @returns {string} The expanded string with all tokens replaced
 */
function substitute(template, call, doorConfig) {
	if (!template || typeof template !== 'string') return template || '';
	if (template.indexOf('%') === -1) return template;  // fast path

	var map = _getTokenMap();

	// Walk the string, looking for % followed by one or more token characters
	var result = '';
	var i = 0;
	while (i < template.length) {
		if (template[i] === '%' && i + 1 < template.length) {
			// Try longest match first (2-char tokens like %*, %#, %!, %%)
			var matched = false;
			// Check 2-char token
			var tok2 = template.substring(i, i + 2).toUpperCase();
			var resolver = map.get(tok2);
			if (resolver) {
				var val = resolver(call, doorConfig);
				result += val !== null && val !== undefined ? String(val) : '';
				i += 2;
				matched = true;
			}
			if (!matched) {
				// No match -- pass through the %X literally
				result += template[i];
				i++;
			}
		} else {
			result += template[i];
			i++;
		}
	}

	// Expand leading ~/ to HOME directory (Node fs does not shell-expand tilde)
	if (result.startsWith('~/') && process.env.HOME) {
		result = process.env.HOME + result.substring(1);
	}

	return result;
}

/**
 * Substitute variables in an array of strings (e.g. doorArgs).
 */
function substituteArray(arr, call, doorConfig) {
	if (!arr || !Array.isArray(arr)) return arr;
	return arr.map(function(item) {
		return typeof item === 'string' ? substitute(item, call, doorConfig) : item;
	});
}

/**
 * Get the full variable definition list for admin reference display.
 * Returns array of { token, description }.
 */
function getVariableList() {
	return VARIABLE_DEFS.map(function(def) {
		return { token: def.token, description: def.description };
	});
}

export { substitute, substituteArray, getVariableList };
