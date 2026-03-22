// tests/configvars.test.js — Unit tests for configvars.js
//
// configvars.js imports appConfig which tries to read DB/env — we work around
// this by only testing the substitute() function's token expansion logic, which
// does not need appConfig for session/user/terminal/door tokens.  The system-
// directory and system-info tokens (%!, %Z, %O, %Q, %V, %K, %J, %M) call into
// appConfig.get() which reads from an in-memory cache — they will return empty
// string when appConfig is not loaded, which is fine for these tests.
//
// Run: npx mocha tests/configvars.test.js

import assert from 'assert';
import { substitute, substituteArray, getVariableList } from '../src/utils/configvars.js';

// ---------------------------------------------------------------------------
// Mock call and door config objects
// ---------------------------------------------------------------------------

function makeCall(overrides) {
	return Object.assign({
		nodenum:          3,
		uuid:             'test-uuid-1234',
		caller_username:  'testuser',
		caller_fullname:  'Test User',
		caller_location:  'Testville',
		security:         100,
		term_width:       80,
		term_height:      24,
		term_encoding:    'CP437',
		term_type:        'ANSI',
		baudRate:         38400,
		timeleft:         3600,
		connection_type:  'WebSocket',
		port:             8080,
		user_record:      { id: 42 }
	}, overrides);
}

function makeDoor(overrides) {
	return Object.assign({
		doorDir:     '/games/door1',
		dropfileDir: '/games/drop',
		doorScript:  'door1.js',
		cmd:         '/usr/local/bin/door1',
		slug:        'door1'
	}, overrides);
}

// ---------------------------------------------------------------------------
// substitute — node/session tokens
// ---------------------------------------------------------------------------

describe('substitute', function () {

	describe('fast path — no percent sign', function () {
		it('should return template unchanged when no % present', function () {
			var r = substitute('hello world', makeCall(), makeDoor());
			assert.strictEqual(r, 'hello world');
		});

		it('should return empty string for null template', function () {
			var r = substitute(null, makeCall(), makeDoor());
			assert.strictEqual(r, '');
		});

		it('should pass through non-string template as-is', function () {
			var r = substitute(42, makeCall(), makeDoor());
			assert.strictEqual(r, 42);
		});
	});

	describe('%N — node number', function () {
		it('should substitute %N with nodenum', function () {
			var r = substitute('%N', makeCall({ nodenum: 7 }));
			assert.strictEqual(r, '7');
		});

		it('should substitute %# with nodenum (alias)', function () {
			var r = substitute('%#', makeCall({ nodenum: 7 }));
			assert.strictEqual(r, '7');
		});

		it('should substitute %* with zero-padded nodenum to 3 digits', function () {
			var r = substitute('%*', makeCall({ nodenum: 5 }));
			assert.strictEqual(r, '005');
		});

		it('should return empty string for %N when call is null', function () {
			var r = substitute('%N', null);
			assert.strictEqual(r, '');
		});
	});

	describe('%U — username', function () {
		it('should substitute %U with caller_username', function () {
			var r = substitute('%U', makeCall({ caller_username: 'alice' }));
			assert.strictEqual(r, 'alice');
		});

		it('should substitute %A as alias for %U', function () {
			var r = substitute('%A', makeCall({ caller_username: 'alice' }));
			assert.strictEqual(r, 'alice');
		});
	});

	describe('%R — real name', function () {
		it('should substitute %R with caller_fullname', function () {
			var r = substitute('%R', makeCall({ caller_fullname: 'Alice Smith' }));
			assert.strictEqual(r, 'Alice Smith');
		});
	});

	describe('%1 / %2 / %3 / %4 — user ID with padding', function () {
		it('should substitute %1 with raw user ID', function () {
			var r = substitute('%1', makeCall({ user_record: { id: 7 } }));
			assert.strictEqual(r, '7');
		});

		it('should substitute %2 with user ID padded to 2 digits', function () {
			var r = substitute('%2', makeCall({ user_record: { id: 5 } }));
			assert.strictEqual(r, '05');
		});

		it('should substitute %3 with user ID padded to 3 digits', function () {
			var r = substitute('%3', makeCall({ user_record: { id: 5 } }));
			assert.strictEqual(r, '005');
		});

		it('should substitute %4 with user ID padded to 4 digits', function () {
			var r = substitute('%4', makeCall({ user_record: { id: 5 } }));
			assert.strictEqual(r, '0005');
		});
	});

	describe('terminal tokens', function () {
		it('should substitute %W with term_width', function () {
			var r = substitute('%W', makeCall({ term_width: 132 }));
			assert.strictEqual(r, '132');
		});

		it('should substitute %H with term_height', function () {
			var r = substitute('%H', makeCall({ term_height: 50 }));
			assert.strictEqual(r, '50');
		});

		it('should substitute %E with term_encoding', function () {
			var r = substitute('%E', makeCall({ term_encoding: 'utf-8' }));
			assert.strictEqual(r, 'utf-8');
		});

		it('should substitute %Y with term_type', function () {
			var r = substitute('%Y', makeCall({ term_type: 'ANSI' }));
			assert.strictEqual(r, 'ANSI');
		});
	});

	describe('connection tokens', function () {
		it('should substitute %B with baudRate', function () {
			var r = substitute('%B', makeCall({ baudRate: 115200 }));
			assert.strictEqual(r, '115200');
		});

		it('should substitute %T with timeleft', function () {
			var r = substitute('%T', makeCall({ timeleft: 1800 }));
			assert.strictEqual(r, '1800');
		});

		it('should substitute %C with connection_type', function () {
			var r = substitute('%C', makeCall({ connection_type: 'TCP' }));
			assert.strictEqual(r, 'TCP');
		});

		it('should substitute %P with port', function () {
			var r = substitute('%P', makeCall({ port: 23 }));
			assert.strictEqual(r, '23');
		});
	});

	describe('door config tokens', function () {
		it('should substitute %D with doorDir', function () {
			var r = substitute('%D', makeCall(), makeDoor({ doorDir: '/opt/doors' }));
			assert.strictEqual(r, '/opt/doors');
		});

		it('should substitute %F with dropfileDir', function () {
			var r = substitute('%F', makeCall(), makeDoor({ dropfileDir: '/opt/drop' }));
			assert.strictEqual(r, '/opt/drop');
		});

		it('should substitute %S with doorScript', function () {
			var r = substitute('%S', makeCall(), makeDoor({ doorScript: 'myscript.js' }));
			assert.strictEqual(r, 'myscript.js');
		});

		it('should substitute %G with slug', function () {
			var r = substitute('%G', makeCall(), makeDoor({ slug: 'mygame' }));
			assert.strictEqual(r, 'mygame');
		});

		it('should substitute %X with cmd', function () {
			var r = substitute('%X', makeCall(), makeDoor({ cmd: '/usr/bin/game' }));
			assert.strictEqual(r, '/usr/bin/game');
		});

		it('should return empty string for door tokens when no doorConfig', function () {
			var r = substitute('%D', makeCall(), null);
			assert.strictEqual(r, '');
		});
	});

	describe('%% — literal percent', function () {
		it('should substitute %% with a single %', function () {
			var r = substitute('100%%', makeCall());
			assert.strictEqual(r, '100%');
		});
	});

	describe('unknown tokens', function () {
		it('should consume unknown %X tokens (replace with empty)', function () {
			// Unknown tokens are consumed, not passed through
			var r = substitute('test%qvalue', makeCall());
			assert.ok(!r.includes('%'));
			assert.strictEqual(r, 'testvalue');
		});
	});

	describe('multi-token expansion', function () {
		it('should expand multiple tokens in one string', function () {
			var call = makeCall({ nodenum: 2, caller_username: 'bob' });
			var r = substitute('Node %N user %U', call);
			assert.strictEqual(r, 'Node 2 user bob');
		});

		it('should expand tokens adjacent to literal text', function () {
			var r = substitute('/doors/%D/run', makeCall(), makeDoor({ doorDir: 'games' }));
			assert.strictEqual(r, '/doors/games/run');
		});
	});

	describe('%I — session UUID', function () {
		it('should substitute %I with uuid', function () {
			var r = substitute('%I', makeCall({ uuid: 'abc-123' }));
			assert.strictEqual(r, 'abc-123');
		});
	});

	describe('null call object — defaults', function () {
		it('should default %W to 80 when call is null', function () {
			var r = substitute('%W', null);
			assert.strictEqual(r, '80');
		});

		it('should default %H to 24 when call is null', function () {
			var r = substitute('%H', null);
			assert.strictEqual(r, '24');
		});

		it('should default %B to 38400 when call is null', function () {
			var r = substitute('%B', null);
			assert.strictEqual(r, '38400');
		});

		it('should default %T to 9999 when call is null', function () {
			var r = substitute('%T', null);
			assert.strictEqual(r, '9999');
		});
	});
});

// ---------------------------------------------------------------------------
// substituteArray
// ---------------------------------------------------------------------------

describe('substituteArray', function () {

	it('should return null for null input', function () {
		assert.strictEqual(substituteArray(null, makeCall()), null);
	});

	it('should return non-array input unchanged', function () {
		assert.strictEqual(substituteArray('string', makeCall()), 'string');
	});

	it('should expand tokens in each element', function () {
		var call = makeCall({ nodenum: 5, caller_username: 'charlie' });
		var arr = ['node=%N', 'user=%U', 'literal'];
		var r = substituteArray(arr, call);
		assert.deepStrictEqual(r, ['node=5', 'user=charlie', 'literal']);
	});

	it('should leave non-string elements unchanged', function () {
		var r = substituteArray([1, null, '%N'], makeCall({ nodenum: 3 }));
		assert.strictEqual(r[0], 1);
		assert.strictEqual(r[1], null);
		assert.strictEqual(r[2], '3');
	});
});

// ---------------------------------------------------------------------------
// getVariableList
// ---------------------------------------------------------------------------

describe('getVariableList', function () {

	it('should return an array', function () {
		var list = getVariableList();
		assert.ok(Array.isArray(list));
	});

	it('should have entries with token and description fields', function () {
		var list = getVariableList();
		for (var entry of list) {
			assert.ok(typeof entry.token === 'string', 'token is a string');
			assert.ok(typeof entry.description === 'string', 'description is a string');
		}
	});

	it('should include standard tokens', function () {
		var list = getVariableList();
		var tokens = list.map(function(e) { return e.token; });
		assert.ok(tokens.includes('%N'));
		assert.ok(tokens.includes('%U'));
		assert.ok(tokens.includes('%%'));
		assert.ok(tokens.includes('%D'));
	});
});
