// updateProgress.js -- what a sysop sees while an update runs, and what
// everybody else sees while the BBS is stopped for it.
//
// One renderer, two servers. The gateway serves /admin/update/progress while
// it is up (the drain, and again after the restart), and the updater's own
// listener serves the same page for the stretch in between, when the gateway
// is stopped and the updater has taken over its port (updateStatusServer.js).
// A sysop watching the page sees one continuous account rather than a page
// that dies at the stop.
//
// The page polls /admin/update/progress and swaps its content in, so it keeps
// working whichever server answers. When nothing answers (the few seconds
// between the updater letting go of the port and the gateway taking it back),
// it says the BBS is restarting and keeps trying.
//
// NODE BUILTINS ONLY. The updater's listener renders with this while the
// dependencies phase is replacing node_modules underneath it, so anything it
// imported from there could be half written. tests/installPath.test.js holds
// it to that.

import * as crypto from 'crypto';
import * as fs from 'fs';

var PHASE_LABELS = {
	preflight:    'Checking the release',
	backup:       'Backing up the files it replaces',
	stop:         'Draining and stopping the BBS',
	files:        'Writing the new files',
	directories:  'Creating directories',
	env:          'Checking settings',
	dependencies: 'Installing packages',
	schema:       'Backing up and migrating the database',
	migrations:   'Data migrations',
	steps:        'Upgrade steps',
	start:        'Starting the BBS',
	verify:       'Checking every file it wrote'
};

var LOG_LINES = 40;

function esc(value) {
	return String(value === null || value === undefined ? '' : value)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** SHA-256 of a session id, so the listener never holds the id itself. */
function hashSessionId(id) {
	return crypto.createHash('sha256').update(String(id)).digest('hex');
}

/** Cookie header to {name: value}. Pure. */
function parseCookies(header) {
	var out = {};
	String(header || '').split(';').forEach(function (part) {
		var i = part.indexOf('=');
		if (i < 1) return;
		var name = part.substring(0, i).trim();
		var value = part.substring(i + 1).trim();
		try { value = decodeURIComponent(value); } catch (_) {}
		if (!(name in out)) out[name] = value;
	});
	return out;
}

/** The last `n` lines of a file, or [] if it cannot be read. */
function tailFile(file, n) {
	if (!file) return [];
	try {
		var text = fs.readFileSync(file, 'utf8');
		var lines = text.split('\n').filter(function (l) { return l.length; });
		return lines.slice(-(n || LOG_LINES));
	} catch (_) {
		return [];
	}
}

/**
 * What the page shows, from a run state. Pure.
 *
 * @param {object} state      the run state (updatePhases), or null
 * @param {object} [extra]    { log: [lines], drain, servedBy: 'updater'|'gateway', boardName }
 */
function progressSnapshot(state, extra) {
	var x = extra || {};
	if (!state) {
		return { runId: null, status: 'none', phases: [], warnings: [], notices: [], log: [], drain: null,
			servedBy: x.servedBy || 'gateway', boardName: x.boardName || null };
	}
	var phases = (state.phases || [])
		.filter(function (p) { return p.intended !== false || p.status !== 'pending'; })
		.map(function (p) {
			return {
				name:       p.name,
				label:      PHASE_LABELS[p.name] || p.name,
				status:     p.status,
				detail:     p.detail || null,
				error:      p.error || null,
				startedAt:  p.startedAt || null,
				finishedAt: p.finishedAt || null
			};
		});
	var running = phases.filter(function (p) { return p.status === 'running'; })[0];
	return {
		runId:      state.runId,
		from:       state.from || null,
		to:         state.to || null,
		status:     state.status,
		startedAt:  state.startedAt || null,
		finishedAt: state.finishedAt || null,
		error:      state.error || null,
		warnings:   (state.warnings || []).slice(),
		notices:    Array.isArray(state.notices) ? state.notices.slice() : [],
		phases:     phases,
		current:    running ? running.name : null,
		log:        (x.log || []).slice(-LOG_LINES),
		drain:      x.drain || null,
		servedBy:   x.servedBy || 'gateway',
		boardName:  x.boardName || null
	};
}

var PHASE_ICON = { done: '&#10003;', running: '&#9679;', failed: '&#10007;', skipped: '&ndash;', pending: '&#9675;' };

function renderPhases(s) {
	return s.phases.map(function (p) {
		var note = p.error ? '<div class="note err">' + esc(p.error) + '</div>'
			: (p.detail ? '<div class="note">' + esc(p.detail) + '</div>' : '');
		return '<li class="ph ph-' + esc(p.status) + '"><span class="ic">' + (PHASE_ICON[p.status] || '') +
			'</span><span class="lb">' + esc(p.label) + '</span>' + note + '</li>';
	}).join('');
}

function renderDrain(s) {
	if (!s.drain || !s.drain.processes || !s.drain.processes.length || s.current !== 'stop') return '';
	var rows = s.drain.processes.map(function (p) {
		var pending = [];
		for (var k in p.pending || {}) if (p.pending[k]) pending.push(p.pending[k] + ' ' + k);
		return '<tr><td>' + esc(p.process) + '</td><td>' + esc(p.state) + '</td><td>' + esc(pending.join(', ') || '-') + '</td></tr>';
	}).join('');
	return '<h2>Waiting for the board to drain</h2><table class="drain"><tr><th>Process</th><th>State</th><th>In flight</th></tr>' + rows + '</table>';
}

/** The inner content, swapped in by the page's own polling. Pure. */
function renderProgressBody(s) {
	if (s.status === 'none') {
		return '<p>No update has run on this board.</p><p><a href="/admin/update">Back to the Update page</a></p>';
	}
	var badge = { running: 'Running', complete: 'Complete', failed: 'Failed' }[s.status] || esc(s.status);
	var served = s.servedBy === 'updater'
		? 'The BBS is stopped. This page is being served by the updater itself.'
		: 'This page is being served by the BBS.';
	var out = '';
	out += '<p class="meta"><span class="badge b-' + esc(s.status) + '">' + badge + '</span> ' +
		esc(s.from || '?') + ' &rarr; ' + esc(s.to || '?') + ' &middot; run ' + esc(s.runId) + '</p>';
	out += '<p class="served">' + esc(served) + '</p>';
	out += '<ol class="phases">' + renderPhases(s) + '</ol>';
	out += renderDrain(s);
	if (s.status === 'failed') {
		out += '<div class="box err"><strong>The update failed' + (s.error ? ': ' + esc(s.error) : '.') + '</strong>' +
			'<p>The board is left closed for maintenance so nobody calls in while you look. ' +
			'Check what happened on the <a href="/admin/update">Update page</a>, then reopen from the ' +
			'<a href="/admin/maintenance">Maintenance page</a> when you are satisfied.</p></div>';
	} else if (s.status === 'complete') {
		out += '<div class="box ok"><strong>The update is complete.</strong> The board is open again. ' +
			'<a href="/admin/update">Back to the Update page</a></div>';
	}
	if (s.notices && s.notices.length) {
		// Upgrade notes the release declared (#55). Several are instructions
		// for afterwards, so they matter most once the update is complete.
		out += '<h2>' + (s.status === 'complete' ? 'After updating' : 'Upgrade notes') + '</h2><ul class="notes">' +
			s.notices.map(function (n) {
				return '<li class="lvl-' + esc(n.level) + '">' + (n.level === 'info' ? '' : '<strong>' + esc(n.level) + ':</strong> ') + esc(n.text) + '</li>';
			}).join('') + '</ul>';
	}
	if (s.warnings.length) {
		out += '<h2>Warnings</h2><ul class="warn">' + s.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
	}
	if (s.log.length) {
		out += '<h2>Log</h2><pre class="log">' + esc(s.log.join('\n')) + '</pre>';
	}
	return out;
}

var STYLE =
	'body{background:#222;color:#dee2e6;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0}' +
	'.wrap{max-width:46rem;margin:0 auto;padding:6vh 1.25rem 3rem}' +
	'h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:1.5rem 0 .5rem}' +
	'a{color:#3498db}.meta,.served{margin:.25rem 0}.served{color:#adb5bd;font-size:.9rem}' +
	'.badge{display:inline-block;padding:.1rem .5rem;border-radius:.25rem;font-size:.8rem;font-weight:600}' +
	'.b-running{background:#3498db}.b-complete{background:#00bc8c}.b-failed{background:#e74c3c}' +
	'.phases{list-style:none;padding:0;margin:1rem 0}.ph{padding:.3rem 0;border-bottom:1px solid #303030}' +
	'.ic{display:inline-block;width:1.5rem;text-align:center}.ph-pending{color:#6c757d}' +
	'.ph-done .ic{color:#00bc8c}.ph-failed .ic,.err{color:#e74c3c}.ph-skipped{color:#adb5bd}' +
	'.ph-running{font-weight:600}.ph-running .ic{color:#3498db;animation:p 1s infinite}' +
	'@keyframes p{50%{opacity:.3}}.note{margin-left:1.5rem;font-size:.85rem;color:#adb5bd}.note.err{color:#e74c3c}' +
	'.box{padding:.75rem 1rem;border-radius:.3rem;margin:1rem 0}.box.err{background:#3a1d1d;color:#f5b7b1}' +
	'.box.ok{background:#16332b}.box p{margin:.5rem 0 0}.warn{color:#f39c12}' +
	'.log{background:#111;padding:.75rem;border-radius:.3rem;font-size:.8rem;max-height:22rem;overflow:auto;white-space:pre-wrap}' +
	'table.drain{border-collapse:collapse;width:100%}table.drain td,table.drain th{padding:.25rem .5rem;border-bottom:1px solid #303030;text-align:left}' +
	'#restarting{display:none;background:#3a3317;color:#f5d98b;padding:.5rem 1rem;border-radius:.3rem;margin:1rem 0}' +
	'.card{background:#303030;border-radius:.4rem;padding:2.5rem;text-align:center}.muted{color:#adb5bd;font-size:.9rem}';

// Polls the progress page, whichever server is answering, and swaps the
// content in. Stops once the run has finished and the BBS itself is answering.
var POLL_SCRIPT =
	'(function(){var box=document.getElementById("update-progress");var note=document.getElementById("restarting");' +
	'function done(el){return el.getAttribute("data-status")!=="running"&&el.getAttribute("data-served")==="gateway";}' +
	'if(done(box))return;' +
	'function poll(){fetch("/admin/update/progress",{cache:"no-store",credentials:"same-origin"})' +
	'.then(function(r){return r.text();}).then(function(html){' +
	'var doc=new DOMParser().parseFromString(html,"text/html");var fresh=doc.getElementById("update-progress");' +
	'if(!fresh){note.style.display="block";return setTimeout(poll,3000);}' +
	'note.style.display="none";box.innerHTML=fresh.innerHTML;' +
	'box.setAttribute("data-status",fresh.getAttribute("data-status"));box.setAttribute("data-served",fresh.getAttribute("data-served"));' +
	'var log=box.querySelector(".log");if(log)log.scrollTop=log.scrollHeight;' +
	'if(!done(box))setTimeout(poll,2000);})' +
	'.catch(function(){note.style.display="block";setTimeout(poll,3000);});}' +
	'var log=box.querySelector(".log");if(log)log.scrollTop=log.scrollHeight;setTimeout(poll,2000);})();';

/** The whole progress page. Pure. */
function renderProgressPage(s) {
	var title = s.to ? 'Updating to ' + s.to : 'Update';
	return '<!doctype html><html><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1">' +
		'<title>' + esc((s.boardName ? s.boardName + ' - ' : '') + title) + '</title>' +
		'<style>' + STYLE + '</style><link rel="stylesheet" href="/css/custom.css"></head><body><div class="wrap">' +
		'<h1>' + esc(title) + '</h1>' +
		'<div id="restarting">The BBS is restarting. This page carries on when it answers again.</div>' +
		'<div id="update-progress" data-status="' + esc(s.status) + '" data-served="' + esc(s.servedBy) + '">' +
		renderProgressBody(s) + '</div>' +
		'</div><script>' + POLL_SCRIPT + '</script></body></html>';
}

/**
 * What everybody but a sysop sees while the BBS is stopped for an update: the
 * same message as the gateway's own maintenance page, since to a visitor it is
 * the same closure. Pure.
 *
 * @param {object} info  { boardName, reason }
 */
function renderMaintenancePage(info) {
	var i = info || {};
	var board = i.boardName || 'The board';
	return '<!doctype html><html><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1">' +
		'<meta http-equiv="refresh" content="60">' +
		'<title>' + esc(board) + ' - closed for maintenance</title>' +
		'<style>' + STYLE + '</style><link rel="stylesheet" href="/css/custom.css"></head><body>' +
		'<div class="wrap maintenance-page"><div class="card">' +
		'<h1>' + esc(board) + '</h1><p>is closed for maintenance.</p>' +
		(i.reason ? '<p>' + esc(i.reason) + '</p>' : '') +
		'<p>Please check back a little later.</p>' +
		'<p class="muted">This page checks again every minute.</p>' +
		'</div></div></body></html>';
}

export {
	PHASE_LABELS,
	esc,
	hashSessionId,
	parseCookies,
	tailFile,
	progressSnapshot,
	renderProgressBody,
	renderProgressPage,
	renderMaintenancePage
};
