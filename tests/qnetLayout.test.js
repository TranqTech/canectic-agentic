// tests/qnetLayout.test.js: one packet directory per QWK role (#68).
//
// Every QWK connection worked in qnet/<ID>/, so a system that was both our hub
// and our node shared one directory and one in/extracted/, and a leftover from
// one role could be imported by the other into the wrong network's areas. Now
// qnet/<ID>.hub and qnet/<ID>.node; migration 0008 moves what an upgraded
// board already holds without losing a packet in flight, and leaves qnet/<ID>
// linked to the node directory so a qnet-directory.js node keeps working.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { qnetDir, qnetInDir, qnetOutDir, qnetDirName, isRoleDirName } from '../src/utils/qnetPaths.js';
import { roleForLegacyFile, extractedKind, findLegacyDirs, migrateQnetLayout } from '../src/maintenance/qnetLayout.js';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('qnetPaths', function () {
	it('names the directory by QWK ID and the role the other system plays', function () {
		assert.strictEqual(qnetDirName({ remote_qwk_id: 'vert', transport: 'ftp' }), 'VERT.hub');
		assert.strictEqual(qnetDirName({ remote_qwk_id: 'UNDRMINE', transport: 'hub' }), 'UNDRMINE.node');
		assert.strictEqual(qnetDir({ remote_qwk_id: 'X.Y', transport: 'http' }, '/bbs'), '/bbs/qnet/X.Y.hub');
		assert.strictEqual(qnetInDir({ remote_qwk_id: 'N', transport: 'hub' }, '/bbs'), '/bbs/qnet/N.node/in');
		assert.strictEqual(qnetOutDir({ remote_qwk_id: 'H', transport: 'ftp' }, '/bbs'), '/bbs/qnet/H.hub/out');
	});

	it('refuses a connection with no QWK ID rather than using qnet/.hub', function () {
		assert.throws(function () { qnetDirName({ transport: 'ftp' }); }, /no remote QWK ID/);
	});

	it('knows a per-role name from a legacy one, even when the ID has a dot', function () {
		assert.strictEqual(isRoleDirName('VERT.hub'), true);
		assert.strictEqual(isRoleDirName('X.Y.node'), true);
		assert.strictEqual(isRoleDirName('VERT'), false);
		assert.strictEqual(isRoleDirName('X.Y'), false);
	});

	it('is the only place qnet paths are built', function () {
		var files = ['src/middleware/tossers/qwkTosser.js', 'src/models/qwkPacketBuilder.js', 'src/routes/api/qnet.js'];
		for (var f of files) {
			assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /'qnet'/, f);
		}
	});
});

describe('which role a legacy file belongs to', function () {
	it('gives REPs from a node, and packets we built for it, to the node role', function () {
		for (var rel of ['in/UNDREDUX.rep', 'in/NODE-1726-ab12.rep', 'in/.NODE-1.rep.part', 'out/UNDREDUX.qwk', 'out/UNDREDUX.qwk.json', 'qnet.log']) {
			assert.deepStrictEqual(roleForLegacyFile(rel, null), { role: 'node', known: true }, rel);
		}
	});

	it('gives packets from a hub, and REPs we built for it, to the hub role', function () {
		for (var rel of ['in/VERT.qwk', 'in/bak/VERT.qwk', 'out/VERT.rep']) {
			assert.deepStrictEqual(roleForLegacyFile(rel, null), { role: 'hub', known: true }, rel);
		}
	});

	it('decides in/extracted by what it holds', function () {
		assert.strictEqual(extractedKind(['MESSAGES.DAT', 'CONTROL.DAT']), 'qwk');
		assert.strictEqual(extractedKind(['undredux.msg', 'HEADERS.DAT']), 'rep');
		assert.strictEqual(extractedKind([]), null);
		assert.deepStrictEqual(roleForLegacyFile('in/extracted/MESSAGES.DAT', 'qwk'), { role: 'hub', known: true });
		assert.deepStrictEqual(roleForLegacyFile('in/extracted/X.MSG', 'rep'), { role: 'node', known: true });
	});

	it('gives anything unrecognised to the node role and says so', function () {
		assert.deepStrictEqual(roleForLegacyFile('notes.txt', null), { role: 'node', known: false });
	});
});

describe('migrating an existing qnet/ (0008)', function () {
	var root;
	function put(rel, body) {
		var p = path.join(root, 'qnet', rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, body || rel);
	}
	function read(rel) { return fs.readFileSync(path.join(root, 'qnet', rel), 'utf8'); }
	function exists(rel) { return fs.existsSync(path.join(root, 'qnet', rel)); }
	var CONNS = [
		{ connection_data: { remote_qwk_id: 'VERT', transport: 'ftp' } },
		{ connection_data: { remote_qwk_id: 'UNDRMINE', transport: 'ftp' } },
		{ connection_data: { remote_qwk_id: 'UNDRMINE', transport: 'hub' } },
		{ connection_data: { remote_qwk_id: 'LEAF', transport: 'hub' } }
	];

	beforeEach(function () { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qnet-layout-')); });
	afterEach(function () { fs.rmSync(root, { recursive: true, force: true }); });

	it('moves an ID with one role whole, and links a node\'s old path to its new one', function () {
		put('VERT/in/bak/VERT.qwk');
		put('LEAF/in/HUBID.rep');
		put('LEAF/out/HUBID.qwk');
		put('LEAF/out/HUBID.qwk.json', '{"packetId":"p1"}');
		var r = migrateQnetLayout(root, CONNS);
		assert.deepStrictEqual(r.moved.sort(), ['LEAF', 'VERT']);
		assert.strictEqual(read('VERT.hub/in/bak/VERT.qwk'), 'VERT/in/bak/VERT.qwk');
		assert.strictEqual(exists('VERT'), false, 'a hub-only ID leaves no link');
		assert.strictEqual(read('LEAF.node/out/HUBID.qwk.json'), '{"packetId":"p1"}', 'the sidecar travels with its packet');
		assert.strictEqual(fs.lstatSync(path.join(root, 'qnet', 'LEAF')).isSymbolicLink(), true);
		// qnet-directory.js, still configured with the old path, lands in the new one.
		fs.writeFileSync(path.join(root, 'qnet', 'LEAF', 'in', 'NEXT.rep'), 'x');
		assert.strictEqual(exists('LEAF.node/in/NEXT.rep'), true);
	});

	it('splits an ID that is both our hub and our node by what each file is', function () {
		put('UNDRMINE/in/UNDREDUX.rep');                 // a REP the node sent us
		put('UNDRMINE/in/UNDRMINE.qwk');                 // a packet the hub sent us
		put('UNDRMINE/in/extracted/UNDREDUX.MSG');       // a REP half imported
		put('UNDRMINE/out/UNDREDUX.qwk');                // a packet waiting for the node
		put('UNDRMINE/out/UNDREDUX.qwk.json');
		put('UNDRMINE/out/UNDRMINE.rep');                // a REP waiting for the hub
		put('UNDRMINE/qnet.log');
		put('UNDRMINE/mystery.txt');
		var r = migrateQnetLayout(root, CONNS);
		for (var n of ['in/UNDREDUX.rep', 'in/extracted/UNDREDUX.MSG', 'out/UNDREDUX.qwk', 'out/UNDREDUX.qwk.json', 'qnet.log', 'mystery.txt']) {
			assert.strictEqual(exists('UNDRMINE.node/' + n), true, n);
		}
		for (var h of ['in/UNDRMINE.qwk', 'out/UNDRMINE.rep']) assert.strictEqual(exists('UNDRMINE.hub/' + h), true, h);
		assert.deepStrictEqual(r.unknown, ['UNDRMINE/mystery.txt']);
		assert.strictEqual(fs.readlinkSync(path.join(root, 'qnet', 'UNDRMINE')), 'UNDRMINE.node');
	});

	it('sends a half-imported hub packet to the hub role', function () {
		put('UNDRMINE/in/extracted/MESSAGES.DAT');
		put('UNDRMINE/in/extracted/CONTROL.DAT');
		migrateQnetLayout(root, CONNS);
		assert.strictEqual(exists('UNDRMINE.hub/in/extracted/MESSAGES.DAT'), true);
		assert.strictEqual(exists('UNDRMINE.hub/in/extracted/CONTROL.DAT'), true);
	});

	it('leaves a directory no connection uses alone', function () {
		put('GONE/in/GONE.qwk');
		var r = migrateQnetLayout(root, CONNS);
		assert.deepStrictEqual(r.skipped, ['GONE']);
		assert.strictEqual(exists('GONE/in/GONE.qwk'), true);
	});

	it('never overwrites or throws when a file is already in the new place; keeps and reports it', function () {
		put('VERT/in/VERT.qwk', 'old');
		put('VERT.hub/in/VERT.qwk', 'new');
		var r = migrateQnetLayout(root, CONNS);
		assert.deepStrictEqual(r.kept, ['VERT/in/VERT.qwk']);
		assert.strictEqual(read('VERT.hub/in/VERT.qwk'), 'new');
		assert.strictEqual(read('VERT/in/VERT.qwk'), 'old');
	});

	it('finds nothing to do the second time, the link included', function () {
		put('LEAF/in/X.rep');
		migrateQnetLayout(root, CONNS);
		assert.deepStrictEqual(findLegacyDirs(root, CONNS), []);
		var again = migrateQnetLayout(root, CONNS);
		assert.deepStrictEqual(again.moved, []);
	});
});
