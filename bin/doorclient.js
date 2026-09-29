#!/usr/bin/env node
// doorclient.js -- connect a BBS caller to a Canectic door server (#86).
//
// For sysops of other BBS software: run this as a standard-I/O door. It reads
// the caller's name from the drop file your BBS writes, connects to the door
// server over WebSocket (canectic-doorserver/1, see DOORSERVER_DESIGN.md in
// the Canectic source), and passes the caller's keys and the door's screen
// back and forth until the door ends.
//
// One file, no packages: it needs Node 22 or later, for the built-in
// WebSocket, and nothing else. Copy it anywhere.
//
//   node doorclient.js --server wss://board.example/ws/doorserver \
//     --system MYBBS --secret-file /path/to/secret --dropfile %f [--door lord]
//
//   --server URL        the door server's address (ws:// or wss://)
//   --system ID         your System ID on that door server
//   --secret S          your secret; prefer --secret-file, which keeps it out
//   --secret-file PATH  of the process list
//   --dropfile PATH     DOOR32.SYS or DOOR.SYS for the caller's name
//   --user NAME         or give the name directly (--real-name for the other)
//   --door SLUG         the door to run; without it the caller picks from a list
//   --encoding E        cp437 (default) or utf8, what the caller's terminal uses
//   --width N --height N  the caller's screen (default 80x25)
//   --list              print the doors on offer and exit (for setting up)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

var PROTOCOL = 'canectic-doorserver/1';

// ---------------------------------------------------------------------------
// Arguments and drop files (pure, tested)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	var out = { encoding: 'cp437', width: 80, height: 25, list: false };
	for (var i = 0; i < argv.length; i++) {
		var a = argv[i];
		var next = function () { return argv[++i]; };
		if (a === '--server') out.server = next();
		else if (a === '--system') out.system = next();
		else if (a === '--secret') out.secret = next();
		else if (a === '--secret-file') out.secretFile = next();
		else if (a === '--dropfile') out.dropfile = next();
		else if (a === '--user') out.user = next();
		else if (a === '--real-name') out.realName = next();
		else if (a === '--door') out.door = next();
		else if (a === '--encoding') out.encoding = String(next() || '').toLowerCase();
		else if (a === '--width') out.width = parseInt(next()) || 80;
		else if (a === '--height') out.height = parseInt(next()) || 25;
		else if (a === '--list') out.list = true;
		else if (a === '--help' || a === '-h') out.help = true;
		else throw new Error('unknown option ' + a);
	}
	return out;
}

/**
 * The caller from a drop file's text. DOOR32.SYS: line 6 real name, line 7
 * handle, line 10 emulation (1 ANSI, 4 UTF-8 in some software). DOOR.SYS:
 * line 10 full name, line 36 alias. Returns { name, real_name, utf8 }.
 */
function readDropfile(text, fileName) {
	var lines = String(text || '').split(/\r\n|\r|\n/);
	var at = function (n) { return (lines[n - 1] || '').trim(); };
	var base = path.basename(String(fileName || '')).toUpperCase();
	if (base === 'DOOR32.SYS' || (!base.startsWith('DOOR.') && lines.length < 20)) {
		return { name: at(7) || at(6), real_name: at(6) || at(7), utf8: at(10) === '4' };
	}
	return { name: at(36) || at(10), real_name: at(10) || at(36), utf8: false };
}

/** Everything wrong with the options, at once. */
function problems(o) {
	var out = [];
	if (!o.server || !/^wss?:\/\//i.test(o.server)) out.push('--server must be a ws:// or wss:// address');
	if (!o.system) out.push('--system is required');
	if (!o.secret && !o.secretFile) out.push('--secret or --secret-file is required');
	if (!o.list && !o.user && !o.dropfile) out.push('--dropfile or --user is required');
	if (o.encoding !== 'cp437' && o.encoding !== 'utf8') out.push('--encoding must be cp437 or utf8');
	return out;
}

/** Split JSON lines off the front of text; returns { frames, rest }. */
function takeJsonLines(text) {
	var frames = [];
	var rest = text;
	for (;;) {
		var nl = rest.indexOf('\n');
		if (nl === -1) break;
		var line = rest.slice(0, nl).trim();
		if (!line.startsWith('{')) break;
		try { frames.push(JSON.parse(line)); } catch (_) { break; }
		rest = rest.slice(nl + 1);
	}
	return { frames: frames, rest: rest };
}

// ---------------------------------------------------------------------------
// The door menu
// ---------------------------------------------------------------------------

/**
 * The numbered door menu shown when no door is named. With more than one
 * collection it has two levels, the collections and then the doors in the
 * one chosen; otherwise it is the door list. The one definition: the RLogin
 * wrapper and Canectic's own remote door runner import it from here, so this
 * file can stay a single file with no dependencies.
 *
 *   doors        [{slug, name}]
 *   collections  [{slug, name, doors: [slug...]}] (optional; auth_ok since #89)
 *   title        the server's name, for the headings
 *   quitWord     "quit" or "go back", for the top level's prompt
 *   write(text)  output; onPick(slug); onQuit()
 *
 * returns { start(), key(ch) }; key() takes one character at a time.
 */
function createDoorMenu(opts) {
	var doors = opts.doors || [];
	var bySlug = {};
	for (var d of doors) bySlug[d.slug] = d;
	var groups = (opts.collections || []).map(function (c) {
		return { name: c.name, doors: (c.doors || []).map(function (slug) { return bySlug[slug]; }).filter(Boolean) };
	}).filter(function (g) { return g.doors.length; });
	var twoLevel = groups.length > 1;
	var where = opts.title ? ' on ' + opts.title : ' on this server';
	var top = 'Q to ' + (opts.quitWord || 'quit');
	var level = twoLevel ? 'collections' : 'doors';
	var list = twoLevel ? null : doors;
	var typed = '';
	var write = opts.write;

	function prompt() {
		write('\r\nChoose a number (' + (level === 'doors' && twoLevel ? 'Q to go back' : top) + '): ');
	}
	function show() {
		typed = '';
		if (level === 'collections') {
			write('\r\nDoor collections' + where + ':\r\n\r\n');
			groups.forEach(function (g, n) { write('  ' + String(n + 1).padStart(2) + ') ' + g.name + ' (' + g.doors.length + ')\r\n'); });
		} else {
			write('\r\n' + (twoLevel ? list.heading : 'Doors' + where) + ':\r\n\r\n');
			list.forEach(function (x, n) { write('  ' + String(n + 1).padStart(2) + ') ' + x.name + '\r\n'); });
		}
		prompt();
	}
	function key(ch) {
		if (ch === 'q' || ch === 'Q') {
			if (level === 'doors' && twoLevel) { level = 'collections'; show(); return; }
			write('\r\n');
			opts.onQuit();
			return;
		}
		if (ch === '\r' || ch === '\n') {
			var n = parseInt(typed); typed = '';
			if (level === 'collections') {
				var g = groups[n - 1];
				if (!g) { prompt(); return; }
				list = g.doors.slice();
				list.heading = g.name;
				level = 'doors';
				write('\r\n');
				show();
				return;
			}
			var pick = list[n - 1];
			if (!pick) { prompt(); return; }
			write('\r\n');
			opts.onPick(pick.slug);
			return;
		}
		if (/[0-9]/.test(ch) && typed.length < 3) { typed += ch; write(ch); }
	}
	return { start: show, key: key };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function run(o, io) {
	var stdin = io.stdin, stdout = io.stdout, stderr = io.stderr;
	return new Promise(function (resolve) {
		var secret = o.secret || fs.readFileSync(o.secretFile, 'utf8').trim();
		var who = { name: o.user, real_name: o.realName || o.user };
		var utf8 = o.encoding === 'utf8';
		if (o.dropfile) {
			var d = readDropfile(fs.readFileSync(o.dropfile, 'latin1'), o.dropfile);
			who = { name: o.user || d.name, real_name: o.realName || d.real_name };
			if (d.utf8 && o.encoding === 'cp437' && !o.encodingGiven) utf8 = true;
		}

		// Node's built-in client (22+), named through globalThis so it is plain
		// that it is not an import that went missing.
		var ws = new globalThis.WebSocket(o.server);
		ws.binaryType = 'arraybuffer';
		var streaming = false, pending = '', doors = [], choosing = false, menu = null;
		var say = function (s) { stdout.write(s); };

		var finish = function (code) {
			try { ws.close(); } catch (_) {}
			stdin.removeAllListeners('data');
			if (stdin.pause) stdin.pause();
			resolve(code);
		};

		ws.onerror = function () { stderr.write('doorclient: cannot reach ' + o.server + '\n'); finish(2); };
		ws.onclose = function () { finish(0); };

		ws.onmessage = function (ev) {
			var buf = Buffer.from(typeof ev.data === 'string' ? Buffer.from(ev.data, 'utf8') : new Uint8Array(ev.data));
			if (streaming) { stdout.write(buf); return; }
			var parsed = takeJsonLines(pending + buf.toString('latin1'));
			pending = parsed.rest;
			for (var f of parsed.frames) {
				if (f.type === 'hello') {
					ws.send(JSON.stringify({
						type: 'auth', system_id: o.system, secret: secret, user: who,
						door: o.door || undefined, list: o.list || undefined,
						term: { width: o.width, height: o.height, encoding: utf8 ? 'utf8' : 'cp437', type: 'ansi' }
					}));
				} else if (f.type === 'auth_fail') {
					stderr.write('doorclient: refused: ' + f.reason + '\n');
					say('\r\nThe door server refused the connection: ' + f.reason + '\r\n');
				} else if (f.type === 'auth_ok') {
					doors = f.doors || [];
					if (o.list) {
						for (var d2 of doors) say(d2.slug + '\t' + d2.name + '\n');
					} else if (!o.door) {
						choosing = true;
						menu = createDoorMenu({
							doors: doors, collections: f.collections, write: say,
							onPick: function (slug) { choosing = false; ws.send(JSON.stringify({ type: 'launch', door: slug })); },
							onQuit: function () { choosing = false; finish(0); }
						});
						menu.start();
					}
				} else if (f.type === 'launch_ok') {
					streaming = true; choosing = false;
					if (pending) { stdout.write(Buffer.from(pending, 'latin1')); pending = ''; }
				} else if (f.type === 'error') {
					say('\r\n' + f.reason + '\r\n');
				}
			}
			// Anything left that is not a JSON line is already the door's screen,
			// except in --list mode, whose output is only the list.
			if (!streaming && pending && !pending.startsWith('{')) {
				if (!o.list) stdout.write(Buffer.from(pending, 'latin1'));
				pending = '';
			}
		};

		stdin.on('data', function (chunk) {
			if (streaming) { if (ws.readyState === 1) ws.send(chunk); return; }
			if (!choosing) return;
			for (var ch of chunk.toString('latin1')) {
				menu.key(ch);
				if (!choosing) return;
			}
		});
		if (stdin.setRawMode && stdin.isTTY) stdin.setRawMode(true);
		stdin.resume();
	});
}

async function main(argv) {
	var o;
	try { o = parseArgs(argv); } catch (e) { process.stderr.write('doorclient: ' + e.message + '\n'); return 2; }
	o.encodingGiven = argv.indexOf('--encoding') !== -1;
	if (o.help) { process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 27).map(function (l) { return l.replace(/^\/\/ ?/, ''); }).join('\n') + '\n'); return 0; }
	var bad = problems(o);
	if (bad.length) { process.stderr.write('doorclient: ' + bad.join('; ') + '\n'); return 2; }
	if (typeof globalThis.WebSocket !== 'function') { process.stderr.write('doorclient: needs Node 22 or later (built-in WebSocket)\n'); return 2; }
	return await run(o, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	main(process.argv.slice(2)).then(function (code) { process.exit(code || 0); });
}

export { parseArgs, readDropfile, problems, takeJsonLines, createDoorMenu, run, PROTOCOL };
