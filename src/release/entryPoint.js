// entryPoint.js -- the files a new sysop fetches before they have anything.
//
// A release is resolved by a bootstrap script the sysop downloads on its own,
// outside any archive, so it is the one part of the system that cannot ship
// inside a release and be found. It has to sit at the root of the release host
// beside the channel indexes.
//
// Published by the release script rather than copied up by hand, for the reason
// every other pair of hand-maintained copies in this codebase drifted: the
// bootstrap changes between releases and a stale one on the host is invisible.
// It resolves the newest release perfectly well, verifies its checksum, and
// then hands off to an installer it was never checked against. Nothing fails
// until it fails on somebody else's machine.
//
// The install guide travels with it because the release notes promise it does:
// a sysop deciding whether to install should be able to read what installing
// involves without downloading a release first.
//
// The checksum file is written in `sha256sum -c` format, which is the exact
// command INSTALL.md tells people to run. A checksum published in a format the
// documented command cannot read is worse than none, because it looks checked.

import * as fs from 'fs';
import * as path from 'path';
import { hashFile } from './manifest.js';

var BOOTSTRAP_NAME = 'bootstrap.sh';
var BOOTSTRAP_SUMS_NAME = 'bootstrap.sh.sha256';
var INSTALL_DOC_NAME = 'INSTALL.md';

/** Where each published name comes from inside the repository. */
function entryPointSources(root) {
	return [
		{ name: BOOTSTRAP_NAME, from: path.join(root, 'setup', BOOTSTRAP_NAME), mode: 0o755 },
		{ name: INSTALL_DOC_NAME, from: path.join(root, 'docs', 'sysop', INSTALL_DOC_NAME), mode: null }
	];
}

/**
 * Copy the entry point into a publish directory and write the bootstrap's
 * checksum beside it.
 *
 * @param {object} opts
 * @param {string} opts.root    repository root to copy from
 * @param {string} opts.output  publish directory to copy into
 * @returns {string[]} the names written, in publish order
 */
function publishEntryPoint(opts) {
	var root = opts.root;
	var output = opts.output;
	fs.mkdirSync(output, { recursive: true });

	var written = [];
	for (var src of entryPointSources(root)) {
		if (!fs.existsSync(src.from)) {
			throw new Error('the release host needs ' + src.name + ' and it is not in the tree: ' + src.from);
		}
		var dest = path.join(output, src.name);
		fs.copyFileSync(src.from, dest);
		if (src.mode !== null) fs.chmodSync(dest, src.mode);
		written.push(src.name);
	}

	fs.writeFileSync(path.join(output, BOOTSTRAP_SUMS_NAME),
		hashFile(path.join(output, BOOTSTRAP_NAME)) + '  ' + BOOTSTRAP_NAME + '\n');
	written.push(BOOTSTRAP_SUMS_NAME);

	return written;
}

export {
	BOOTSTRAP_NAME,
	BOOTSTRAP_SUMS_NAME,
	INSTALL_DOC_NAME,
	entryPointSources,
	publishEntryPoint
};
