// shippedTree.js -- what a release artifact contains, and how each file is
// treated when it lands on an install.
//
// This is the "one definition" section 10 of UPDATE_SYSTEM_DESIGN promises.
// Today the same categorisation is written twice, in setup/update.sh and (until
// #44) in setup/install.sh, and the two drifted: install.sh never received the
// overlay work, so its update mode deleted public/ including every sysop-added
// asset. Two copies of a rule is one copy too many when the failure mode is
// silent deletion of someone else's work.
//
// The categories are behavioural, not cosmetic. Each one is a claim about what
// the updater is allowed to do to a file that is already there:
//
//   code         overwrite, and delete target-only files in the directory.
//                Sysop content here is destroyed, which is why the directories
//                are listed rather than inferred.
//   overlay      overwrite shipped files, leave target-only files alone.
//                public/ mixes shipped assets with sysop branding.
//   overlay-seed write once when absent, never again. public/css/custom.css is
//                sysop-authored by design; shipping it every update would wipe
//                the customisation it exists to hold.
//   data         merge, and ask before replacing a file that differs.
//   art          skipped unless asked for, since art is the first thing a sysop
//                replaces. New files are still added.
//
// The category travels in the manifest rather than being re-derived by the
// updater, so a release that adds a directory carries the rule for it.
//
// Pure except for listTrackedFiles, which shells out to git.

import { execFileSync } from 'child_process';

var CATEGORY_CODE         = 'code';
var CATEGORY_OVERLAY      = 'overlay';
var CATEGORY_OVERLAY_SEED = 'overlay-seed';
var CATEGORY_DATA         = 'data';
var CATEGORY_ART          = 'art';

var CATEGORIES = [
	CATEGORY_CODE,
	CATEGORY_OVERLAY,
	CATEGORY_OVERLAY_SEED,
	CATEGORY_DATA,
	CATEGORY_ART
];

// Directory prefixes, longest match wins so a nested rule can override.
var DIRECTORY_CATEGORIES = [
	{ prefix: 'bin/',      category: CATEGORY_CODE },
	{ prefix: 'db/',       category: CATEGORY_CODE },
	{ prefix: 'docs/',     category: CATEGORY_CODE },
	{ prefix: 'examples/', category: CATEGORY_CODE },
	{ prefix: 'setup/',    category: CATEGORY_CODE },
	{ prefix: 'src/',      category: CATEGORY_CODE },
	{ prefix: 'tests/',    category: CATEGORY_CODE },
	{ prefix: 'public/',   category: CATEGORY_OVERLAY },
	{ prefix: 'config/',   category: CATEGORY_DATA },
	{ prefix: 'xtrn/',     category: CATEGORY_DATA },
	{ prefix: 'txtfiles/', category: CATEGORY_ART }
];

// Exact paths that override whatever their directory says.
var FILE_CATEGORIES = {
	'package.json':         CATEGORY_CODE,
	'package-lock.json':    CATEGORY_CODE,
	'ecosystem.config.cjs': CATEGORY_CODE,
	'.mocharc.yml':         CATEGORY_CODE,
	'README.md':            CATEGORY_CODE,
	'LICENSE':              CATEGORY_CODE,
	'public/css/custom.css': CATEGORY_OVERLAY_SEED
};

// Tracked in the repository, deliberately not shipped.
//
// scripts/ holds maintainer tooling: the release script itself and the MCP doc
// sync. Neither runs on an install, and the release script shipping inside its
// own artifact invites someone to cut a release from a deployed board.
// reference/ is research notes about other software.
var EXCLUDED_PREFIXES = [
	'scripts/',
	'reference/'
];

var EXCLUDED_FILES = [
	'.gitignore',
	'.gitattributes',
	'.gitmodules'
];

/**
 * Which category a repository-relative path belongs to.
 *
 * @returns {string|null} a category, or null when the path is not shipped.
 */
function categoryForPath(relPath) {
	var p = String(relPath || '').replace(/^\.\//, '');
	if (!p) return null;

	if (EXCLUDED_FILES.indexOf(p) !== -1) return null;
	for (var ex of EXCLUDED_PREFIXES) {
		if (p.indexOf(ex) === 0) return null;
	}

	if (Object.prototype.hasOwnProperty.call(FILE_CATEGORIES, p)) return FILE_CATEGORIES[p];

	var best = null;
	for (var rule of DIRECTORY_CATEGORIES) {
		if (p.indexOf(rule.prefix) !== 0) continue;
		if (best === null || rule.prefix.length > best.prefix.length) best = rule;
	}
	return best ? best.category : null;
}

/** Is this path part of a release artifact at all? */
function isShipped(relPath) {
	return categoryForPath(relPath) !== null;
}

/**
 * Filter a path list down to what ships, each with its category.
 *
 * Sorted by path so a manifest built twice from the same tree is byte
 * identical, which is what makes two manifests comparable and a checksum
 * meaningful.
 *
 * @param {string[]} paths repository-relative paths
 * @returns {Array<{path:string, category:string}>}
 */
function selectShippedFiles(paths) {
	var out = [];
	for (var p of (paths || [])) {
		var category = categoryForPath(p);
		if (category === null) continue;
		out.push({ path: String(p).replace(/^\.\//, ''), category: category });
	}
	out.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
	return out;
}

/**
 * Every file git tracks in `root`.
 *
 * git is the source of truth rather than a directory walk because a working
 * tree also holds node_modules, logs, an install's ftn spool and whatever else
 * a maintainer left lying about. Asking git means the artifact contains what
 * the repository contains and nothing else.
 */
function listTrackedFiles(root) {
	var out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
	return out.toString('utf8').split('\0').filter(function (p) { return p.length > 0; });
}

export {
	CATEGORIES,
	CATEGORY_CODE,
	CATEGORY_OVERLAY,
	CATEGORY_OVERLAY_SEED,
	CATEGORY_DATA,
	CATEGORY_ART,
	DIRECTORY_CATEGORIES,
	FILE_CATEGORIES,
	EXCLUDED_PREFIXES,
	EXCLUDED_FILES,
	categoryForPath,
	isShipped,
	selectShippedFiles,
	listTrackedFiles
};
