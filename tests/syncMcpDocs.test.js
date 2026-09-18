// tests/syncMcpDocs.test.js: what the docs sync counts as a reply.
//
// The sync has twice reported success for work the server refused. First a
// JSON-RPC error arriving as plain JSON was returned as though it were a
// result, so an unauthorised run reported 49 documents created. Then a reply
// that was neither SSE nor JSON came back as null and null counted as success:
// Express answers an oversized body with an HTML 413 page before the MCP layer
// sees it, so the 209 KB changelog was reported as updated while the server
// kept an April copy. Every reply below is one the server really sends.
//
// Importing the script runs no sync: main() is guarded on the file being the
// program, as in release.mjs.

import assert from 'assert';
import { readReply, toolResult } from '../scripts/syncMcpDocs.mjs';

var PAYLOAD_TOO_LARGE =
	'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n' +
	'<pre>PayloadTooLargeError: request entity too large<br> &nbsp; &nbsp;at readStream ' +
	'(/srv/mcp/node_modules/raw-body/index.js:163:17)<br> &nbsp; &nbsp;at getRawBody ' +
	'(/srv/mcp/node_modules/raw-body/index.js:116:12)</pre>\n</body>\n</html>\n';

describe('syncMcpDocs: reading a reply', function () {
	it('returns the result from an SSE reply', function () {
		var text = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"pong"}]}}\n\n';
		assert.deepStrictEqual(readReply('tools/call', 200, text), { content: [{ type: 'text', text: 'pong' }] });
	});

	it('refuses the HTML 413 page an oversized body gets', function () {
		assert.throws(function () { readReply('tools/call', 413, PAYLOAD_TOO_LARGE); }, function (err) {
			assert.match(err.message, /^tools\/call failed \(HTTP 413\): PayloadTooLargeError: request entity too large$/);
			return true;
		});
	});

	it('refuses an empty reply', function () {
		assert.throws(function () { readReply('tools/call', 502, ''); }, /HTTP 502\): \(empty response\)/);
	});

	it('refuses a JSON-RPC error sent as plain JSON', function () {
		var text = '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized: missing or invalid MCP API key (send X-Api-Key header)"},"id":null}';
		assert.throws(function () { readReply('initialize', 401, text); }, /initialize failed \(HTTP 401\).*-32001/);
	});

	it('refuses a JSON-RPC error even when the status says 200', function () {
		var text = 'event: message\ndata: {"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"bad params"}}\n\n';
		assert.throws(function () { readReply('tools/call', 200, text); }, /-32602/);
	});

	it('refuses a failure status whose JSON body carries no error', function () {
		assert.throws(function () { readReply('tools/call', 500, '{"message":"internal"}'); }, /HTTP 500/);
	});

	it('refuses a reply with neither a result nor an error', function () {
		assert.throws(function () { readReply('tools/call', 200, '{"jsonrpc":"2.0","id":5}'); }, /HTTP 200/);
	});
});

describe('syncMcpDocs: reading a tool result', function () {
	it('refuses a result the tool marked as an error', function () {
		var result = { isError: true, content: [{ type: 'text', text: 'Document 46 not found' }] };
		assert.throws(function () { toolResult('update_knowledge_doc', result); },
			/^Error: update_knowledge_doc reported an error: Document 46 not found$/);
	});

	it('parses text content that is JSON', function () {
		assert.deepStrictEqual(toolResult('create_knowledge_doc', { content: [{ type: 'text', text: '{"id":414}' }] }), { id: 414 });
	});

	it('returns text content that is not JSON as it came', function () {
		assert.strictEqual(toolResult('ping', { content: [{ type: 'text', text: 'pong' }] }), 'pong');
	});
});
