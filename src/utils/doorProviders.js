// doorProviders.js -- open a caller's session on a door provider (#89).
//
// Every kind returns the same event interface, so RemoteDoorRunner does not
// care which it has:
//
//   events   'auth_ok' (doors, collections)   Canectic only: its door list
//            'launch_ok' (door)               the door's screen follows
//            'data' (Buffer)                  output for the caller
//            'auth_fail' (reason), 'error' (reason), 'error_frame' (reason)
//            'close'
//   methods  send(Buffer), launch(slug) (Canectic only), close()
//   kind     the provider's kind; `cp437` is true when the output is CP437
//            whatever the caller's terminal, so a UTF-8 caller needs it
//            converted (RLogin and BBSLink door servers send CP437)
//
// opts: { user: {name, real_name, id, number}, term: {width, height,
// encoding, type}, door: code or '', identity: {name, password} (RLogin) }.

import { EventEmitter } from 'events';
import { openSession as openCanectic } from './doorserverClient.js';
import { settingsOf, secretsOf } from '../models/doorserverRemotes.js';

function failing(kind, reason) {
	var ev = new EventEmitter();
	ev.kind = kind;
	ev.send = function () {};
	ev.launch = function () {};
	ev.close = function () {};
	setImmediate(function () { ev.emit('error', reason); ev.emit('close'); });
	return ev;
}

/**
 * Open a session for one caller. deps: { rlogin, bbslink } factories, for
 * tests; each defaults to the real client.
 */
async function openProviderSession(remote, opts, deps) {
	var kind = (remote && remote.kind) || 'canectic';
	var d = deps || {};
	if (kind === 'canectic') {
		var s = openCanectic({
			url: remote.url, systemId: remote.system_id, secret: remote.secret,
			user: { name: opts.user.name, real_name: opts.user.real_name }, term: opts.term, door: opts.door || undefined
		});
		s.kind = 'canectic';
		s.cp437 = false;
		return s;
	}
	var settings = settingsOf(remote), secrets = secretsOf(remote);
	if (kind === 'rlogin') {
		var rl = d.rlogin || (await import('./rloginClient.js')).openRlogin;
		return rl(remote, settings, secrets, opts);
	}
	if (kind === 'bbslink') {
		var bl = d.bbslink || (await import('./bbslinkClient.js')).openBbslink;
		return bl(remote, settings, secrets, opts);
	}
	return failing(kind, 'unknown kind of door provider: ' + kind);
}

export { openProviderSession, failing };
