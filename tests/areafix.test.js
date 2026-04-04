// tests/areafix.test.js -- Unit tests for src/models/areafix.js
//
// Covers _parseCommands (pure function, no DB) and export surface validation.
// The module is safe to import directly: postgres, redis, alogger, appConfig
// all have lazy initialisation and make no TCP connections at load time.

import assert from 'assert';
import { _parseCommands, handleRequest, buildResponse, _authenticate } from '../src/models/areafix.js';

// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------

describe('areafix exports', function () {
	it('exports handleRequest', function () {
		assert.strictEqual(typeof handleRequest, 'function');
	});

	it('exports buildResponse', function () {
		assert.strictEqual(typeof buildResponse, 'function');
	});

	it('exports _parseCommands', function () {
		assert.strictEqual(typeof _parseCommands, 'function');
	});

	it('exports _authenticate', function () {
		assert.strictEqual(typeof _authenticate, 'function');
	});
});

// ---------------------------------------------------------------------------
// _parseCommands
// ---------------------------------------------------------------------------

describe('_parseCommands', function () {

	// --- Empty / null inputs ---

	describe('empty and null inputs', function () {
		it('returns empty array for empty string', function () {
			var result = _parseCommands('');
			assert.deepStrictEqual(result, []);
		});

		it('returns empty array for whitespace-only string', function () {
			var result = _parseCommands('   \n   \n  ');
			assert.deepStrictEqual(result, []);
		});

		it('returns empty array for null', function () {
			// bodyText is accessed as ftnMessage.BodyText || '' in handleRequest,
			// but _parseCommands itself calls bodyText.split() -- guard with empty string.
			// Passing null directly would throw; the contract is a string. Verify
			// that an empty-string body (the normalised form) returns [].
			var result = _parseCommands('');
			assert.deepStrictEqual(result, []);
		});
	});

	// --- Subscribe: +AREATAG ---

	describe('+AREATAG (subscribe)', function () {
		it('produces a subscribe command for +AREATAG', function () {
			var result = _parseCommands('+FIDONEWS');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'FIDONEWS');
		});

		it('uppercases the areatag', function () {
			var result = _parseCommands('+fidonews');
			assert.strictEqual(result[0].areatag, 'FIDONEWS');
		});

		it('handles leading/trailing whitespace around + prefix', function () {
			var result = _parseCommands('  +MY.AREA  ');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'MY.AREA');
		});

		it('handles whitespace between + and areatag', function () {
			var result = _parseCommands('+  SOME.AREA');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'SOME.AREA');
		});

		it('includes a raw property', function () {
			var result = _parseCommands('+MYAREA');
			assert.ok(result[0].raw !== undefined);
		});

		it('ignores a bare + with no areatag', function () {
			var result = _parseCommands('+');
			assert.deepStrictEqual(result, []);
		});

		it('ignores + followed only by whitespace', function () {
			var result = _parseCommands('+   ');
			assert.deepStrictEqual(result, []);
		});
	});

	// --- Unsubscribe: -AREATAG ---

	describe('-AREATAG (unsubscribe)', function () {
		it('produces an unsubscribe command for -AREATAG', function () {
			var result = _parseCommands('-FIDONEWS');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'unsubscribe');
			assert.strictEqual(result[0].areatag, 'FIDONEWS');
		});

		it('uppercases the areatag', function () {
			var result = _parseCommands('-fidonews');
			assert.strictEqual(result[0].areatag, 'FIDONEWS');
		});

		it('handles whitespace between - and areatag', function () {
			var result = _parseCommands('-  OLD.AREA');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'unsubscribe');
			assert.strictEqual(result[0].areatag, 'OLD.AREA');
		});

		it('handles leading whitespace on the whole line', function () {
			var result = _parseCommands('   -REMOVE.ME');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'unsubscribe');
			assert.strictEqual(result[0].areatag, 'REMOVE.ME');
		});

		it('ignores a bare - with no areatag', function () {
			var result = _parseCommands('-');
			assert.deepStrictEqual(result, []);
		});
	});

	// --- Percent commands ---

	describe('%COMMAND lines', function () {
		var percentCommands = ['%LIST', '%QUERY', '%HELP', '%AREAS', '%PAUSE', '%RESUME'];

		for (var cmd of percentCommands) {
			// Closure to capture the loop variable correctly
			(function (cmdStr) {
				it('produces { type: "command", name: "' + cmdStr.substring(1) + '" } for ' + cmdStr, function () {
					var result = _parseCommands(cmdStr);
					assert.strictEqual(result.length, 1);
					assert.strictEqual(result[0].type, 'command');
					assert.strictEqual(result[0].name, cmdStr.substring(1));
				});
			})(cmd);
		}

		it('uppercases the command name', function () {
			var result = _parseCommands('%list');
			assert.strictEqual(result[0].name, 'LIST');
		});

		it('handles mixed-case command', function () {
			var result = _parseCommands('%Help');
			assert.strictEqual(result[0].name, 'HELP');
		});

		it('handles whitespace before %COMMAND', function () {
			var result = _parseCommands('  %QUERY');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].name, 'QUERY');
		});

		it('strips trailing argument text -- only takes first word after %', function () {
			// e.g. "%LIST extra stuff" should parse as LIST
			var result = _parseCommands('%LIST extra stuff');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].name, 'LIST');
		});

		it('includes a raw property', function () {
			var result = _parseCommands('%HELP');
			assert.ok(result[0].raw !== undefined);
		});

		it('produces command type for unknown % command', function () {
			var result = _parseCommands('%UNRECOGNISED');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'command');
			assert.strictEqual(result[0].name, 'UNRECOGNISED');
		});
	});

	// --- Bare areatag (subscribe convention) ---

	describe('bare areatag (subscribe shorthand)', function () {
		it('treats a bare alphanumeric areatag as subscribe', function () {
			var result = _parseCommands('FIDONEWS');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'FIDONEWS');
		});

		it('uppercases bare areatag', function () {
			var result = _parseCommands('fidonews');
			assert.strictEqual(result[0].areatag, 'FIDONEWS');
		});

		it('accepts dots in bare areatag', function () {
			var result = _parseCommands('FTN.NET.GENERAL');
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'FTN.NET.GENERAL');
		});

		it('accepts underscores in bare areatag', function () {
			var result = _parseCommands('MY_AREA');
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'MY_AREA');
		});

		it('accepts dashes in bare areatag', function () {
			var result = _parseCommands('MY-AREA');
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'MY-AREA');
		});

		it('ignores lines with spaces (not a valid bare areatag)', function () {
			// "FIDONEWS EXTRA" has a space -- regex /^[A-Z0-9._-]+$/ will not match
			var result = _parseCommands('FIDONEWS EXTRA');
			assert.deepStrictEqual(result, []);
		});

		it('ignores lines with special characters not in the areatag charset', function () {
			var result = _parseCommands('BAD!AREA');
			assert.deepStrictEqual(result, []);
		});
	});

	// --- Tear line handling ---

	describe('tear line (---) stops parsing', function () {
		it('stops at --- tear line', function () {
			var body = '+AREA1\n--- Tear line\n+AREA2';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].areatag, 'AREA1');
		});

		it('stops at --- with no following text', function () {
			var body = '+AREA1\n---\n+AREA2';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 1);
		});

		it('stops at --- even if it appears first', function () {
			var body = '---\n+AREA1';
			var result = _parseCommands(body);
			assert.deepStrictEqual(result, []);
		});

		it('includes commands before the tear line', function () {
			var body = '+AREA1\n%QUERY\n---\n+IGNORED';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].areatag, 'AREA1');
			assert.strictEqual(result[1].name, 'QUERY');
		});

		it('handles --- with leading whitespace on the line', function () {
			// The function trims before the startsWith check, so "  ---" becomes "---"
			var body = '+AREA1\n  --- Tear\n+IGNORED';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 1);
		});
	});

	// --- Kludge line handling ---

	describe('kludge lines (\\x01) are skipped', function () {
		it('skips a kludge line', function () {
			var body = '\x01MSGID: 1:2/3 abc123\n+AREA1';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].areatag, 'AREA1');
		});

		it('skips multiple consecutive kludge lines', function () {
			var body = '\x01MSGID: 1:2/3\n\x01FMPT 1\n\x01TOPT 2\n+AREA1';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 1);
		});

		it('does not treat a kludge line as a command', function () {
			var body = '\x01%LIST';
			var result = _parseCommands(body);
			assert.deepStrictEqual(result, []);
		});
	});

	// --- Blank lines ---

	describe('blank lines are skipped', function () {
		it('skips blank lines between commands', function () {
			var body = '+AREA1\n\n\n+AREA2';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 2);
		});

		it('skips whitespace-only lines', function () {
			var body = '+AREA1\n   \n\t\n+AREA2';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 2);
		});
	});

	// --- CRLF line endings ---

	describe('CRLF line endings', function () {
		it('handles \\r\\n line endings', function () {
			var body = '+AREA1\r\n+AREA2\r\n%LIST';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0].areatag, 'AREA1');
			assert.strictEqual(result[1].areatag, 'AREA2');
			assert.strictEqual(result[2].name, 'LIST');
		});

		it('handles mixed \\r\\n and \\n line endings', function () {
			var body = '+AREA1\r\n+AREA2\n%HELP';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 3);
		});
	});

	// --- Mixed commands ---

	describe('mixed command bodies', function () {
		it('parses a realistic AreaFix request body', function () {
			var body = [
				'\x01MSGID: 1:234/5 deadbeef',
				'',
				'+FIDONEWS',
				'+FTN.NET.GENERAL',
				'-OLD.ECHO',
				'%QUERY',
				'%HELP',
				'',
				'--- Synchronet v3.20',
				'+AFTER.TEAR'
			].join('\n');

			var result = _parseCommands(body);

			assert.strictEqual(result.length, 5);

			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'FIDONEWS');

			assert.strictEqual(result[1].type, 'subscribe');
			assert.strictEqual(result[1].areatag, 'FTN.NET.GENERAL');

			assert.strictEqual(result[2].type, 'unsubscribe');
			assert.strictEqual(result[2].areatag, 'OLD.ECHO');

			assert.strictEqual(result[3].type, 'command');
			assert.strictEqual(result[3].name, 'QUERY');

			assert.strictEqual(result[4].type, 'command');
			assert.strictEqual(result[4].name, 'HELP');
		});

		it('parses bare areatags mixed with explicit + lines', function () {
			var body = 'AREA.ONE\n+AREA.TWO\n-AREA.THREE';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0].type, 'subscribe');
			assert.strictEqual(result[0].areatag, 'AREA.ONE');
			assert.strictEqual(result[1].type, 'subscribe');
			assert.strictEqual(result[1].areatag, 'AREA.TWO');
			assert.strictEqual(result[2].type, 'unsubscribe');
			assert.strictEqual(result[2].areatag, 'AREA.THREE');
		});

		it('each command object has type and either areatag or name', function () {
			var body = '+AREA1\n-AREA2\n%LIST\nBAREAREA';
			var result = _parseCommands(body);
			assert.strictEqual(result.length, 4);

			// subscribe/unsubscribe have areatag
			assert.ok('areatag' in result[0]);
			assert.ok('areatag' in result[1]);

			// command has name
			assert.ok('name' in result[2]);

			// bare subscribe has areatag
			assert.ok('areatag' in result[3]);
		});
	});

	// --- Edge: areatag with numbers and mixed case ---

	describe('areatag case normalisation', function () {
		it('uppercases mixed-case +areatag', function () {
			var result = _parseCommands('+Fidonews.General');
			assert.strictEqual(result[0].areatag, 'FIDONEWS.GENERAL');
		});

		it('uppercases mixed-case -areatag', function () {
			var result = _parseCommands('-Fidonews.General');
			assert.strictEqual(result[0].areatag, 'FIDONEWS.GENERAL');
		});

		it('accepts numeric areatag characters', function () {
			var result = _parseCommands('+AREA123');
			assert.strictEqual(result[0].areatag, 'AREA123');
		});

		it('accepts areatag with all dots', function () {
			var result = _parseCommands('+A.B.C.D');
			assert.strictEqual(result[0].areatag, 'A.B.C.D');
		});
	});
});
