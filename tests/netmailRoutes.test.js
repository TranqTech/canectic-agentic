// tests/netmailRoutes.test.js -- Unit tests for netmail route matching
//
// Tests pure matching logic (_patternMatch, _ruleMatches, matchRoute with
// injected rules). No DB access.

import assert from 'assert';
import {
	_globToRegex,
	_patternMatch,
	_ruleMatches,
	matchRoute,
	VALID_ACTIONS,
	VALID_MATCH_TYPES,
} from '../src/models/netmailRoutes.js';

describe('netmailRoutes._patternMatch', function () {

	describe('exact type', function () {
		it('matches equal strings (case-insensitive)', function () {
			assert.strictEqual(_patternMatch('exact', 'areafix', 'AreaFix'), true);
			assert.strictEqual(_patternMatch('exact', 'AREAFIX', 'areafix'), true);
		});

		it('does not match different strings', function () {
			assert.strictEqual(_patternMatch('exact', 'areafix', 'filefix'), false);
		});

		it('does not match substring', function () {
			assert.strictEqual(_patternMatch('exact', 'area', 'areafix'), false);
		});

		it('empty pattern matches any value (optional filter semantics)', function () {
			assert.strictEqual(_patternMatch('exact', '', 'anything'), true);
			assert.strictEqual(_patternMatch('exact', null, 'anything'), true);
			assert.strictEqual(_patternMatch('exact', undefined, 'anything'), true);
		});

		it('handles empty value', function () {
			assert.strictEqual(_patternMatch('exact', 'areafix', ''), false);
			assert.strictEqual(_patternMatch('exact', 'areafix', null), false);
		});
	});

	describe('glob type', function () {
		it('* matches any characters', function () {
			assert.strictEqual(_patternMatch('glob', 'area*', 'areafix'), true);
			assert.strictEqual(_patternMatch('glob', 'area*', 'areamgr'), true);
			assert.strictEqual(_patternMatch('glob', '*fix', 'areafix'), true);
			assert.strictEqual(_patternMatch('glob', '*fix', 'filefix'), true);
		});

		it('* does not match when literal prefix/suffix differs', function () {
			assert.strictEqual(_patternMatch('glob', 'area*', 'filefix'), false);
			assert.strictEqual(_patternMatch('glob', '*fix', 'areamgr'), false);
		});

		it('? matches one character', function () {
			assert.strictEqual(_patternMatch('glob', 'node??', 'node01'), true);
			assert.strictEqual(_patternMatch('glob', 'node??', 'nodeab'), true);
			assert.strictEqual(_patternMatch('glob', 'node??', 'node1'), false);
			assert.strictEqual(_patternMatch('glob', 'node??', 'node123'), false);
		});

		it('glob matching is case-insensitive', function () {
			assert.strictEqual(_patternMatch('glob', 'BRE*', 'bre system'), true);
			assert.strictEqual(_patternMatch('glob', 'bre*', 'BRE MAIL'), true);
		});

		it('multiple wildcards', function () {
			assert.strictEqual(_patternMatch('glob', '*mail*', 'BRE-MAIL-SYSTEM'), true);
			assert.strictEqual(_patternMatch('glob', '*mail*', 'nomatches'), false);
		});

		it('escapes regex metacharacters in pattern', function () {
			// Parens should be literal, not regex groups
			assert.strictEqual(_patternMatch('glob', 'sysop(1)', 'sysop(1)'), true);
			assert.strictEqual(_patternMatch('glob', 'sysop(1)', 'sysop1'), false);
		});

		it('empty pattern matches anything', function () {
			assert.strictEqual(_patternMatch('glob', '', 'anything'), true);
		});
	});
});

describe('netmailRoutes._ruleMatches', function () {

	var baseRule = {
		match_type: 'exact',
		match_to_user: 'sysop',
		match_from_user: null,
		match_from_addr: null,
	};

	it('matches on to_user only when from filters are empty', function () {
		assert.strictEqual(
			_ruleMatches(baseRule, { to_user: 'sysop', from_user: 'anyone', from_addr: '1:2/3' }),
			true
		);
	});

	it('rejects when to_user does not match', function () {
		assert.strictEqual(
			_ruleMatches(baseRule, { to_user: 'other', from_user: 'anyone', from_addr: '1:2/3' }),
			false
		);
	});

	it('narrows by from_user when set', function () {
		var rule = Object.assign({}, baseRule, { match_from_user: 'bob' });
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'sysop', from_user: 'bob', from_addr: '1:2/3' }),
			true
		);
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'sysop', from_user: 'alice', from_addr: '1:2/3' }),
			false
		);
	});

	it('narrows by from_addr when set', function () {
		var rule = Object.assign({}, baseRule, { match_from_addr: '1:234/56' });
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'sysop', from_user: 'x', from_addr: '1:234/56' }),
			true
		);
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'sysop', from_user: 'x', from_addr: '1:999/99' }),
			false
		);
	});

	it('requires ALL filters to match (AND semantics)', function () {
		var rule = Object.assign({}, baseRule, {
			match_from_user: 'bob',
			match_from_addr: '1:234/56',
		});
		// to_user matches, from_user matches, from_addr doesn't -> no match
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'sysop', from_user: 'bob', from_addr: '1:999/99' }),
			false
		);
		// All three match
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'sysop', from_user: 'bob', from_addr: '1:234/56' }),
			true
		);
	});

	it('glob rules apply match_type to all filter fields', function () {
		var rule = {
			match_type: 'glob',
			match_to_user: 'BRE*',
			match_from_user: null,
			match_from_addr: '1:234/*',
		};
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'BRE System', from_user: '', from_addr: '1:234/56' }),
			true
		);
		assert.strictEqual(
			_ruleMatches(rule, { to_user: 'BRE System', from_user: '', from_addr: '2:1/1' }),
			false
		);
	});
});

describe('netmailRoutes.matchRoute (first-match-wins)', function () {

	it('returns null when no rules loaded', async function () {
		var result = await matchRoute({ to_user: 'sysop' }, { rules: [] });
		assert.strictEqual(result, null);
	});

	it('returns null when no rule matches', async function () {
		var rules = [
			{ match_type: 'exact', match_to_user: 'areafix', action: 'alias', target: 'a' },
			{ match_type: 'exact', match_to_user: 'filefix', action: 'alias', target: 'f' },
		];
		var result = await matchRoute({ to_user: 'sysop' }, { rules: rules });
		assert.strictEqual(result, null);
	});

	it('returns the first matching rule (order matters)', async function () {
		var rules = [
			{ id: 1, match_type: 'glob', match_to_user: '*fix',  action: 'ignore' },
			{ id: 2, match_type: 'exact', match_to_user: 'areafix', action: 'alias', target: 'real-areafix' },
		];
		// Both match "areafix", but id 1 is first in the array
		var result = await matchRoute({ to_user: 'areafix' }, { rules: rules });
		assert.strictEqual(result.id, 1);
		assert.strictEqual(result.action, 'ignore');
	});

	it('honours from_addr narrowing', async function () {
		var rules = [
			{ id: 1, match_type: 'exact', match_to_user: 'sysop', match_from_addr: '1:234/56', action: 'ignore' },
			{ id: 2, match_type: 'exact', match_to_user: 'sysop', action: 'alias', target: 'real-sysop' },
		];
		// From 1:234/56 hits rule 1
		var a = await matchRoute({ to_user: 'sysop', from_addr: '1:234/56' }, { rules: rules });
		assert.strictEqual(a.id, 1);
		// From elsewhere falls through to rule 2
		var b = await matchRoute({ to_user: 'sysop', from_addr: '2:1/1' }, { rules: rules });
		assert.strictEqual(b.id, 2);
	});

	it('real-world: ignore BRE System from IBBS games', async function () {
		var rules = [
			{ id: 1, match_type: 'glob', match_to_user: 'BRE*', action: 'ignore' },
		];
		var r = await matchRoute({ to_user: 'BRE System', from_user: 'Bob', from_addr: '1:234/56' }, { rules: rules });
		assert.ok(r);
		assert.strictEqual(r.action, 'ignore');
	});

	it('real-world: alias areamanager to areafix', async function () {
		var rules = [
			{ id: 1, match_type: 'exact', match_to_user: 'areamanager', action: 'alias', target: 'areafix' },
		];
		var r = await matchRoute({ to_user: 'AreaManager' }, { rules: rules });
		assert.ok(r);
		assert.strictEqual(r.action, 'alias');
		assert.strictEqual(r.target, 'areafix');
	});

	it('real-world: dump to directory for external handler', async function () {
		var rules = [
			{ id: 1, match_type: 'exact', match_to_user: 'bbs-link', action: 'dump', target: 'netmail/bbs-link' },
		];
		var r = await matchRoute({ to_user: 'BBS-LINK' }, { rules: rules });
		assert.ok(r);
		assert.strictEqual(r.action, 'dump');
		assert.strictEqual(r.target, 'netmail/bbs-link');
	});
});

describe('netmailRoutes constants', function () {
	it('exposes valid actions', function () {
		assert.deepStrictEqual(VALID_ACTIONS.sort(), ['alias', 'dump', 'ignore']);
	});
	it('exposes valid match types', function () {
		assert.deepStrictEqual(VALID_MATCH_TYPES.sort(), ['exact', 'glob']);
	});
});

describe('netmailRoutes._globToRegex', function () {
	it('anchors start and end', function () {
		var re = _globToRegex('area');
		assert.strictEqual(re.test('area'), true);
		assert.strictEqual(re.test('areafix'), false);
		assert.strictEqual(re.test('xarea'), false);
	});

	it('is case-insensitive', function () {
		var re = _globToRegex('AREA');
		assert.strictEqual(re.test('area'), true);
	});
});
