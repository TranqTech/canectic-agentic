// processEscape.js -- get the updater out of the process tree that launched it.
//
// An update started from the Admin UI is launched by the gateway, and the first
// thing the update does is `pm2 stop all`. pm2 stops an app with treekill,
// which is on by default: it finds every descendant of the app by walking
// parent pids, and kills them all. `detached: true` gives the updater its own
// process group and session, but its parent is still the gateway, so it is
// still a descendant, and it died at the stop phase with the pm2 client it was
// running. That was the unexplained failure on the hub: gateway and mail
// stopped, mailer and worker untouched (the client was killed partway through
// its loop), no updater, the run file frozen at `stop`. An update started from
// a shell survived only because its parent was the shell.
//
// The fix is the classic one: the updater starts a copy of itself, detached,
// and exits. The copy's parent is gone, so it is reparented to init (or the
// nearest subreaper), and it is no longer anybody's descendant. It lives in the
// NEW release's updater rather than the launcher, so it works however the
// updater was launched, including by an older release's handoff that knows
// nothing about it.
//
// NODE BUILTINS ONLY: the updater cannot rely on node_modules.

import { spawn } from 'child_process';

var MARK = 'CANECTIC_UPDATER_ESCAPED';

/** Has this process already escaped? */
function hasEscaped(env) {
	return (env || process.env)[MARK] === '1';
}

/**
 * Relaunch this script, detached, as a process nobody is the parent of.
 * Returns the child's pid; the caller should exit straight away after.
 *
 * stdout and stderr are inherited, which matters: the launcher pointed them at
 * the update's log file, and the copy must keep writing there.
 *
 * @param {object} [opts]  { argv, execArgv, execPath, env, cwd, spawnFn } for tests
 */
function escapeProcessTree(opts) {
	var o = opts || {};
	var argv = o.argv || process.argv;
	var execArgv = o.execArgv || process.execArgv;
	var env = Object.assign({}, o.env || process.env);
	env[MARK] = '1';
	var child = (o.spawnFn || spawn)(o.execPath || process.execPath, execArgv.concat(argv.slice(1)), {
		detached: true,
		stdio: ['ignore', 'inherit', 'inherit'],
		cwd: o.cwd || process.cwd(),
		env: env
	});
	if (child && typeof child.unref === 'function') child.unref();
	return child ? child.pid : null;
}

export {
	MARK,
	hasEscaped,
	escapeProcessTree
};
