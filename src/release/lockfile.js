// lockfile.js -- package-lock.json, and what npm is allowed to change in it.
//
// Every install and update runs `npm install`, and npm rewrites the lockfile
// as it goes. Two rewrites are routine, and neither changes what is installed:
//
//   the root version  npm keeps `version` and `packages[""].version` in step
//                     with package.json. The release script bumped package.json
//                     at every cut and never the lockfile, so every board's npm
//                     "corrected" it on the first install
//   npm's own fields  different npm versions record different metadata. npm 11
//                     adds `hasInstallScript: true` to packages our npm 12
//                     writes without it
//
// The final check of an install or an update compares every file it wrote
// against the release, so either rewrite read as a file that did not land, and
// the run was reported failed after everything had worked. On a fresh install
// that told the sysop to delete a working board and start again.
//
// So the lockfile is compared by what it PINS: which packages, at which
// version, from where, with which integrity hash. Anything else npm changes is
// its business. A difference in what is pinned is still a failure, because it
// means npm did not install what the release said.
//
// The release script also stamps the version into the lockfile wherever it
// stamps package.json, so on a board whose npm matches ours there is nothing
// for npm to rewrite at all.
//
// NODE BUILTINS ONLY: used on the install path, before npm install has run.

import * as fs from 'fs';
import * as path from 'path';

var LOCKFILE = 'package-lock.json';

// The fields that decide what ends up in node_modules. Everything else in a
// package entry is metadata npm is free to add, drop or reorder.
var PIN_FIELDS = ['version', 'resolved', 'integrity', 'link'];

/**
 * Set the root version in lockfile text, keeping npm's formatting (two-space
 * JSON, trailing newline). Returns the text unchanged if it does not parse.
 */
function stampLockfileVersion(text, version) {
	var lock;
	try { lock = JSON.parse(text); } catch (_) { return text; }
	if (!lock || typeof lock !== 'object') return text;
	lock.version = version;
	if (lock.packages && lock.packages[''] && typeof lock.packages[''] === 'object') {
		lock.packages[''].version = version;
	}
	return JSON.stringify(lock, null, 2) + '\n';
}

/**
 * What a lockfile pins: path in node_modules -> the fields that decide what is
 * installed. The root entry ("") is the project itself and is not a pin. Pure.
 */
function pinnedPackages(lock) {
	var out = {};
	var packages = (lock && lock.packages) || {};
	for (var key of Object.keys(packages)) {
		if (key === '') continue;
		var entry = packages[key] || {};
		var pin = {};
		for (var f of PIN_FIELDS) if (entry[f] !== undefined) pin[f] = entry[f];
		out[key] = pin;
	}
	return out;
}

/**
 * The differences in what two lockfiles pin, as readable lines. Empty means
 * npm installed exactly what the release said. Pure.
 *
 * @param {string} expectedText  the lockfile the release shipped
 * @param {string} actualText    the lockfile on disk after npm install
 * @returns {string[]}
 */
function lockfileDifferences(expectedText, actualText) {
	var expected, actual;
	try { expected = JSON.parse(expectedText); } catch (_) { return ['the shipped lockfile does not parse']; }
	try { actual = JSON.parse(actualText); } catch (_) { return ['the installed lockfile does not parse']; }

	var a = pinnedPackages(expected);
	var b = pinnedPackages(actual);
	var out = [];
	for (var key of Object.keys(a)) {
		if (!(key in b)) { out.push(key + ': removed'); continue; }
		for (var f of PIN_FIELDS) {
			if (a[key][f] !== b[key][f]) {
				out.push(key + ': ' + f + ' ' + JSON.stringify(a[key][f]) + ' -> ' + JSON.stringify(b[key][f]));
			}
		}
	}
	for (var k of Object.keys(b)) {
		if (!(k in a)) out.push(k + ': added');
	}
	return out;
}

/**
 * Take a verify result and drop a package-lock.json mismatch when the only
 * differences are npm's own rewriting. Works on both result shapes in use:
 * mismatched as bare paths (verifyApplied) or as {path, ...} (verifyTree).
 *
 * @param {object} result      { ok, missing, mismatched }
 * @param {object} opts        { targetRoot, sourceRoot }: the install, and the
 *                             tree holding the lockfile the release shipped
 * @returns {{result: object, note: string|null}} note says what was forgiven,
 *          or why the lockfile was NOT forgiven
 */
function forgiveNormalisedLockfile(result, opts) {
	var mismatched = (result && result.mismatched) || [];
	var idx = mismatched.findIndex(function (m) { return (typeof m === 'string' ? m : m && m.path) === LOCKFILE; });
	if (idx === -1) return { result: result, note: null };

	var shipped, installed;
	try {
		shipped = fs.readFileSync(path.join(opts.sourceRoot, LOCKFILE), 'utf8');
		installed = fs.readFileSync(path.join(opts.targetRoot, LOCKFILE), 'utf8');
	} catch (e) {
		return { result: result, note: 'package-lock.json differs and could not be compared: ' + e.message };
	}

	var diffs = lockfileDifferences(shipped, installed);
	if (diffs.length) {
		return {
			result: result,
			note: 'package-lock.json pins different packages than the release: ' +
				diffs.slice(0, 5).join('; ') + (diffs.length > 5 ? '; and ' + (diffs.length - 5) + ' more' : '')
		};
	}

	var rest = mismatched.slice(0, idx).concat(mismatched.slice(idx + 1));
	var missing = (result && result.missing) || [];
	var next = Object.assign({}, result, { mismatched: rest, ok: missing.length === 0 && rest.length === 0 });
	return {
		result: next,
		note: 'package-lock.json was rewritten by npm, which pins exactly the same packages as the release'
	};
}

export {
	LOCKFILE,
	PIN_FIELDS,
	stampLockfileVersion,
	pinnedPackages,
	lockfileDifferences,
	forgiveNormalisedLockfile
};
