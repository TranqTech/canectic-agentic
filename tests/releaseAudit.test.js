// tests/releaseAudit.test.js — whether a dependency advisory stops a cut.
//
// The rule is narrow on purpose (see src/release/auditCheck.js), and every
// clause of it is a decision that can be got wrong in a way nobody notices:
//
//   - drop "production" and a cut is held up by mocha's dependency tree
//   - drop "high or critical" and it is held up for ever by a low-severity
//     advisory in something transitive
//   - drop "fix available" and an unfixable advisory makes the override flag
//     mandatory on every cut, which is how a gate stops being read
//   - treat an unreadable report as a clean one and the cut prints a tick for
//     an audit that never ran, which is worse than having no check at all
//
// That last one is the reason this file exists rather than a single assertion:
// npm audit needs the registry, and the failure mode of a network check is
// silence that looks like success.
//
// Pure: fixtures in, verdict out. No npm, no network.
// Run: npx mocha --no-config --no-package tests/releaseAudit.test.js

import assert from 'assert';
import { summariseAudit, formatAdvisory, BLOCKING_SEVERITIES } from '../src/release/auditCheck.js';

// Shaped like npm 7+ `npm audit --json` (auditReportVersion 2).
function report(vulns, counts) {
	return {
		auditReportVersion: 2,
		vulnerabilities: vulns || {},
		metadata: { vulnerabilities: counts || {} },
	};
}

function vuln(opts) {
	return {
		name: opts.name,
		severity: opts.severity,
		isDirect: opts.direct !== false,
		range: opts.range || '<=1.0.0',
		via: opts.via || [{ title: opts.title || 'something bad', severity: opts.severity }],
		effects: [],
		nodes: ['node_modules/' + opts.name],
		fixAvailable: opts.fixAvailable === undefined ? true : opts.fixAvailable,
	};
}

// ---------------------------------------------------------------------------
// The blocking rule
// ---------------------------------------------------------------------------

describe('release audit — what blocks a cut', function () {

	it('blocks a fixable high-severity advisory', function () {
		// The real case: adm-zip 0.6.0, high, production, fix in 0.6.1.
		var v = summariseAudit(report({
			'adm-zip': vuln({ name: 'adm-zip', severity: 'high', title: 'extraction follows symlinks' }),
		}));

		assert.strictEqual(v.usable, true);
		assert.strictEqual(v.blocking.length, 1);
		assert.strictEqual(v.blocking[0].name, 'adm-zip');
	});

	it('blocks critical as well as high', function () {
		var v = summariseAudit(report({
			'thing': vuln({ name: 'thing', severity: 'critical' }),
		}));
		assert.strictEqual(v.blocking.length, 1);
		assert.deepStrictEqual(BLOCKING_SEVERITIES.slice().sort(), ['critical', 'high']);
	});

	it('does not block moderate, low or info', function () {
		// A release stopped by a low-severity transitive advisory is a release
		// that never goes out.
		var v = summariseAudit(report({
			'a': vuln({ name: 'a', severity: 'moderate' }),
			'b': vuln({ name: 'b', severity: 'low' }),
			'c': vuln({ name: 'c', severity: 'info' }),
		}));
		assert.strictEqual(v.blocking.length, 0);
		assert.strictEqual(v.reported.length, 3, 'but they are still reported');
	});

	it('does not block a high-severity advisory with no published fix', function () {
		// A gate that cannot be satisfied is a gate that gets bypassed every
		// time until nobody reads it. Report it loudly, let the cut proceed.
		var v = summariseAudit(report({
			'stuck': vuln({ name: 'stuck', severity: 'critical', fixAvailable: false }),
		}));
		assert.strictEqual(v.blocking.length, 0);
		assert.strictEqual(v.reported.length, 1);
		assert.strictEqual(v.reported[0].fixAvailable, false);
	});

	it('blocks when the only fix is a breaking change, but says so', function () {
		// npm reports this as an object rather than true. It is still a fix,
		// and the maintainer needs to know it is not one command.
		var v = summariseAudit(report({
			'major': Object.assign(vuln({ name: 'major', severity: 'high' }), {
				fixAvailable: { name: 'major', version: '3.0.0', isSemVerMajor: true },
			}),
		}));
		assert.strictEqual(v.blocking.length, 1);
		assert.strictEqual(v.blocking[0].fixIsBreaking, true);
		assert.strictEqual(v.blocking[0].fixVersion, '3.0.0');
		assert.ok(/breaking change to 3\.0\.0/.test(formatAdvisory(v.blocking[0])));
	});

	it('passes a clean report', function () {
		var v = summariseAudit(report({}, { total: 0 }));
		assert.strictEqual(v.usable, true);
		assert.deepStrictEqual(v.blocking, []);
		assert.deepStrictEqual(v.reported, []);
	});

	it('reports everything it saw, blocking or not', function () {
		var v = summariseAudit(report({
			'high-fixable': vuln({ name: 'high-fixable', severity: 'high' }),
			'low-thing': vuln({ name: 'low-thing', severity: 'low' }),
		}));
		assert.strictEqual(v.blocking.length, 1);
		assert.deepStrictEqual(v.reported.map(function (r) { return r.name; }),
			['high-fixable', 'low-thing'], 'sorted, and nothing dropped');
	});
});

// ---------------------------------------------------------------------------
// A report we cannot read
// ---------------------------------------------------------------------------

describe('release audit — an audit that did not run', function () {

	// npm audit needs the registry. Treating any of these as "clean" would
	// print a tick for a check that never happened, which is the one outcome
	// worse than not having the check.
	var cases = [
		['null', null],
		['a string', 'not json at all'],
		['an empty object', {}],
		['an npm error payload', { error: { code: 'ENETUNREACH', summary: 'network unreachable' } }],
		['an unknown report version', { auditReportVersion: 99, vulnerabilities: {} }],
		['no vulnerabilities section', { auditReportVersion: 2 }],
	];

	cases.forEach(function (pair) {
		it('refuses to call ' + pair[0] + ' a clean audit', function () {
			var v = summariseAudit(pair[1]);
			assert.strictEqual(v.usable, false, pair[0] + ' must not read as usable');
			assert.ok(v.reason && v.reason.length > 0, 'and must say why');
			assert.deepStrictEqual(v.blocking, []);
		});
	});

	it('carries the explanation npm gives, when it gives one', function () {
		var v = summariseAudit({ error: { code: 'ENETUNREACH', summary: 'network unreachable' } });
		assert.strictEqual(v.reason, 'network unreachable');
	});
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

describe('release audit — advisory formatting', function () {

	it('names the package, the severity and the advisory', function () {
		var v = summariseAudit(report({
			'adm-zip': vuln({ name: 'adm-zip', severity: 'high', title: 'extraction follows symlinks' }),
		}));
		var line = formatAdvisory(v.reported[0]);
		assert.ok(line.includes('adm-zip'));
		assert.ok(line.includes('high'));
		assert.ok(line.includes('extraction follows symlinks'));
	});

	it('marks an advisory with no fix, so it is not mistaken for one to act on', function () {
		var v = summariseAudit(report({
			'stuck': vuln({ name: 'stuck', severity: 'high', fixAvailable: false }),
		}));
		assert.ok(/no fix published/.test(formatAdvisory(v.reported[0])));
	});

	it('survives a via list of plain package names', function () {
		// npm uses strings when a package is only affected through another.
		var v = summariseAudit(report({
			'downstream': Object.assign(vuln({ name: 'downstream', severity: 'high' }), { via: ['upstream'] }),
		}));
		assert.deepStrictEqual(v.reported[0].titles, []);
		assert.ok(formatAdvisory(v.reported[0]).includes('downstream'));
	});
});
