// A terminal caller that stays connected and records what it is sent.
import net from 'net';
import fs from 'fs';
var log = fs.createWriteStream(process.env.HOME + '/rehearsal/caller.log');
var t0 = Date.now();
function say(m) { log.write(((Date.now() - t0) / 1000).toFixed(1) + 's ' + m + '\n'); }
var s = net.connect(2023, '127.0.0.1', function () { say('connected'); });
var notices = 0;
s.on('data', function (d) {
	var raw = d.toString('latin1');
	if (/\x1b\[6n/.test(raw)) s.write('\x1b[24;80R');
	if (/\x1b\[s\x1b\[\d+;1H/.test(raw)) { notices++; say('bottom-line notice #' + notices); }
	var text = raw.replace(/\xff[\xfb-\xfe]./g, '').replace(/\x1b\[[0-9;?!]*[A-Za-z]/g, '');
	for (var line of text.split(/\r?\n/)) if (/maintenance/i.test(line)) say('saw: ' + line.trim().substring(0, 140));
});
s.on('close', function () { say('disconnected'); log.end(); setTimeout(function () { process.exit(0); }, 100); });
setTimeout(function () { say('still connected after 10 minutes'); process.exit(1); }, 600000);
