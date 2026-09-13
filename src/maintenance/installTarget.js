// installTarget.js -- reading an installation, so a release can be planned
// against it.
//
// Two manifests come out of this and the difference between them is the whole
// point:
//
//   `local`     what is on disk right now, hashed.
//   `installed` the MANIFEST the last release left behind, which is what it
//               SHIPPED.
//
// A config file that matches `installed` is one nobody has touched, so the
// update is safe to take. One that differs is the sysop's, and theirs wins.
// update.sh cannot ask this question at all: it compares mtimes, which say when
// a file was written and nothing about whether it differs from what shipped.
//
// An installation predating the release machinery has no MANIFEST, and the
// honest answer is then that the question cannot be answered. `installed` is
// null and the plan treats every changed data file as the sysop's.
//
// Lives here rather than inside the update tool because the version of an
// installation is a fact several callers want and none of them should be
// reading package.json for themselves. That was already a bug once: the tool
// reported the version of the tree it was RUNNING from rather than the tree it
// was about to modify, which are the same thing only when --target is the
// current directory.

import * as fs from 'fs';
import * as path from 'path';
import { scanInstalledFiles } from '../release/shippedTree.js';
import { buildManifest, parseManifest, MANIFEST_FILENAME } from '../release/manifest.js';
import { formatVersion } from '../utils/version.js';

/**
 * What the installation says it is.
 *
 * package.json is the authority, the same source systeminfo uses for the
 * running process, and for the same reason: a version is not a preference, and
 * the config row for it goes stale on an upgraded install.
 *
 * @returns {string|null} the canonical version, or null when there is nothing
 *                        readable there. Null means "not a Canectic install",
 *                        not "old".
 */
function installedVersion(root) {
	try {
		var pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		return formatVersion(pkg.version);
	} catch (_) {
		return null;
	}
}

/** Does this look like somewhere a release can be applied? */
function looksLikeInstall(root) {
	try {
		return fs.statSync(path.join(root, 'package.json')).isFile();
	} catch (_) {
		return false;
	}
}

/**
 * Describe an installation the way an artifact is described.
 *
 * @returns {{local, installed, scanned, version}}
 */
function describeInstall(root) {
	var files = scanInstalledFiles(root);
	var local = buildManifest({
		root: root, files: files,
		version: installedVersion(root),
		generated: new Date().toISOString()
	});

	var installed = null;
	var manifestFile = path.join(root, MANIFEST_FILENAME);
	if (fs.existsSync(manifestFile)) {
		try {
			installed = parseManifest(fs.readFileSync(manifestFile, 'utf8'));
		} catch (_) {
			// A corrupt manifest is the same as none: we cannot tell which data
			// files the sysop edited, so every changed one is treated as theirs.
			installed = null;
		}
	}

	return { local: local, installed: installed, scanned: files.length, version: local.version };
}

export {
	installedVersion,
	looksLikeInstall,
	describeInstall
};
