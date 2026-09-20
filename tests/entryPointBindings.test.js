// tests/entryPointBindings.test.js — the process entry points reference only
// names they actually declare.
//
// Nothing in this suite imports bin/*.js. They call main() on load, start
// servers and open sockets, so a test cannot simply require them, and that
// leaves the one file per process that is never exercised until it runs.
//
// The gap is not theoretical. A change to bin/worker.js added a call to
// `outboundSweep.runOutboundSweep()` and not the import for it. Every test
// passed, because the module the call lived in was the one module no test
// loads. In production the periodic sweep would have thrown ReferenceError on
// every run, retried three times and gone to the failed set, so outbound mail
// and file echoes would have stopped with the queue looking busy.
//
// This is the cheap half of a linter: collect every binding the file declares
// anywhere, collect every identifier it references, and report references that
// match neither a binding nor a known global. Scope is deliberately ignored,
// so a name declared in the wrong place is NOT reported — that keeps the check
// free of false positives, and the case worth catching is a name declared
// nowhere at all.
//
// Pure: parses source, executes nothing.
// Run: npx mocha --no-config --no-package tests/entryPointBindings.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// acorn is a declared devDependency. It is deliberately NOT optional: this
// file is the only thing that reads the process entry points at all, so a
// silent skip would put them back where they were, unchecked, while the suite
// still reported green. pug pulls in its own acorn 7 as well; that one stays
// nested under is-expression and this import gets the declared 8.x.
var acorn = (await import('acorn')).default || (await import('acorn'));

// Every .js file under bin/ and src/.
//
// This began as a list of process entry points, on the reasoning that those
// were the files no test imports. That reasoning was too narrow and a live
// board paid for it: src/maintenance/updateRunner.js called spawnSync without
// importing it, and the update reached a customer's database before anyone
// found out — the schema phase died with "spawnSync is not defined" after the
// files had been replaced and npm install had run, which is past the point
// where rolling back is safe.
//
// The file was untested for the same reason bin/ is: it runs detached, during
// an update, with the board stopped. But the lesson is that "which files does
// a test import" is not a property anyone can track by hand, so the check
// covers everything instead of guessing.
function jsFilesUnder(dir, out) {
	out = out || [];
	for (var entry of fs.readdirSync(dir, { withFileTypes: true })) {
		var full = path.join(dir, entry.name);
		if (entry.isDirectory()) jsFilesUnder(full, out);
		else if (entry.name.endsWith('.js')) out.push(full);
	}
	return out;
}

// Excluded, with reasons. Nothing here is excluded for being inconvenient.
//
//   Old/, old-*        superseded copies kept for reference, not loaded
//   external/synchronet, shims/  Synchronet door scripts and the shim that
//                      provides their globals (print, log, argv, file_*).
//                      Those names are injected by the SyncJS runtime, so
//                      "undeclared" is correct and expected here
//   filehelpers/dropfiles.js  Synchronet-flavoured syntax acorn cannot parse
function excluded(rel) {
	return /(^|\/)Old\//.test(rel)
		|| /(^|\/)old-/.test(rel)
		|| rel.indexOf('src/external/synchronet/') === 0
		|| rel.indexOf('src/shims/') === 0
		|| rel === 'src/filehelpers/dropfiles.js';
}

var ENTRY_POINTS = jsFilesUnder(path.join(ROOT, 'bin'))
	.concat(jsFilesUnder(path.join(ROOT, 'src')))
	.map(function (f) { return path.relative(ROOT, f); })
	.filter(function (rel) { return !excluded(rel); })
	.sort();

var GLOBALS = new Set([
	// Language
	'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'Function',
	'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
	'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
	'EvalError', 'URIError', 'AggregateError', 'Promise', 'Map', 'Set', 'WeakMap',
	'WeakSet', 'WeakRef', 'Proxy', 'Reflect', 'ArrayBuffer', 'SharedArrayBuffer',
	'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
	'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
	'BigInt64Array', 'BigUint64Array', 'Atomics', 'Intl', 'escape', 'unescape',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
	'encodeURI', 'encodeURIComponent', 'eval', 'arguments',
	// Node
	'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder',
	'TextDecoder', 'AbortController', 'AbortSignal', 'Event', 'EventTarget',
	'MessageChannel', 'MessagePort', 'BroadcastChannel', 'structuredClone',
	'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
	'setImmediate', 'clearImmediate', 'fetch', 'Headers', 'Request', 'Response',
	'Blob', 'File', 'FormData', 'performance', 'crypto', 'require', 'module',
	'exports', '__dirname', '__filename',
]);

// Walk every node in the tree, calling visit(node, parent).
function walk(node, parent, visit) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (var item of node) walk(item, parent, visit);
		return;
	}
	if (typeof node.type !== 'string') return;

	visit(node, parent);

	for (var key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === 'sourceFile') continue;
		walk(node[key], node, visit);
	}
}

// Every name introduced by a binding pattern (identifier, array, object, rest,
// default). Destructuring in a parameter list is still a declaration.
function collectPattern(node, into) {
	if (!node || typeof node !== 'object') return;
	switch (node.type) {
		case 'Identifier':
			into.add(node.name);
			break;
		case 'ObjectPattern':
			for (var prop of node.properties) {
				if (prop.type === 'RestElement') collectPattern(prop.argument, into);
				else collectPattern(prop.value, into);
			}
			break;
		case 'ArrayPattern':
			for (var el of node.elements) collectPattern(el, into);
			break;
		case 'AssignmentPattern':
			collectPattern(node.left, into);
			break;
		case 'RestElement':
			collectPattern(node.argument, into);
			break;
	}
}

function analyse(source) {
	// allowHashBang is for the bin/ shebangs. Note that 'latest' needs acorn 8:
	// on 7.x a string ecmaVersion makes the internal version comparisons NaN and
	// the parser spins rather than failing, which is why the version floor in
	// package.json matters more than it looks.
	var ast = acorn.parse(source, {
		ecmaVersion: 'latest',
		sourceType: 'module',
		allowHashBang: true,
		allowAwaitOutsideFunction: true,
		locations: true,
	});

	var declared = new Set();
	var referenced = new Map(); // name -> first line

	walk(ast, null, function (node, parent) {
		switch (node.type) {
			case 'ImportDefaultSpecifier':
			case 'ImportNamespaceSpecifier':
			case 'ImportSpecifier':
				declared.add(node.local.name);
				return;
			case 'VariableDeclarator':
				collectPattern(node.id, declared);
				return;
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
				if (node.id) declared.add(node.id.name);
				for (var param of node.params) collectPattern(param, declared);
				return;
			case 'ClassDeclaration':
			case 'ClassExpression':
				if (node.id) declared.add(node.id.name);
				return;
			case 'CatchClause':
				if (node.param) collectPattern(node.param, declared);
				return;
			case 'LabeledStatement':
				declared.add(node.label.name);
				return;
		}

		if (node.type !== 'Identifier') return;
		if (!parent) return;

		// Not a reference: property access, object literal key, member of a
		// class body, or the label of a break/continue.
		if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
		if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
		if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return;
		if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return;
		if (parent.type === 'ExportSpecifier') return;
		if (parent.type === 'ImportSpecifier' && parent.imported === node) return;
		if ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement')) return;
		if (parent.type === 'MetaProperty') return;

		if (!referenced.has(node.name)) {
			referenced.set(node.name, node.loc ? node.loc.start.line : 0);
		}
	});

	var undeclared = [];
	for (var [name, line] of referenced) {
		if (declared.has(name) || GLOBALS.has(name)) continue;
		undeclared.push(name + ' (line ' + line + ')');
	}
	return undeclared.sort();
}

describe('process entry point bindings', function () {

	it('covers every file under bin/ and src/, so the list cannot go stale', function () {
		assert.ok(ENTRY_POINTS.length > 200,
			'expected the whole tree, found ' + ENTRY_POINTS.length + ' files');
	});

	it('finds no name that is declared nowhere in its file', function () {
		var broken = [];
		for (var rel of ENTRY_POINTS) {
			var undeclared;
			try {
				undeclared = analyse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
			} catch (e) {
				broken.push(rel + ': could not parse (' + e.message + ')');
				continue;
			}
			if (undeclared.length) broken.push(rel + ': ' + undeclared.join(', '));
		}

		assert.deepStrictEqual(broken, [],
			'these use names declared nowhere in the file. A missing import throws ' +
			'ReferenceError only when that code path first runs, which for an update ' +
			'phase means on somebody else\'s board:\n  ' + broken.join('\n  '));
	});

	it('detects a missing import, so this file cannot pass vacuously', function () {
		// The exact shape of the bug: a namespace used without its import.
		var bad = 'import * as a from "a.js";\nasync function f(){ await b.doThing(); }\n';
		assert.deepStrictEqual(analyse(bad), ['b (line 2)']);

		var good = 'import * as a from "a.js";\nimport * as b from "b.js";\nasync function f(){ await b.doThing(); }\n';
		assert.deepStrictEqual(analyse(good), []);
	});
});
