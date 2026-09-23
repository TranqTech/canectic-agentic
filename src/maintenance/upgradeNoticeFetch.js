// upgradeNoticeFetch.js -- fetch the upgrade notices a move would bring, and
// only believe them once they are proven to be the project's.
//
// Used by the update check (so the Update page can show them before the
// button) and by src/tools/update.js (so a shell update shows them before it
// applies). The rules for which notices apply are in
// src/release/upgradeNotices.js; this is the part that talks to a source.
//
// A notice can tell a sysop to run a command, so an unverified one is not
// shown at all (#55). The chain is the one the bootstrap and the updater use:
// SHA256SUMS signed by the release key this board already trusts (its own
// setup/canectic-release.asc, the pin), then every sidecar checked against
// SHA256SUMS. Anything short of that returns verified: false with the reason,
// and the caller points at the release notes instead.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { fetchText } from './updateStaging.js';
import { parseMetadata, metadataName } from '../release/metadata.js';
import { verifyDetachedSignature, PUBLIC_KEY_FILENAME } from '../release/signing.js';
import { releasesBetween, gatherNotices } from '../release/upgradeNotices.js';

var SUMS = 'SHA256SUMS';

/** Parse a SHA256SUMS listing into name -> hash. */
function parseSums(text) {
	var out = new Map();
	for (var line of String(text || '').split('\n')) {
		var m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
		if (m) out.set(m[2], m[1]);
	}
	return out;
}

/**
 * The notices every release in (running, target] declares, verified.
 *
 * @param {object} opts
 * @param {object} opts.source   dirSource or httpSource, the publish directory
 * @param {object} opts.index    that channel's index, through parseIndex
 * @param {string} opts.running  the version this board runs
 * @param {string} opts.target   the version being moved to
 * @param {string} opts.pinFrom  this installation's setup/canectic-release.asc
 * @param {function} [opts.verify]  seam for tests, as verifyDetachedSignature
 * @param {function} [opts.fetch]   seam for tests, as fetchText
 * @returns {Promise<{target, verified, reason, items, releases}>} items are
 *   gathered but NOT filtered by the running version, so a stored result can
 *   be judged again against whatever is running when it is read
 */
async function fetchUpgradeNotices(opts) {
	var o = opts || {};
	var get = o.fetch || fetchText;
	var verify = o.verify || verifyDetachedSignature;
	var base = { target: o.target, verified: false, reason: null, items: [], releases: [] };

	var releases = releasesBetween(o.index, o.running, o.target);
	base.releases = releases.map(function (r) { return r.version; });
	if (!releases.length) return Object.assign(base, { verified: true });

	var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canectic-notices-'));
	try {
		// Sequential on purpose: fetchText names its temporary file by time.
		var sumsText, sigText, keyText;
		try {
			sumsText = await get(o.source, SUMS);
			sigText = await get(o.source, SUMS + '.asc');
			keyText = await get(o.source, PUBLIC_KEY_FILENAME);
		} catch (e) {
			return Object.assign(base, { reason: 'could not fetch ' + SUMS + ', its signature and the release key: ' + e.message });
		}
		fs.writeFileSync(path.join(tmp, SUMS), sumsText);
		fs.writeFileSync(path.join(tmp, SUMS + '.asc'), sigText);
		fs.writeFileSync(path.join(tmp, PUBLIC_KEY_FILENAME), keyText);

		var sig = verify({
			file: path.join(tmp, SUMS), sig: path.join(tmp, SUMS + '.asc'),
			keyMaterial: path.join(tmp, PUBLIC_KEY_FILENAME), pinFrom: o.pinFrom,
			fileLabel: SUMS, keyLabel: 'the release directory'
		});
		if (sig.state !== 'verified') return Object.assign(base, { reason: SUMS + ' is not verified: ' + sig.detail });

		var sums = parseSums(sumsText);
		var metas = [];
		for (var r of releases) {
			var name = r.metadata || metadataName(r.version);
			var want = sums.get(name);
			if (!want) return Object.assign(base, { reason: name + ' is not listed in ' + SUMS });
			var text;
			try { text = await get(o.source, name); } catch (e) {
				return Object.assign(base, { reason: 'could not fetch ' + name + ': ' + e.message });
			}
			var got = createHash('sha256').update(text, 'utf8').digest('hex');
			if (got !== want) return Object.assign(base, { reason: name + ' does not match ' + SUMS });
			var meta;
			try { meta = parseMetadata(text); } catch (e) {
				return Object.assign(base, { reason: name + ' is not valid release metadata: ' + e.message });
			}
			metas.push({ version: r.version, notices: meta.notices || [] });
		}
		return Object.assign(base, { verified: true, items: gatherNotices(metas) });
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

export { fetchUpgradeNotices, parseSums };
