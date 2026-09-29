// rloginClient.js -- a caller's session on an RLogin door server, directly or
// through an SSH tunnel (#89: DoorParty, Synchronet game servers).
//
// RFC 1282: the client sends "\0<client-user>\0<server-user>\0<terminal>\0"
// and the server answers with one "\0", after which the connection is the
// terminal stream. Door-server convention for the three fields:
//
//   client-user   a password: one per caller, made here and kept for ever
//                 (identityFor), or one the sysop sets for every caller
//   server-user   the username template with {alias} and {tag} filled in
//                 (DoorParty: "[TAG]alias")
//   terminal      the door code through the terminal template ("{door}", or
//                 "xtrn={door}" for Synchronet), or the menu terminal type
//                 when no door is named, which lands on the server's menu
//
// Through SSH (DoorParty): log in with the sysop's SSH credentials, open a
// direct-tcpip channel to the RLogin host and port, and speak RLogin in it.
// The server's host key is recorded on first connect and a different key is
// refused afterwards (the Forget button on the provider page resets it).
// DoorParty's own connector accepts any key.
//
// Output is CP437 (`cp437: true`), converted for a UTF-8 caller by the runner.

import { EventEmitter } from 'events';
import net from 'net';
import crypto from 'crypto';

var CONNECT_TIMEOUT_MS = 20000;

/** The three handshake fields. Pure. */
function handshakeFields(settings, identity, door) {
	var serverUser = String(settings.username_template || '{alias}')
		.split('{tag}').join(settings.tag || '')
		.split('{alias}').join(identity.name);
	var terminal = door ? String(settings.terminal_template || '{door}').split('{door}').join(door) : (settings.menu_terminal || 'ansi');
	return { clientUser: identity.password || '', serverUser: serverUser, terminal: terminal };
}

function handshakeBytes(f) {
	return Buffer.from('\0' + f.clientUser + '\0' + f.serverUser + '\0' + f.terminal + '\0', 'latin1');
}

/** OpenSSH-style SHA256 fingerprint of a raw host key. */
function fingerprint(keyBuffer) {
	return 'SHA256:' + crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
}

/**
 * Open a session. deps (tests): { identityFor(remote, user), setHostKey(uuid, fp),
 * SshClient, connect(port, host) }.
 */
async function openRlogin(remote, settings, secrets, opts, deps) {
	var d = deps || {};
	var ev = new EventEmitter();
	ev.kind = 'rlogin';
	ev.cp437 = true;
	var closed = false, streaming = false, awaitingAck = true;
	var stream = null, ssh = null;

	var finish = function () {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		try { if (stream) stream.end(); } catch (_) {}
		try { if (ssh) ssh.end(); } catch (_) {}
		ev.emit('close');
	};
	var fail = function (reason) {
		if (closed) return;
		ev.emit('error', reason);
		finish();
	};
	ev.send = function (buf) { if (streaming && stream && !closed) stream.write(buf); };
	ev.launch = function () {};
	ev.close = finish;
	var timer = setTimeout(function () { if (!streaming) fail('no answer from ' + (settings.ssh ? settings.ssh_host : settings.host)); }, CONNECT_TIMEOUT_MS);

	var identity;
	try {
		var idFor = d.identityFor || (await import('../models/doorserverRemotes.js')).identityFor;
		identity = await idFor(remote, opts.user);
	} catch (err) {
		setImmediate(function () { fail(err.message || String(err)); });
		return ev;
	}
	var fields = handshakeFields(settings, identity, opts.door);

	var attach = function (s) {
		stream = s;
		s.on('data', function (chunk) {
			if (closed) return;
			var buf = Buffer.from(chunk);
			if (awaitingAck) {
				awaitingAck = false;
				// The server's "\0" acknowledgement, then the stream
				if (buf[0] === 0) buf = buf.subarray(1);
				streaming = true;
				clearTimeout(timer);
				ev.emit('launch_ok', opts.door || '');
			}
			if (buf.length) ev.emit('data', buf);
		});
		s.on('close', finish);
		s.on('end', finish);
		s.on('error', function (err) { fail(err.message || String(err)); });
		s.write(handshakeBytes(fields));
	};

	if (!settings.ssh) {
		var sock = (d.connect || function (port, host) { return net.connect(port, host); })(settings.port || 513, settings.host);
		sock.once('connect', function () { attach(sock); });
		sock.on('error', function (err) { if (!stream) fail('cannot reach ' + settings.host + ': ' + (err.code || err.message)); });
		return ev;
	}

	var SshClient = d.SshClient || (await import('ssh2')).Client;
	var setHostKey = d.setHostKey || (await import('../models/doorserverRemotes.js')).setHostKey;
	ssh = new SshClient();
	var keyProblem = null;
	ssh.on('ready', function () {
		ssh.forwardOut('127.0.0.1', 0, settings.host, settings.port || 513, function (err, ch) {
			if (err) { fail('the SSH server would not open the RLogin connection: ' + err.message); return; }
			attach(ch);
		});
	});
	ssh.on('error', function (err) {
		fail(keyProblem || ('SSH to ' + settings.ssh_host + ' failed: ' + (err.level === 'client-authentication' ? 'the SSH username or password was refused' : (err.code || err.message))));
	});
	ssh.on('close', function () { if (!stream) fail(keyProblem || 'the SSH connection closed'); });
	ssh.connect({
		host: settings.ssh_host || settings.host, port: settings.ssh_port || 22,
		username: settings.ssh_user, password: secrets.ssh_password || '',
		readyTimeout: CONNECT_TIMEOUT_MS,
		hostVerifier: function (key) {
			var fp = fingerprint(key);
			if (!remote.host_key) {
				Promise.resolve(setHostKey(remote.uuid, fp)).catch(function () {});
				remote.host_key = fp;
				return true;
			}
			if (remote.host_key === fp) return true;
			keyProblem = 'the SSH server for ' + (remote.title || remote.name) + ' presented a different host key (' + fp + ', recorded ' +
				remote.host_key + '). If the server really changed its key, forget the recorded one on the provider page.';
			return false;
		}
	});
	return ev;
}

export { openRlogin, handshakeFields, handshakeBytes, fingerprint };
