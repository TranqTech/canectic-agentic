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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var MCP_URL = process.env.MCP_URL || 'http://janus.lan:3000/mcp';
var REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var COMMIT = process.argv[2] || 'unknown';

var sessionId = null;
var rpcId = 0;

async function rpc(method, params) {
    rpcId += 1;
    var headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    var res = await fetch(MCP_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: method, params: params })
    });

    var sid = res.headers.get('mcp-session-id');
    if (sid && !sessionId) sessionId = sid;

    var text = await res.text();
    // SSE response: parse `data: {...}` line
    var dataLine = text.split('\n').find(function(l) { return l.startsWith('data: '); });
    if (!dataLine) {
        // Maybe plain JSON
        if (text.trim().startsWith('{')) return JSON.parse(text);
        return null;
    }
    var payload = JSON.parse(dataLine.slice(6));
    if (payload.error) {
        throw new Error(method + ' failed: ' + JSON.stringify(payload.error));
    }
    return payload.result;
}

async function notify(method, params) {
    rpcId += 1;
    var headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    await fetch(MCP_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: method, params: params })
    });
}

async function callTool(name, args) {
    var result = await rpc('tools/call', { name: name, arguments: args });
    if (result && result.content && result.content[0] && result.content[0].type === 'text') {
        var t = result.content[0].text;
        try { return JSON.parse(t); } catch (e) { return t; }
    }
    return result;
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
    'MAILER_ARCHITECTURE.md':       ['networking', 'ftn', 'mailer', 'binkp', 'architecture'],
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
    'THEMES.md':                    ['themes', 'configuration'],
    'API.md':                       ['api', 'authentication'],
    'MAIL.md':                      ['mail', 'smtp', 'imap'],
    'TEMPLATES.md':                 ['templates', 'notifications'],
    'NETMAIL_ROUTES.md':            ['netmail', 'ftn', 'routing', 'configuration'],
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
                    reason: 'Sync from repo @ ' + COMMIT + ' (2026-04-10)'
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
}

main().catch(function(e) {
    console.error('FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
});
