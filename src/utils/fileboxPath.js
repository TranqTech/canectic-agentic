// src/utils/fileboxPath.js — Shared path resolver for filebox and wildcard directories.
//
// Handles %X variable substitution (via configvars.js), ~ expansion,
// and relative-to-base resolution. Used by the BSO scanner, session
// controller, and transfer engine for outbox/inbox/wildcard target dirs.

import * as path from 'path';
import { substitute } from './configvars.js';
import appConfig from '../config/appConfig.js';

/**
 * Resolve a filebox or wildcard target directory path.
 *
 * Resolution order:
 *   1. %X variable substitution (includes ~ expansion via substitute())
 *   2. If absolute (starts with /): use as-is
 *   3. Otherwise: join with baseDir (itself resolved via substitute())
 *
 * @param {string} configuredPath — raw path from connection_data or wildcard rule
 * @param {string} [baseDir]     — parent dir for relative paths (default: filebox_base_dir config)
 * @returns {string} fully resolved absolute path
 */
function resolveFileboxPath(configuredPath, baseDir) {
	if (!configuredPath) return '';

	// Step 1: %X substitution (also handles ~ expansion)
	var expanded = substitute(configuredPath);

	// Step 2: absolute path — use as-is
	if (path.isAbsolute(expanded)) return expanded;

	// Step 3: resolve against base dir
	var base = baseDir || appConfig.get('filebox_base_dir', 'ftn/filebox');
	base = substitute(base);
	if (!path.isAbsolute(base)) {
		base = path.resolve(base);
	}

	return path.join(base, expanded);
}

export { resolveFileboxPath };
