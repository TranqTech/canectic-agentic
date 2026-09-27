// src/routes/api/qwk.js
// QWK/REP API routes.
//
// Mounted under /api/v1/qwk via registerQwkRoutes().
//
// POST /api/v1/qwk/download
//   Auth:   Bearer token with scope qwk (or qwk_rw)
//   Body:   none
//   Output: application/octet-stream -- the .qwk packet binary
//           plus X-Qwk-Message-Count / X-Qwk-Area-Count headers for the client
//   Errors: 401/403 (auth/scope), 404 if no content, 500 on generation failure
//
// POST /api/v1/qwk/upload
//   Auth:   Bearer token with scope qwk_rw
//   Body:   raw octet-stream OR multipart/form-data with file field 'rep'
//   Output: application/json { status, totalPosted, totalErrors, details }
//   Errors: 400 (bad payload), 401/403, 500 on import failure
//
// Side effects on successful request:
//   - caller log entry with source 'QWK-API' (visible in last callers)
//   - users.lastlogon = now
//   - users.logoncount bump ONLY IF >= api_call_count_interval_hours since
//     last bump (tracked via users.api_last_counted_at). Prevents polling
//     clients from inflating the call count metric.
//   - user_qwk_fetched template event fires (no-op unless sysop has
//     attached a template to it)
//   - token.last_used_at touch (handled by auth middleware)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import multer from 'multer';
import * as postgres from '../../middleware/db/postgres.js';
import * as alogger from '../../utils/alogger.js';
import appConfig from '../../config/appConfig.js';
import { apiAuth, requireScope } from '../../middleware/apiAuth.js';
import * as qwkUser from '../../models/qwkUser.js';
import * as callers from '../../models/callers.js';
import * as messageTemplates from '../../models/messageTemplates.js';

// ---------------------------------------------------------------------------
// Multer config for REP uploads
// ---------------------------------------------------------------------------
// REP packets are small (tens of KB typically). Accept up to 10 MB as a
// generous ceiling. Store to temp disk for streaming to qwkUser.importRepForUser.

var repUpload = multer({
	storage: multer.diskStorage({
		destination: function(req, file, cb) {
			var dir = path.join(os.tmpdir(), 'canectic-api-rep');
			try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
			cb(null, dir);
		},
		filename: function(req, file, cb) {
			var ts = Date.now();
			var userId = (req.apiUser && req.apiUser.id) || 'unknown';
			cb(null, 'rep-' + userId + '-' + ts + '.rep');
		}
	}),
	limits: {
		fileSize: 10 * 1024 * 1024  // 10 MB
	}
});

// ---------------------------------------------------------------------------
// Shared post-call logging
// ---------------------------------------------------------------------------

/**
 * Record an API call against the user: caller log entry, lastlogon,
 * throttled logoncount bump, and template event fire.
 *
 * @param {object} user     -- req.apiUser
 * @param {object} token    -- req.apiToken
 * @param {object} req      -- for ip / user-agent
 * @param {string} action   -- short action label (e.g. 'qwk_download')
 * @param {object} extraVars -- event extra vars for user_qwk_fetched template
 */
async function logApiCall(user, token, req, action, extraVars) {
	try {
		var intervalHours = appConfig.getNumber('api_call_count_interval_hours', 4);
		var now = new Date();
		var shouldBumpCount = false;

		if (intervalHours === 0) {
			shouldBumpCount = true;
		} else if (!user.api_last_counted_at) {
			shouldBumpCount = true;
		} else {
			var lastCounted = new Date(user.api_last_counted_at).getTime();
			var msSinceLastCount = now.getTime() - lastCounted;
			var thresholdMs = intervalHours * 60 * 60 * 1000;
			if (msSinceLastCount >= thresholdMs) shouldBumpCount = true;
		}

		// Build caller log entry. logCall() bumps logoncount and inserts the row;
		// we only want it when the throttle says so. Otherwise insert a raw
		// entry without bumping.
		var ipOrHost = req.ip || req.headers['x-forwarded-for'] || 'api';
		var ua = (req.headers['user-agent'] || '').substring(0, 128);
		var callerId = 'api:' + (token.label || 'token') + ' (' + ipOrHost + ')';
		var location = ua || user.location || '';

		if (shouldBumpCount) {
			// Full call log: bump logoncount, update api_last_counted_at,
			// update lastlogon (done inside updateUserCalls-like path).
			await callers.logCall(user, 'QWK-API', callerId, location);
			await postgres.write(
				'UPDATE users SET logoncount = logoncount + 1, lastlogon = $1, api_last_counted_at = $1, updated_at = $1 WHERE id = $2',
				[now, user.id]
			);
		} else {
			// Silent entry: caller log with note, lastlogon update, but no count bump
			var dbObj = {
				username:   user.username,
				logoncount: user.logoncount || 0, // unchanged; historical snapshot
				starttime:  now,
				endtime:    now,                  // API calls are brief
				duration:   0,
				source:     'QWK-API',
				location:   location,
				callerid:   callerId,
				created_at: now
			};
			await postgres.insertObject(dbObj, 'calls');
			await postgres.write(
				'UPDATE users SET lastlogon = $1, updated_at = $1 WHERE id = $2',
				[now, user.id]
			);
		}

		alogger.writeAlog(4,
			'[API] ' + action + ' by ' + user.username + ' (token "' + token.label + '")' +
			(shouldBumpCount ? ' [count bumped]' : ' [count throttled]'),
			'cyan'
		);

		// Fire template event (non-blocking; try/catch wraps the call)
		try {
			await messageTemplates.fireEvent('user_qwk_fetched', user.id, extraVars || {});
		} catch (e) {
			alogger.writeAlog(3, '[API] user_qwk_fetched template fire failed: ' + (e.message || e), 'yellow');
		}
	} catch (err) {
		// Never let logging errors break the API response.
		alogger.writeAlog(3, '[API] logApiCall exception: ' + (err.message || err), 'yellow');
	}
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleDownload(req, res) {
	var user = req.apiUser;
	var token = req.apiToken;

	var result;
	try {
		result = await qwkUser.buildQwkForUser(user.id);
	} catch (err) {
		alogger.writeAlog(3, '[API] buildQwkForUser threw for ' + user.username + ': ' + err.message, 'redbright');
		return res.status(500).json({ error: 'generation_failed', message: err.message });
	}

	if (!result.status) {
		// Either no messages or an actual failure. Distinguish by errormessages presence.
		if (result.errormessages && result.errormessages.length > 0) {
			return res.status(500).json({ error: 'generation_failed', messages: result.errormessages });
		}
		return res.status(204).end(); // No Content -- nothing new
	}

	if (!result.qwkPath || !fs.existsSync(result.qwkPath)) {
		return res.status(204).end();
	}

	// Log the call before sending the response
	await logApiCall(user, token, req, 'qwk_download', {
		event: {
			area_count:       result.areaCount,
			message_count:    result.totalMessages,
			kind:             'download'
		}
	});

	// Stream the packet
	var stat = fs.statSync(result.qwkPath);
	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Length', String(stat.size));
	res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(result.qwkPath) + '"');
	res.setHeader('X-Qwk-Message-Count', String(result.totalMessages));
	res.setHeader('X-Qwk-Area-Count', String(result.areaCount));

	// Committed once the whole packet has been written out (#78): 'finish'
	// fires only then, so a client that drops part way leaves it all for the
	// next packet.
	res.on('finish', function() {
		qwkUser.commitUserPacket(result).catch(function (e) {
			alogger.writeAlog(2, '[API] qwk commit failed for ' + user.username + ': ' + e.message, 'redbright');
		});
	});

	var stream = fs.createReadStream(result.qwkPath);
	stream.on('error', function(err) {
		alogger.writeAlog(3, '[API] qwk download stream error: ' + err.message, 'redbright');
		try { res.end(); } catch (_) {}
	});
	stream.on('close', function() {
		// Clean up temp file after sending
		try {
			fs.rmSync(path.dirname(result.qwkPath), { recursive: true, force: true });
		} catch (_) {}
	});
	stream.pipe(res);
}

async function handleUpload(req, res) {
	var user = req.apiUser;
	var token = req.apiToken;

	if (!req.file) {
		return res.status(400).json({ error: 'no_file', message: 'Missing REP file in request body' });
	}

	var repPath = req.file.path;
	var result;
	try {
		result = await qwkUser.importRepForUser(user.id, repPath);
	} catch (err) {
		alogger.writeAlog(3, '[API] importRepForUser threw for ' + user.username + ': ' + err.message, 'redbright');
		try { fs.rmSync(repPath, { force: true }); } catch (_) {}
		return res.status(500).json({ error: 'import_failed', message: err.message });
	}

	// Clean up uploaded REP file
	try { fs.rmSync(repPath, { force: true }); } catch (_) {}

	if (!result.status && result.errormessages && result.errormessages.length > 0) {
		return res.status(500).json({
			error: 'import_failed',
			messages: result.errormessages,
			totalPosted: result.totalPosted || 0,
			totalErrors: result.totalErrors || 0
		});
	}

	// Log the call
	await logApiCall(user, token, req, 'rep_upload', {
		event: {
			posted_count: result.totalPosted || 0,
			error_count:  result.totalErrors || 0,
			kind:         'upload'
		}
	});

	return res.json({
		status:      true,
		totalPosted: result.totalPosted || 0,
		totalErrors: result.totalErrors || 0,
		details:     result.details || []
	});
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

function registerQwkRoutes(parentRouter) {
	parentRouter.post('/qwk/download', apiAuth, requireScope('qwk'), handleDownload);

	// Upload accepts multipart (with 'rep' field) OR raw octet-stream.
	// Multer handles multipart; for raw octet-stream we stash to a temp file
	// before the handler runs.
	parentRouter.post('/qwk/upload',
		apiAuth,
		requireScope('qwk_rw'),
		function(req, res, next) {
			// If it's multipart, let multer handle it
			var ct = (req.headers['content-type'] || '').toLowerCase();
			if (ct.startsWith('multipart/')) {
				return repUpload.single('rep')(req, res, next);
			}
			// Otherwise expect octet-stream body
			if (ct.startsWith('application/octet-stream') || !ct) {
				// Spool the raw body to a temp file and set req.file
				var dir = path.join(os.tmpdir(), 'canectic-api-rep');
				try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
				var filename = 'rep-' + (req.apiUser ? req.apiUser.id : 'unknown') + '-' + Date.now() + '.rep';
				var filepath = path.join(dir, filename);
				var out = fs.createWriteStream(filepath);
				var size = 0;
				var maxSize = 10 * 1024 * 1024;
				var aborted = false;

				req.on('data', function(chunk) {
					size += chunk.length;
					if (size > maxSize) {
						aborted = true;
						out.destroy();
						try { fs.rmSync(filepath, { force: true }); } catch (_) {}
						return res.status(413).json({ error: 'too_large', message: 'REP file exceeds 10 MB limit' });
					}
				});
				req.pipe(out);
				out.on('finish', function() {
					if (aborted) return;
					req.file = { path: filepath, size: size, originalname: filename };
					next();
				});
				out.on('error', function(err) {
					if (aborted) return;
					return res.status(500).json({ error: 'upload_failed', message: err.message });
				});
				return;
			}
			return res.status(400).json({ error: 'unsupported_content_type', message: 'Expected multipart/form-data or application/octet-stream' });
		},
		handleUpload
	);
}

export { registerQwkRoutes };
