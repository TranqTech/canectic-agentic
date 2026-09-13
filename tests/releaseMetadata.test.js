// tests/releaseMetadata.test.js: what a release says about itself.
//
// Principle 2 of UPDATE_SYSTEM_DESIGN: prose in a changelog is for humans and
// cannot be executed. The v0.9.6 changelog carries nine upgrade actions and the
// update script runs two; the rest are the sysop's job to read, match against
// their install and perform, and several are silent when missed. This module
// turns those into declarations, so the assertions worth having are about the
// declarations being complete and self consistent.
//
// The one that matters most is the three-way agreement on a delta base. A
// development build states its base three times over: in its own version, in
// the metadata `base` field, and in the tag it was built from. Three
// independent statements of one fact is a build-time check, and a disagreement
// published is a sysop who fetches the wrong base and reconstructs a tree that
// is silently not the release.
//
// Pure: no database, no services.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
	codenameFor, artifactName, metadataName, manifestName, buildStamp,
	developmentVersionFor, buildMetadata, validateMetadata, serialiseMetadata,
	parseMetadata, normalisePending, emptyPending, NOTICE_LEVELS,
	CODENAME_ALPHA, CODENAME_BETA, CODENAME_FINAL
} from '../src/release/metadata.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var SHA = 'a'.repeat(64);

function soundStable(overrides) {
	return Object.assign(buildMetadata({
		version: '0.9.6a',
		released: '2026-09-20',
		sha256: SHA,
		migrations: ['0001-menu-layout'],
		node_min: '22.0.0',
		steps: [{ id: 'dbmigrations', description: 'Apply the schema', automatic: true }],
		notices: [{ level: 'warning', text: 'Something changed underneath you.' }]
	}), overrides || {});
}

describe('codenames', function () {

	it('follows the phase letters they were chosen to line up with', function () {
		assert.strictEqual(codenameFor('0.9.6a'), CODENAME_ALPHA);
		assert.strictEqual(codenameFor('0.9.6b'), CODENAME_BETA);
		assert.strictEqual(codenameFor('1.0.0'), CODENAME_FINAL);
		assert.strictEqual(codenameFor('0.9.6a.20260913'), CODENAME_ALPHA);
	});

	it('has no answer for a non-version', function () {
		assert.strictEqual(codenameFor('banana'), null);
	});
});

describe('artifact naming', function () {

	it('names a stable tarball and a development delta differently', function () {
		assert.strictEqual(artifactName('0.9.6a'), 'canectic-0.9.6a.tar.gz');
		assert.strictEqual(artifactName('0.9.6a.20260913', { delta: true }),
			'canectic-0.9.6a.20260913.delta.tar.gz');
	});

	it('names the metadata and the standalone manifest after the version', function () {
		assert.strictEqual(metadataName('0.9.6a'), 'canectic-0.9.6a.json');
		assert.strictEqual(manifestName('0.9.6a'), 'canectic-0.9.6a.manifest.json');
	});

	it('normalises a stray v prefix rather than baking it into a filename', function () {
		assert.strictEqual(artifactName('v0.9.6a'), 'canectic-0.9.6a.tar.gz');
	});
});

describe('developmentVersionFor', function () {

	it('carries the base stable plus the build date', function () {
		assert.strictEqual(developmentVersionFor('0.9.5a', new Date(2026, 8, 13)), '0.9.5a.20260913');
		assert.strictEqual(developmentVersionFor('0.9.5a', new Date(2026, 0, 1)), '0.9.5a.20260101');
	});

	it('appends a counter only for a second build in one day', function () {
		assert.strictEqual(developmentVersionFor('0.9.5a', new Date(2026, 8, 13), 1), '0.9.5a.20260913');
		assert.strictEqual(developmentVersionFor('0.9.5a', new Date(2026, 8, 13), 2), '0.9.5a.20260913.2');
	});

	it('refuses to base a build on another build', function () {
		// Deltas are always one hop against stable. Chaining them would mean
		// replaying every intermediate build to reconstruct the current one,
		// and one pruned artifact breaks the chain for everyone downstream.
		assert.strictEqual(developmentVersionFor('0.9.5a.20260901', new Date()), null);
	});

	it('stamps the local date, which is the build date a maintainer means', function () {
		assert.strictEqual(buildStamp(new Date(2026, 11, 31)), '20261231');
	});
});

describe('buildMetadata', function () {

	it('derives channel, codename and base from the version rather than asking', function () {
		var stable = buildMetadata({ version: '0.9.6a', released: '2026-09-20' });
		assert.strictEqual(stable.channel, 'stable');
		assert.strictEqual(stable.base, null);
		assert.strictEqual(stable.base_artifact, null);
		assert.strictEqual(stable.delta, false);

		var dev = buildMetadata({ version: '0.9.6a.20260913', released: '2026-09-13' });
		assert.strictEqual(dev.channel, 'development');
		assert.strictEqual(dev.base, '0.9.6a');
		assert.strictEqual(dev.base_artifact, 'canectic-0.9.6a.tar.gz');
		assert.strictEqual(dev.delta, true);
	});

	it('defaults a step to manual, since claiming automatic is the dangerous half', function () {
		var m = buildMetadata({ version: '0.9.6a', steps: [{ id: 'x', description: 'y' }] });
		assert.strictEqual(m.steps[0].automatic, false);
	});
});

describe('validateMetadata', function () {

	it('passes sound metadata', function () {
		assert.deepStrictEqual(validateMetadata(soundStable()), []);
	});

	it('catches a base that disagrees with the version', function () {
		// The packaging bug this exists for: a build cut from the wrong tag, or
		// a metadata file hand edited, telling clients to fetch a base the
		// delta was not computed against.
		var dev = buildMetadata({ version: '0.9.6a.20260913', released: '2026-09-13', sha256: SHA });
		dev.base = '0.9.5a';
		var problems = validateMetadata(dev);
		assert.ok(problems.some(function (p) { return /deltas against 0\.9\.6a/.test(p); }), problems.join('; '));
	});

	it('catches a channel that disagrees with the version', function () {
		var problems = validateMetadata(soundStable({ channel: 'development' }));
		assert.ok(problems.some(function (p) { return /channel is "development"/.test(p); }));
	});

	it('catches a stable claiming to be a delta and a delta claiming to be whole', function () {
		assert.ok(validateMetadata(soundStable({ delta: true }))
			.some(function (p) { return /delta is true/.test(p); }));
		var dev = buildMetadata({ version: '0.9.6a.20260913', released: '2026-09-13', sha256: SHA });
		dev.delta = false;
		assert.ok(validateMetadata(dev).some(function (p) { return /delta is false/.test(p); }));
	});

	it('refuses an unverifiable artifact', function () {
		assert.ok(validateMetadata(soundStable({ sha256: null }))
			.some(function (p) { return /sha256 is missing/.test(p); }));
		assert.ok(validateMetadata(soundStable({ sha256: 'short' }))
			.some(function (p) { return /sha256 is missing or malformed/.test(p); }));
	});

	it('refuses a manual step with no command, which is an instruction to do nothing', function () {
		var problems = validateMetadata(soundStable({
			steps: [{ id: 'thing', description: 'Do the thing', automatic: false, command: null }]
		}));
		assert.ok(problems.some(function (p) { return /carries no command/.test(p); }), problems.join('; '));
	});

	it('refuses a duplicate step id, since a step is addressed by it', function () {
		var problems = validateMetadata(soundStable({
			steps: [
				{ id: 'same', description: 'a', automatic: true },
				{ id: 'same', description: 'b', automatic: true }
			]
		}));
		assert.ok(problems.some(function (p) { return /duplicate step id/.test(p); }));
	});

	it('refuses a notice level nothing renders', function () {
		var problems = validateMetadata(soundStable({ notices: [{ level: 'urgent', text: 'x' }] }));
		assert.ok(problems.some(function (p) { return /notice level "urgent"/.test(p); }));
		for (var level of NOTICE_LEVELS) {
			assert.deepStrictEqual(validateMetadata(soundStable({ notices: [{ level: level, text: 'x' }] })), []);
		}
	});

	it('refuses a malformed migration id, matching the ledger rule', function () {
		// The ledger refuses a file it cannot order rather than sorting it
		// somewhere arbitrary. Publishing an id it would refuse would make the
		// move rule compare against something no ledger can ever record.
		assert.ok(validateMetadata(soundStable({ migrations: ['menu-layout'] }))
			.some(function (p) { return /malformed/.test(p); }));
		assert.ok(validateMetadata(soundStable({ migrations: ['0006-Fix_Thing'] }))
			.some(function (p) { return /malformed/.test(p); }));
	});

	it('refuses the retired version form, which is parsed but never emitted', function () {
		var problems = validateMetadata(soundStable({ version: '0.9.1-alpha.1' }));
		assert.ok(problems.some(function (p) { return /retired form/.test(p); }));
	});

	it('reports every problem at once, because a release is cut in one pass', function () {
		var problems = validateMetadata(soundStable({ sha256: null, released: 'soon', channel: 'nonsense' }));
		assert.ok(problems.length >= 3, problems.join('; '));
	});

	it('says so plainly when handed something that is not metadata', function () {
		assert.deepStrictEqual(validateMetadata(null), ['metadata is not an object']);
		assert.ok(validateMetadata({ version: 'banana' })[0].indexOf('not a Canectic version') !== -1);
	});
});

describe('serialise and parse', function () {

	it('round trips', function () {
		var m = soundStable();
		assert.deepStrictEqual(parseMetadata(serialiseMetadata(m)), m);
	});

	it('throws rather than returning metadata it knows is wrong', function () {
		assert.throws(function () { parseMetadata('{"version":"0.9.6a"}'); }, /is invalid/);
		assert.throws(function () { parseMetadata('nope'); }, /not valid JSON/);
	});
});

describe('pending declarations', function () {

	it('normalises a hand written file into the declared shape', function () {
		var p = normalisePending({ steps: [{ id: 'a', description: 'b' }], notices: [{ text: 'c' }] });
		assert.strictEqual(p.steps[0].automatic, false);
		assert.strictEqual(p.steps[0].applies_when, null);
		assert.strictEqual(p.notices[0].level, 'info');
	});

	it('tolerates a missing file', function () {
		assert.deepStrictEqual(normalisePending(null), { steps: [], notices: [], min_upgrade_from: null, node_min: null });
	});

	it('clears per-cycle declarations but carries the standing floor forward', function () {
		// steps and notices belong to one release. min_upgrade_from and
		// node_min are facts about what the software can upgrade from and run
		// on, so resetting them would leave every release after the first
		// declaring no floor at all.
		var cleared = emptyPending({ steps: [{ id: 'a' }], notices: [{ text: 'b' }], min_upgrade_from: '0.9.0a', node_min: '22.0.0' });
		assert.deepStrictEqual(cleared.steps, []);
		assert.deepStrictEqual(cleared.notices, []);
		assert.strictEqual(cleared.min_upgrade_from, '0.9.0a');
		assert.strictEqual(cleared.node_min, '22.0.0');
	});
});

describe('the pending file in this repository', function () {

	it('declares steps and notices that would survive a release cut', function () {
		var file = path.join(ROOT, 'docs', 'releases', 'pending.json');
		if (!fs.existsSync(file)) return this.skip();
		var pending = normalisePending(JSON.parse(fs.readFileSync(file, 'utf8')));
		var meta = buildMetadata({
			version: '9.9.9a', released: '2026-01-01', sha256: SHA,
			steps: pending.steps, notices: pending.notices,
			min_upgrade_from: pending.min_upgrade_from, node_min: '22.0.0'
		});
		assert.deepStrictEqual(validateMetadata(meta), []);
	});
});
