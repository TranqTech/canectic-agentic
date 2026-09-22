// tests/identity.test.js: what a release archive says it is.
//
// Three files ride at the root of every archive, and the split between them is
// the point. CANECTIC.ID and the metadata JSON are contracts a machine reads;
// FILE_ID.DIZ is presentation on the 45-column canvas the convention has used
// for thirty years. Parsing a version out of a description works until somebody
// improves the wording, which is exactly the sort of thing a description is
// for.
//
// All three are generated from one metadata object, which is what makes the
// duplication safe. Two hand-maintained statements of one fact is how the
// directory lists in install.sh and update.sh drifted until one of them deleted
// a sysop's assets.
//
// The assertions that matter:
//
//   The metadata shipped INSIDE carries no sha256 of the archive it is inside.
//   A number that vouches for the thing it is sealed in vouches for nothing.
//
//   The DIZ fits. Older file listers truncate at 45 columns and 10 lines
//   without asking, so a description that overruns is a description that reads
//   as broken on somebody else's board.
//
// Pure: no filesystem.

import assert from 'assert';
import {
	IDENTITY_FILENAME, DIZ_FILENAME, DIZ_WIDTH, DIZ_LINES,
	withoutSelfChecksum, serialiseIdentity, parseIdentity, buildFileIdDiz
} from '../src/release/identity.js';
import { buildMetadata } from '../src/release/metadata.js';

var SHA = 'a'.repeat(64);

function meta(overrides) {
	return Object.assign(buildMetadata({
		version: '0.9.6a', released: '2026-09-20', sha256: SHA,
		migrations: ['0001-menu-layout', '0002-msgid-tuple-split'],
		node_min: '22.0.0', min_upgrade_from: '0.9.0a'
	}), overrides || {});
}

describe('the filenames', function () {

	it('are the conventional ones, uppercase, and carry no version', function () {
		// A path with a version in it means every reader has to know the
		// version before it can find out the version.
		assert.strictEqual(IDENTITY_FILENAME, 'CANECTIC.ID');
		assert.strictEqual(DIZ_FILENAME, 'FILE_ID.DIZ');
	});
});

describe('withoutSelfChecksum', function () {

	it('drops the checksum of the archive it ships inside', function () {
		// You would be trusting the archive to vouch for the archive.
		var inside = withoutSelfChecksum(meta());
		assert.strictEqual(inside.sha256, undefined);
		assert.ok(inside.sha256_note, 'and says where the real one is');
	});

	it('keeps everything the updater actually needs', function () {
		var inside = withoutSelfChecksum(meta());
		assert.strictEqual(inside.version, '0.9.6a');
		assert.deepStrictEqual(inside.migrations, ['0001-menu-layout', '0002-msgid-tuple-split']);
		assert.strictEqual(inside.node_min, '22.0.0');
		assert.strictEqual(inside.min_upgrade_from, '0.9.0a');
	});

	it('does not mutate what it was given', function () {
		var m = meta();
		withoutSelfChecksum(m);
		assert.strictEqual(m.sha256, SHA);
	});
});

describe('CANECTIC.ID', function () {

	it('carries what a reader needs to identify an archive', function () {
		var id = parseIdentity(serialiseIdentity(meta()));
		assert.strictEqual(id.software, 'Canectic BBS');
		assert.strictEqual(id.version, '0.9.6a');
		assert.strictEqual(id.channel, 'stable');
		assert.strictEqual(id.codename, 'Handshake');
		assert.strictEqual(id.node_min, '22.0.0');
		assert.strictEqual(id.min_upgrade_from, '0.9.0a');
		assert.deepStrictEqual(id.migrations, ['0001-menu-layout', '0002-msgid-tuple-split']);
	});

	it('says whether it is a delta and what it needs', function () {
		var dev = parseIdentity(serialiseIdentity(meta({
			version: '0.9.6a.20260913', channel: 'development', delta: true, base: '0.9.6a'
		})));
		assert.strictEqual(dev.delta, true);
		assert.strictEqual(dev.base, '0.9.6a');

		var stable = parseIdentity(serialiseIdentity(meta()));
		assert.strictEqual(stable.delta, false);
		assert.strictEqual(stable.base, null);
	});

	it('writes a line for a field with no value', function () {
		// A reader must be able to tell "no base" from "this file predates the
		// Base field". An empty value says the first; a missing line does not.
		var text = serialiseIdentity(meta());
		assert.ok(/^Base\s*$/m.test(text), text);
	});

	it('round trips', function () {
		var m = meta();
		var id = parseIdentity(serialiseIdentity(m));
		assert.strictEqual(id.version, m.version);
		assert.strictEqual(id.released, m.released);
	});

	it('keeps a keyword it does not recognise rather than refusing', function () {
		// This is the file another system reads to work out what an archive is.
		// Refusing on an unknown keyword would make every future field a
		// breaking change for every reader.
		var id = parseIdentity('Version     0.9.6a\nSomethingNew  a value\n');
		assert.strictEqual(id.version, '0.9.6a');
		assert.strictEqual(id.raw.somethingnew, 'a value');
	});

	it('tolerates comments, blank lines and any line ending', function () {
		var id = parseIdentity('# a comment\r\n\r\nVersion 0.9.6a\r\nChannel stable\r\n');
		assert.strictEqual(id.version, '0.9.6a');
		assert.strictEqual(id.channel, 'stable');
	});

	it('has no answer for something that is not one', function () {
		assert.strictEqual(parseIdentity(''), null);
		assert.strictEqual(parseIdentity('hello'), null);
		assert.strictEqual(parseIdentity(null), null);
	});
});

describe('FILE_ID.DIZ', function () {

	function linesOf(diz) {
		return diz.split('\n').filter(function (l, i, a) { return i < a.length - 1; });
	}

	it('never exceeds the line count, however much there is to say', function () {
		// Overrunning does not error anywhere. It renders as a broken
		// description on somebody else's board, which is where it will be read.
		var many = [];
		for (var i = 0; i < 12; i++) many.push({ level: 'warning', text: 'Warning number ' + i + '.' });
		var lines = linesOf(buildFileIdDiz(meta({ notices: many })));
		assert.ok(lines.length <= DIZ_LINES, 'produced ' + lines.length + ' lines:\n' + lines.join('\n'));
	});

	it('never exceeds the line width, whatever it was given', function () {
		// The header is the case: a long codename or a dated development
		// version pushes the first line out on its own, with no notice text
		// involved and nothing else trimming it.
		var lines = linesOf(buildFileIdDiz(meta({
			version: '0.9.6a.20260913.2',
			codename: 'A Codename Considerably Longer Than Anybody Should Choose'
		})));
		for (var line of lines) {
			assert.ok(line.length <= DIZ_WIDTH, 'too wide (' + line.length + '): ' + line);
		}
	});

	it('keeps every line inside the canvas on a realistic release', function () {
		var lines = linesOf(buildFileIdDiz(meta({
			notices: [
				{ level: 'warning', text: 'A notice whose text runs on for a very long time indeed and would certainly overrun the line if nothing trimmed it. With a second sentence.' },
				{ level: 'warning', text: 'Another long one, equally unsuitable for a fixed width description field.' },
				{ level: 'info', text: 'And one that should not appear at all.' }
			]
		})));
		assert.ok(lines.length <= DIZ_LINES, lines.join('\n'));
		for (var line of lines) {
			assert.ok(line.length <= DIZ_WIDTH, 'too wide (' + line.length + '): ' + line);
		}
	});

	it('leads with the name and version, which is what a lister shows first', function () {
		var diz = buildFileIdDiz(meta());
		assert.ok(diz.split('\n')[0].indexOf('Canectic BBS 0.9.6a') === 0, diz);
	});

	it('warns a browser off a development build before they download it', function () {
		var diz = buildFileIdDiz(meta({ version: '0.9.6a.20260913', delta: true, base: '0.9.6a' }));
		assert.ok(/Development build/.test(diz), diz);
		assert.ok(/0\.9\.6a/.test(diz), 'and names what it needs: ' + diz);
		assert.ok(/not installable alone/.test(diz), diz);
	});

	it('describes the software and carries no upgrade notices', function () {
		// A DIZ is what a BBS listing shows. Upgrade notices belong in the
		// release notes and the metadata, whatever their level.
		var diz = buildFileIdDiz(meta({
			notices: [
				{ level: 'critical', text: 'Something critical. More detail here.' },
				{ level: 'warning', text: 'allow_netmail_relay is deprecated. More detail here.' },
				{ level: 'info', text: 'Something mildly interesting.' }
			]
		}));
		assert.strictEqual(diz, buildFileIdDiz(meta()), diz);
		assert.ok(!/Upgrading|critical|allow_netmail_relay|interesting/.test(diz), diz);
	});

	it('does not end in blank lines, which read as a broken description', function () {
		var diz = buildFileIdDiz(meta());
		assert.ok(!/\n\n$/.test(diz), JSON.stringify(diz.slice(-5)));
	});
});
