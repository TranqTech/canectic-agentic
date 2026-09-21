// tests/installPath.test.js: the installer must work with no node_modules.
//
// This is a hard constraint, not a preference. A fresh machine running the
// bootstrap has an extracted release and nothing else: `npm install` is
// something the installer RUNS, so it cannot be something the installer needs.
// Every module it imports, transitively, has to resolve against Node builtins
// and the release's own files.
//
// It was not obeyed when first written, and the failure is not subtle: the
// installer imported updateApply, which imported alogger, which imports luxon,
// and the whole thing died on the first line of a fresh install with a module
// resolution error. That is the worst possible moment for it, because the
// sysop has nothing to go back to and no reason to trust the next attempt.
//
// So the rule is checked rather than remembered. It is exactly the kind of
// constraint that holds until somebody adds one convenient import.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every entry point that runs before dependencies exist.
var INSTALL_ENTRIES = [
	'src/tools/install.js'
];

var IMPORT = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
var DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
	var text = fs.readFileSync(file, 'utf8');
	var found = [];
	var m;
	IMPORT.lastIndex = 0;
	while ((m = IMPORT.exec(text)) !== null) found.push(m[1]);
	DYNAMIC.lastIndex = 0;
	while ((m = DYNAMIC.exec(text)) !== null) found.push(m[1]);
	return found;
}

function isBuiltin(spec) {
	if (spec.indexOf('node:') === 0) return true;
	// The builtins this codebase actually uses, spelled out. A list is better
	// than module.isBuiltin here because the point is to be explicit about what
	// the install path is allowed to lean on.
	return ['fs', 'fs/promises', 'path', 'os', 'crypto', 'child_process', 'url',
		'readline', 'readline/promises', 'util', 'events', 'stream', 'assert',
		'zlib', 'net', 'tls', 'http', 'https', 'buffer', 'string_decoder',
		'timers', 'timers/promises', 'worker_threads', 'process'].indexOf(spec) !== -1;
}

/** Walk the graph, collecting every non-relative, non-builtin import. */
function externalImports(entry) {
	var seen = new Set();
	var offenders = [];
	var queue = [path.join(REPO, entry)];

	while (queue.length) {
		var file = queue.shift();
		if (seen.has(file)) continue;
		seen.add(file);
		if (!fs.existsSync(file)) continue;

		for (var spec of importsOf(file)) {
			if (spec.indexOf('.') === 0) {
				queue.push(path.resolve(path.dirname(file), spec));
				continue;
			}
			if (isBuiltin(spec)) continue;
			offenders.push({ file: path.relative(REPO, file), imports: spec });
		}
	}
	return { offenders: offenders, visited: seen };
}

describe('the install path', function () {

	for (var entry of INSTALL_ENTRIES) {
		it(entry + ' imports nothing that needs node_modules', function () {
			var result = externalImports(entry);
			assert.deepStrictEqual(result.offenders, [],
				'these would fail on a fresh machine, where npm install is something the ' +
				'installer RUNS rather than something it can rely on:\n  ' +
				result.offenders.map(function (o) { return o.file + ' imports ' + o.imports; }).join('\n  '));
		});

		it(entry + ' actually reaches the modules that do the work', function () {
			// A guard that passed because the walk found nothing would be
			// worthless, so check it really did traverse.
			var visited = Array.from(externalImports(entry).visited)
				.map(function (f) { return path.relative(REPO, f); });
			for (var required of [
				'src/maintenance/installer.js',
				'src/maintenance/updateApply.js',
				'src/release/applyPlan.js',
				'src/release/manifest.js'
			]) {
				assert.ok(visited.indexOf(required) !== -1,
					'the walk never reached ' + required + ', so it proves nothing');
			}
		});
	}

	// Maintenance mode is the tool for when the gateway will not start or the
	// database is what is being repaired, and the updater sets it around the
	// stop. None of it may need node_modules, for the same reason as above.
	//
	// The updater's progress page listener runs while the dependencies phase
	// replaces node_modules underneath it (#53), so it and everything it
	// renders with are held to the same rule.
	for (var builtinsOnly of [
		'src/maintenance/maintenanceFlag.js',
		'src/maintenance/maintenanceWatch.js',
		'src/tools/maintenanceMode.js',
		'src/maintenance/updateStatusServer.js',
		'src/maintenance/updateProgress.js',
		'src/maintenance/sysopSessions.js'
	]) {
		(function (entry) {
			it(entry + ' imports nothing that needs node_modules', function () {
				var result = externalImports(entry);
				assert.deepStrictEqual(result.offenders, [],
					'maintenance mode must work with the database or node_modules broken:\n  ' +
					result.offenders.map(function (o) { return o.file + ' imports ' + o.imports; }).join('\n  '));
			});
		})(builtinsOnly);
	}

	it('the updater is deliberately NOT held to this', function () {
		// The updater runs on an installation that already has dependencies, so
		// it may use appConfig and alogger. Asserting the difference keeps
		// somebody from "fixing" the install path by stripping the updater too.
		var result = externalImports('src/tools/update.js');
		assert.ok(result.offenders.length > 0,
			'if this ever became dependency-free, the split below is worth revisiting');
	});
});
