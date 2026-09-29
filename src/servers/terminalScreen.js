// terminalScreen.js -- screen a terminal connection before it gets a node.
//
// Port 23 draws a stream of IoT scanners: they connect, wait for a login
// prompt and send router credentials (root, admin, enable, sh, busybox...).
// Every one of them used to get a node, a caller log line, terminal
// negotiation and a login handler. Now a new TCP or Telnet connection is
// screened first, where the maintenance refusal sits, and only a caller who
// passes is handed to the call pool:
//
//   1. We ask for the cursor position (ESC [ 6 n). A real terminal answers
//      at once, so an ordinary caller passes without seeing anything.
//   2. If nothing answers within PROMPT_AFTER_MS, we print the prompt
//      ("Press ESC twice to continue.") for clients that cannot answer.
//      Two ESC presses pass.
//   3. A connection whose first line is a known bot login or command is
//      dropped at once and reported as a honeypot attempt, which the
//      shipped fail2ban honeypot filter already matches.
//   4. Anything else that does neither before the timeout is dropped.
//
// Pure apart from the timers and the callbacks, so it is tested without
// sockets.

var PROMPT_AFTER_MS = 1500;
var MAX_BUFFER = 512;

// Commands and probes scanners send; usernames come from honeypot_usernames.
var DEFAULT_BOT_WORDS = [
	'enable', 'system', 'shell', 'sh', 'linuxshell', 'bash', 'busybox', '/bin/busybox', 'ping ;sh', 'cat /proc/mounts',
	'cd /tmp', 'ubnt', 'support', 'default', 'supervisor', 'service', 'guest', 'telnetadmin', 'e8telnet', 'e8ehome', 'zte',
	'hikvision', 'daemon', 'mother', 'vizxv', 'xc3511', 'anko', '888888', '666666', '123456', '12345', '1234', 'password', 'pass'
];

// Probes that are never a person at a terminal.
var BOT_PATTERNS = [
	/\/bin\/busybox/i, /\bwget\s+http/i, /\btftp\s+-/i, /\bcurl\s+http/i, /\/bin\/sh\b/i, /\bchmod\s+[0-7]{3}/i,
	/^(GET|POST|HEAD|OPTIONS|CONNECT) \S+ HTTP\/\d/i, /^SSH-\d\.\d/, /^\x16\x03[\x00-\x04]/
];

// ESC bytes that are not part of a complete key or report sequence
// (CSI ... final, SS3 x). Recounted from the whole buffer each time, so a
// sequence split across packets is not taken for a key press.
function bareEscapes(text) {
	var stripped = String(text).replace(/\x1b\[[0-9;?]*[@-~]/g, '').replace(/\x1bO[@-~]/g, '');
	var n = 0;
	for (var i = 0; i < stripped.length; i++) {
		if (stripped.charCodeAt(i) !== 27) continue;
		// A lone ESC at the very end may be the start of a sequence still arriving
		if (i === stripped.length - 1 && n === 0) break;
		n++;
	}
	return n;
}

function lowerSet(list) {
	var s = new Set();
	for (var w of list || []) { var t = String(w).trim().toLowerCase(); if (t) s.add(t); }
	return s;
}

/**
 * Whether a line a connection sent before passing is a bot's.
 * returns the reason, or '' for a line that is not recognised.
 */
function botReason(line, words) {
	var raw = String(line || '');
	for (var p of BOT_PATTERNS) if (p.test(raw)) return 'sent ' + JSON.stringify(raw.slice(0, 40));
	var t = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().toLowerCase();
	if (!t) return '';
	if (words.has(t)) return 'sent ' + JSON.stringify(t.slice(0, 40));
	var first = t.split(/\s+/)[0];
	if (first.length >= 2 && words.has(first) && /^[a-z0-9_.\/-]+$/.test(first)) return 'sent ' + JSON.stringify(t.slice(0, 40));
	return '';
}

/**
 * opts: { send(text), onPass(), onBot(reason, line), onTimeout(),
 *         timeoutMs, prompt, botWords (array; honeypot names + the defaults) }
 * returns { start(), feed(Buffer|string), stop(), passed(), finished() }
 */
function createScreen(opts) {
	var words = lowerSet((opts.botWords || []).concat(DEFAULT_BOT_WORDS));
	var buf = '';
	var done = false, promptShown = false, hinted = false;
	var timers = [];
	var prompt = opts.prompt || 'Press ESC twice to continue.';

	function later(ms, fn) { var t = setTimeout(fn, ms); timers.push(t); return t; }
	function stop() { for (var t of timers) clearTimeout(t); timers = []; }
	function finish(fn, a, b) {
		if (done) return;
		done = true;
		stop();
		fn(a, b);
	}
	function pass() {
		// Take the prompt off the line if it was shown
		if (promptShown) opts.send('\r\x1b[K');
		finish(opts.onPass);
	}

	function feed(data) {
		if (done) return;
		buf += Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
		if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
		// 1. A cursor position report, from any ANSI terminal
		if (/\x1b\[\d{1,4};\d{1,4}R/.test(buf)) { pass(); return; }
		// 2. ESC pressed twice (not the start of a report or a key sequence)
		if (bareEscapes(buf) >= 2) { pass(); return; }
		// 3. Complete lines: a bot's credentials or commands
		var lines = buf.split(/\r\n|\r|\n/);
		var complete = lines.slice(0, -1);
		for (var line of complete) {
			var why = botReason(line, words);
			if (why) { finish(opts.onBot, why, line); return; }
		}
		// A binary probe (TLS hello) never ends a line
		if (/^\x16\x03[\x00-\x04]/.test(buf)) { finish(opts.onBot, 'sent a TLS handshake', ''); return; }
		if (complete.length && !hinted && promptShown) {
			hinted = true;
			opts.send('\r\n' + prompt + ' ');
		}
		buf = lines[lines.length - 1];
	}

	return {
		start: function () {
			opts.send('\x1b[6n');
			later(PROMPT_AFTER_MS, function () {
				if (done) return;
				promptShown = true;
				opts.send('\r\n' + prompt + ' ');
			});
			later(Math.max(opts.timeoutMs || 15000, PROMPT_AFTER_MS + 1000), function () { finish(opts.onTimeout); });
		},
		feed: feed,
		stop: function () { done = true; stop(); },
		passed: function () { return done; },
		finished: function () { return done; }
	};
}

export { createScreen, botReason, bareEscapes, DEFAULT_BOT_WORDS, PROMPT_AFTER_MS };
