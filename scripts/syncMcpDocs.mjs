#!/usr/bin/env node
// Canectic BBS - MCP knowledge base doc sync.
//
// Reads docs/reference/*.md and docs/sysop/*.md and pushes them to the
// Tranqsoft MCP knowledge base under project_id=3 (Canectic BBS).
//
// First-time syncs CREATE new knowledge docs. Subsequent runs find existing
// docs by exact title match (within the `canectic` tag) and UPDATE them
// in place. The MCP server auto-versions every update, so prior content is
// preserved in version history.
//
// Usage:
//   node scripts/syncMcpDocs.mjs <short-commit-hash>
//
// Example:
//   node scripts/syncMcpDocs.mjs $(git rev-parse --short HEAD)
//
// The commit hash is embedded in the update reason string so each version
// snapshot is traceable to a specific repo state.
//
// Excluded from sync (intentional):
//   - docs/RELEASE_TRACKER.md  -- rolling checklist, not reference content
//   - CLAUDE.md                -- gitignored, session-onboarding only
//
// To add a new doc to the sync, drop it into docs/reference/ or docs/sysop/
// and add an entry to TOPIC_TAGS below. Files without an entry are still
// synced but only get the role tag and `canectic` tag (logged as a warning).
//
// Requires the Tranqsoft MCP server reachable at MCP_URL. The script does
// the MCP HTTP handshake (initialize + notifications/initialized) before
// making tool calls, and parses SSE responses inline.
//
// The server requires an API key in an X-Api-Key header and answers anything
// without one with a JSON-RPC -32001, "Unauthorized: missing or invalid MCP API
// key". It publishes no OAuth metadata at all, so there is nothing to negotiate
// and nothing to discover: the key is the whole of the authentication.
//
//   MCP_API_KEY=... node scripts/syncMcpDocs.mjs $(git rev-parse --short HEAD)
//
// Checked before the first request rather than after, because the failure
// otherwise arrives as an unauthorised handshake several steps in and reads
// like the server being down.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

var MCP_URL = process.env.MCP_URL || 'http://janus.lan:3000/mcp';
var MCP_API_KEY = process.env.MCP_API_KEY || '';
var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var COMMIT = process.argv[2] || 'unknown';

var sessionId = null;
var rpcId = 0;

/** One definition of what every request carries, so a second call site cannot
 *  be added without the key the way both of these originally were. */
function requestHeaders() {
    var headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
    };
    if (MCP_API_KEY) headers['X-Api-Key'] = MCP_API_KEY;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    return headers;
}

async function rpc(method, params) {
    rpcId += 1;
    var headers = requestHeaders();

    var res = await fetch(MCP_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: method, params: params })
    });

    var sid = res.headers.get('mcp-session-id');
    if (sid && !sessionId) sessionId = sid;

    var text = await res.text();

    return readReply(method, res.status, text);
}

async function notify(method, params) {
    rpcId += 1;
    var headers = requestHeaders();

    await fetch(MCP_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: method, params: params })
    });
}

/** The first line of an error page, with the markup stripped, so a 413 reads as
 *  "PayloadTooLargeError: request entity too large" rather than a wall of HTML. */
function describeUnreadable(text) {
    var plain = text.replace(/<head[\s\S]*?<\/head>/i, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    var at = plain.indexOf(' at ');
    if (at > 0) plain = plain.slice(0, at);
    return plain.slice(0, 200) || '(empty response)';
}

// What one reply means: the JSON-RPC `result`, or a thrown Error naming the
// method and the HTTP status. Pure, so the rules are testable without a server.
//
// Two shapes, ONE set of rules. The server answers tool calls as SSE and
// errors as plain JSON, and the plain branch used to return the parsed body
// whole, without looking for `error` and without unwrapping `result`. An
// unauthorised run therefore handed the error object back as though it were
// a result and carried on: the 401 was printed once under [ping] and then
// 49 documents were reported as created against a server refusing every
// request. A sync that achieves nothing while reporting progress is worse
// than one that fails.
//
// The same hole had a second way in: anything that was neither shape
// returned null, and null counted as success. Express answers an oversized
// body with an HTML 413 page before the MCP layer sees it, so once the
// changelog outgrew the limit it was reported as updated while the server
// went on holding the April copy. A reply we cannot read is a failure,
// whatever the status line says.
export function readReply(method, status, text) {
    var dataLine = text.split('\n').find(function(l) { return l.startsWith('data: '); });
    var payload = null;
    if (dataLine) payload = JSON.parse(dataLine.slice(6));
    else if (text.trim().startsWith('{')) payload = JSON.parse(text);

    var failed = method + ' failed (HTTP ' + status + '): ';
    if (!payload) throw new Error(failed + describeUnreadable(text));
    if (payload.error) throw new Error(failed + JSON.stringify(payload.error));
    if (status < 200 || status >= 300 || !('result' in payload)) {
        throw new Error(failed + JSON.stringify(payload).slice(0, 200));
    }
    return payload.result;
}

/** The content of a tool call's result, parsed as JSON when it is JSON. */
export function toolResult(name, result) {
    // A tool that fails reports it inside a successful JSON-RPC result, per the
    // MCP spec, so the envelope checks in rpc() cannot see it.
    if (result && result.isError) {
        var why = (result.content || []).map(function(c) { return c.text || ''; }).join(' ').trim();
        throw new Error(name + ' reported an error: ' + (why || '(no detail)'));
    }
    if (result && result.content && result.content[0] && result.content[0].type === 'text') {
        var t = result.content[0].text;
        try { return JSON.parse(t); } catch (e) { return t; }
    }
    return result;
}

async function callTool(name, args) {
    return toolResult(name, await rpc('tools/call', { name: name, arguments: args }));
}

function extractTitle(content, fallback) {
    var lines = content.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.startsWith('# ')) return line.slice(2).trim();
        if (line && !line.startsWith('#')) break;
    }
    return fallback;
}

// (filename → topic tags) — role tag added automatically
var TOPIC_TAGS = {
    // reference
    'NETWORKING_ARCHITECTURE.md':   ['networking', 'ftn', 'qwk', 'nntp', 'tossers', 'architecture'],
    'QWK_ARCHITECTURE.md':          ['networking', 'qwk', 'tossers', 'hub', 'architecture'],
    'MAILER_ARCHITECTURE.md':       ['networking', 'ftn', 'mailer', 'binkp', 'architecture'],
    'PEER_INTEROP.md':              ['networking', 'ftn', 'interop', 'bbbs', 'reference'],
    'PM_ARCHITECTURE.md':           ['pm', 'messaging', 'attachments', 'architecture'],
    'EMAIL_ARCHITECTURE.md':        ['email', 'smtp', 'imap', 'architecture'],
    'message_architecture.md':      ['messages', 'echomail', 'architecture'],
    'terminal_architecture.md':     ['terminal', 'handlers', 'doors', 'architecture'],
    'web_architecture.md':          ['web', 'express', 'sessions', 'architecture'],
    'PROCESS_ARCHITECTURE.md':      ['processes', 'bullmq', 'worker', 'architecture'],
    'LOGGING_SYSTEM.md':            ['logging', 'observability'],
    'CONFIG_SYSTEM_DESIGN.md':      ['configuration', 'appconfig', 'design'],
    'FILES_ARCHITECTURE.md':        ['files', 'transfers', 'architecture'],
    'FILE_SYSTEM_DESIGN.md':        ['files', 'design'],
    'DOWNLOAD_PROTOCOL_DESIGN.md':  ['files', 'transfers', 'xmodem', 'zmodem', 'design'],
    'NODELIST_DESIGN.md':           ['ftn', 'nodelist', 'design'],
    'BSO_SCANNER_DESIGN.md':        ['ftn', 'mailer', 'bso', 'design'],
    'MENU_LAYOUT_DESIGN.md':        ['terminal', 'menus', 'art', 'design'],
    'NODESPY_DESIGN.md':            ['nodespy', 'sysop', 'monitoring', 'design'],
    'SYSOP_CHAT_DESIGN.md':         ['chat', 'sysop', 'nodespy', 'design'],
    'WEB_CHAT_DESIGN.md':           ['chat', 'web', 'presence', 'design'],
    'WEB_CALLFLOW_DESIGN.md':       ['callflow', 'web', 'design'],
    'WALL_DESIGN.md':               ['wall', 'oneliners', 'design'],
    'QWK_USER_DESIGN.md':           ['qwk', 'pm', 'user', 'design'],
    'UPDATE_SYSTEM_DESIGN.md':      ['updates', 'releases', 'install', 'distribution', 'design'],
    'RELEASE_PROCESS.md':           ['updates', 'releases', 'build', 'maintainer', 'reference'],
    'FILEBOX_WILDCARD_DESIGN.md':   ['ftn', 'files', 'filebox', 'design'],
    'HUB_COORDINATOR_DESIGN.md':    ['coordinator', 'ftn', 'nodelist', 'design'],
    'API_DESIGN.md':                ['api', 'rest', 'auth', 'design'],
    'CTN_DESIGN.md':                ['ctn', 'ftn', 'design', 'future'],
    'NOTIFICATION_DESIGN.md':       ['notifications', 'realtime', 'design'],
    'EMSI_WAZOO_DESIGN.md':         ['ftn', 'mailer', 'emsi', 'wazoo', 'design'],
    'DOORSERVER_DESIGN.md':         ['doors', 'design'],
    'FREQ_DESIGN.md':               ['ftn', 'freq', 'files', 'design'],
    'MULTI_ADDRESS_DESIGN.md':      ['ftn', 'mailer', 'multi-address', 'design'],
    'PM_ATTACHMENTS_DESIGN.md':     ['pm', 'attachments', 'design'],
    'MESSAGE_TEMPLATES_DESIGN.md':  ['templates', 'notifications', 'design'],
    'Pointer INTEGRATION_GUIDE.md': ['messages', 'pointers', 'integration', 'guide'],
    // sysop
    'INSTALL.md':                   ['installation', 'setup'],
    'MENUS.md':                     ['menus', 'configuration'],
    'DOORSERVER.md':                ['doors', 'doorserver', 'configuration'],
    'THEMES.md':                    ['themes', 'configuration'],
    'API.md':                       ['api', 'authentication'],
    'MAIL.md':                      ['mail', 'smtp', 'imap'],
    'TEMPLATES.md':                 ['templates', 'notifications'],
    'NETMAIL_ROUTES.md':            ['netmail', 'ftn', 'routing', 'configuration'],
    'QWK_NETWORKING.md':            ['networking', 'qwk', 'hub', 'configuration'],
    'NETMAIL_RELAY.md':             ['netmail', 'ftn', 'relay', 'routing', 'configuration'],
    'OS_UPGRADE.md':                ['installation', 'maintenance', 'postgresql', 'upgrade'],
    'UPDATES.md':                   ['updates', 'releases', 'maintenance', 'configuration'],
    'UPDATING.md':                  ['updates', 'releases', 'maintenance', 'upgrade'],
    'MAINTENANCE.md':               ['maintenance', 'updates', 'operations', 'configuration'],
    'CHANGELOG.md':                 ['changelog']
};

// Parse the formatted text response from get_knowledge_by_tag /
// search_knowledge into an array of { id, title } objects.
//
// The MCP returns lines like:
//   [35] Canectic BBS — Process Architecture (project: Canectic BBS)
//
// (Plain text, not JSON.) The id is in square brackets at the start,
// the title runs until ` (project: ` -- everything between is the title
// and we keep it verbatim including em-dashes and special chars.
function parseKbListing(text) {
    if (!text || typeof text !== 'string') return [];
    var out = [];
    var lines = text.split('\n');
    for (var line of lines) {
        var m = line.match(/^\[(\d+)\] (.*?) \(project: /);
        if (m) {
            out.push({ id: parseInt(m[1], 10), title: m[2] });
        }
    }
    return out;
}

// Build a Map<title, id> of all canectic-tagged docs currently in the
// knowledge base. One MCP call at startup, no per-doc round trip during
// the sync loop. Used to decide whether each repo doc is a CREATE
// (no entry in the map) or an UPDATE (entry found, do an update against
// that id).
async function loadExistingIndex() {
    var listing;
    try {
        listing = await callTool('get_knowledge_by_tag', { tag: 'canectic' });
    } catch (err) {
        console.error('[index] get_knowledge_by_tag failed:', err.message);
        return new Map();
    }
    var entries = parseKbListing(listing);
    var map = new Map();
    var conflicts = [];
    for (var e of entries) {
        if (map.has(e.title)) {
            conflicts.push(e.title);
        } else {
            map.set(e.title, e.id);
        }
    }
    if (conflicts.length > 0) {
        console.error('[index] WARNING: ' + conflicts.length +
            ' titles have multiple ids in the KB (duplicate sync run?). ' +
            'Updating only the first id seen for each. Affected: ' +
            conflicts.join(', '));
    }
    console.log('[index] loaded', map.size, 'existing canectic docs');
    return map;
}

async function main() {
    // Up front, not after the handshake. Without it the run fails partway with
    // an unauthorised JSON-RPC error that reads like the server being down,
    // which is how this sat unexplained long enough to become an issue.
    if (!MCP_API_KEY) {
        console.error('[init] MCP_API_KEY is not set, and the server requires one in an X-Api-Key header.');
        console.error('       MCP_API_KEY=... node scripts/syncMcpDocs.mjs ' + COMMIT);
        process.exit(1);
    }
    console.log('[init] connecting to MCP at', MCP_URL);
    await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'canectic-sync', version: '1.0' }
    });
    await notify('notifications/initialized', {});
    console.log('[init] session', sessionId);

    var pong = await callTool('ping', {});
    console.log('[ping]', pong);

    var existingIndex = await loadExistingIndex();

    var refDir = path.join(REPO, 'docs/reference');
    var sysDir = path.join(REPO, 'docs/sysop');
    var refFiles = (await fs.readdir(refDir))
        .filter(function(f) { return f.endsWith('.md'); })
        .map(function(f) { return { dir: refDir, file: f, role: 'reference' }; });
    var sysFiles = (await fs.readdir(sysDir))
        .filter(function(f) { return f.endsWith('.md') && f !== 'RELEASE_TRACKER.md'; })
        .map(function(f) { return { dir: sysDir, file: f, role: 'sysop' }; });

    var all = refFiles.concat(sysFiles);
    console.log('[scan]', all.length, 'files (' + refFiles.length + ' reference, ' + sysFiles.length + ' sysop)');

    var created = 0;
    var updated = 0;
    var failed = [];
    var skipped = [];

    for (var i = 0; i < all.length; i++) {
        var entry = all[i];
        var fullPath = path.join(entry.dir, entry.file);
        var content;
        try {
            content = await fs.readFile(fullPath, 'utf8');
        } catch (e) {
            failed.push({ file: entry.file, reason: 'read failed: ' + e.message });
            continue;
        }
        var fallback = entry.file.replace(/\.md$/, '');
        var title = extractTitle(content, fallback);

        var topics = TOPIC_TAGS[entry.file] || [];
        if (!topics.length) {
            skipped.push({ file: entry.file, reason: 'no topic tags defined' });
        }
        var tags = ['canectic', entry.role].concat(topics);

        // Look the title up in the in-memory index built from
        // get_knowledge_by_tag. If found, the value is the existing
        // doc id and we UPDATE; otherwise CREATE.
        var existing = null;
        if (existingIndex.has(title)) {
            existing = { id: existingIndex.get(title) };
        }

        try {
            if (existing && existing.id) {
                await callTool('update_knowledge_doc', {
                    id: existing.id,
                    body: content,
                    tags: tags,
                    reason: 'Sync from repo @ ' + COMMIT + ' (' + new Date().toISOString().slice(0, 10) + ')'
                });
                updated += 1;
                console.log('[update] ' + (i + 1) + '/' + all.length + ' ' + entry.file + ' (id=' + existing.id + ')');
            } else {
                var res = await callTool('create_knowledge_doc', {
                    title: title,
                    body: content,
                    content_type: 'markdown',
                    project_id: 3,
                    tags: tags
                });
                created += 1;
                var newId = (res && res.id) ? res.id : '?';
                console.log('[create] ' + (i + 1) + '/' + all.length + ' ' + entry.file + ' (id=' + newId + ')');
            }
        } catch (e) {
            failed.push({ file: entry.file, reason: e.message });
            console.log('[ERROR ] ' + entry.file + ': ' + e.message);
        }
    }

    console.log('');
    console.log('[done] created=' + created + ' updated=' + updated + ' failed=' + failed.length);
    if (failed.length) console.log('[failed]', JSON.stringify(failed, null, 2));
    if (skipped.length) console.log('[note]  files without topic tags:', skipped.map(function(s) { return s.file; }).join(', '));

    // Emit summary JSON for the parent agent to consume
    console.log('---SUMMARY-JSON---');
    console.log(JSON.stringify({
        commit: COMMIT,
        total: all.length,
        created: created,
        updated: updated,
        failed: failed,
        skipped: skipped
    }));

    // Non-zero on any failure, so nothing driving this can read a partial sync
    // as a finished one.
    if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(function(e) {
        console.error('FATAL:', e.message);
        console.error(e.stack);
        process.exit(1);
    });
}
