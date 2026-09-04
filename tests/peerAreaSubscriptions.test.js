// tests/peerAreaSubscriptions.test.js — Unit tests for peerAreaSubscriptions.js
//
// Covers the area shortcode guard, which is the one piece reachable without a
// database: the backing message table name is interpolated into SQL, so an
// invalid shortcode must be rejected before any query is built. The rest of
// the module needs a live DB and is not covered here.
// Run: npx mocha tests/peerAreaSubscriptions.test.js

import assert from 'assert';
import { headIdForShortcode } from '../src/models/peerAreaSubscriptions.js';

describe('peerAreaSubscriptions shortcode guard', function () {

	// Every case below must reject before a query is constructed, so these
	// pass without a database connection.

	function rejects(shortcode, label) {
		it('rejects ' + label, async function () {
			await assert.rejects(
				function () { return headIdForShortcode(shortcode); },
				/Invalid area shortcode/
			);
		});
	}

	rejects('test; DROP TABLE users--', 'a statement terminator');
	rejects("test' OR '1'='1", 'embedded quotes');
	rejects('test area', 'an embedded space');
	rejects('test-area', 'a hyphen');
	rejects('test.area', 'a dot');
	rejects('test"quoted"', 'double quotes');
	rejects('9lives', 'a leading digit');
	rejects('', 'an empty shortcode');
	rejects(null, 'null');
	rejects(undefined, 'undefined');
	rejects('area/../etc', 'path traversal characters');
	rejects('area\nnewline', 'an embedded newline');
});
