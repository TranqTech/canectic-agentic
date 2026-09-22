// A browser tab left open on the board, as far as the web port can tell:
// it keeps its presence WebSocket open, reconnects every second when it drops,
// and polls the update progress page like the page's own script does.
// Browsers reset connections they give up on, so every refused upgrade is
// dropped with a TCP reset, the thing that killed the hub's updater.
//   node webtab.mjs [cookiefile]     logs to ~/rehearsal/webtab.log
import net from 'net';
import fs from 'fs';
var HOME = process.env.HOME;
var log = fs.createWriteStream(HOME + '/rehearsal/webtab.log');
var t0 = Date.now();
function say(m) { log.write(new Date().toISOString().slice(11, 19) + ' +' + ((Date.now() - t0) / 1000).toFixed(0) + 's ' + m + '\n'); }
var jar = fs.readFileSync(process.argv[2] || HOME + '/rehearsal/cookies.txt', 'utf8');
var sid = (jar.match(/\tsessionid\t(\S+)/) || [])[1] || '';
var counts = {};
function count(k) { counts[k] = (counts[k] || 0) + 1; }

function presence() {
	var s = net.connect(8080, '127.0.0.1');
	var got = '', upgraded = false;
	s.on('connect', function () {
		s.write('GET /ws/presence HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
			'Origin: http://127.0.0.1:8080\r\nCookie: sessionid=' + sid + '\r\n\r\n');
	});
	s.on('data', function (d) {
		if (upgraded) return;
		got += d.toString('latin1');
		var line = got.split('\r\n')[0];
		if (/^HTTP\/1\.1 101/.test(line)) { upgraded = true; count('ws open'); return; }
		if (line) { count('ws refused: ' + line.slice(9, 12)); s.resetAndDestroy(); }
	});
	s.on('error', function (e) { count('ws error: ' + e.code); });
	s.on('close', function () { setTimeout(presence, 1000); });
}

function poll() {
	var s = net.connect(8080, '127.0.0.1');
	var got = '';
	s.setTimeout(3000, function () { count('poll timeout'); s.destroy(); });
	s.on('connect', function () {
		s.write('GET /admin/update/progress.json HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nCookie: sessionid=' + sid + '\r\nConnection: close\r\n\r\n');
	});
	s.on('data', function (d) { got += d.toString('latin1'); });
	s.on('error', function (e) { count('poll error: ' + e.code); });
	s.on('close', function () {
		var status = (got.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 'none';
		var served = (got.match(/"servedBy":"(\w+)"/) || [])[1] || '-';
		count('poll ' + status + ' ' + served);
		setTimeout(poll, 2000);
	});
}

setInterval(function () { say(JSON.stringify(counts)); counts = {}; }, 5000);
say('webtab started, session ' + (sid ? 'present' : 'MISSING'));
presence();
poll();
setTimeout(function () { say('stopping after 15 minutes'); process.exit(0); }, 900000);
