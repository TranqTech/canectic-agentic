// tests/rootHooks.test.js: the suite exits on its own, and a leak fails it.
//
// The suite ran with `exit: true` for a long time, which killed the process as
// soon as the tests reported and so hid every handle a test left open (#45,
// #46). tests/helpers/rootHooks.js now closes the database singletons after
// the run and fails it, naming the culprit, when anything else keeps the
// process alive. Each case runs mocha in a child on a fixture, with the hook
// and without the config, so the outcome is the child's own exit.

import assert from 'assert';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var MOCHA = path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');

function runFixture(name) {
	var r = spawnSync(process.execPath, [MOCHA, '--no-config', '--require', 'tests/helpers/rootHooks.js',
		path.join('tests', 'fixtures', 'rootHooks', name)], { cwd: ROOT, encoding: 'utf8', timeout: 25000 });
	return { status: r.status, signal: r.signal, output: String(r.stdout || '') + String(r.stderr || '') };
}

describe('the root hooks', function () {
	this.timeout(30000);

	it('fail a run whose tests all passed but left a timer running, and name it', function () {
		var r = runFixture('leaks.fixture.js');
		assert.ok(/1 passing/.test(r.output), r.output);
		assert.strictEqual(r.status, 1, 'exit ' + r.status + ' signal ' + r.signal + '\n' + r.output);
		assert.ok(/still held open by/.test(r.output), r.output);
		assert.ok(/leakedByThisFixture/.test(r.output), 'the timer must be named: ' + r.output);
	});

	it('let a clean run exit on its own, successfully', function () {
		var r = runFixture('clean.fixture.js');
		assert.strictEqual(r.status, 0, 'exit ' + r.status + ' signal ' + r.signal + '\n' + r.output);
		assert.ok(!/still held open/.test(r.output), r.output);
	});

	it('are what the suite runs with, and the suite no longer force-exits', async function () {
		var fs = await import('fs');
		var rc = fs.readFileSync(path.join(ROOT, '.mocharc.yml'), 'utf8');
		assert.ok(/^require:.*tests\/helpers\/rootHooks\.js/m.test(rc), rc);
		assert.ok(!/^exit:\s*true/m.test(rc), 'exit: true hides leaked handles again:\n' + rc);
	});
});
