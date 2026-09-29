// doorauthhandler.js -- the door_auth stage of the door-server pool (#86).
//
// Protocol canectic-doorserver/1 (docs/reference/DOORSERVER_DESIGN.md):
//
//   server  {"type":"hello","protocol":"canectic-doorserver/1","board":"..."}
//   client  {"type":"auth","system_id","secret","user":{"name","real_name"},
//            "door":"<slug>"?, "term":{"width","height","encoding","type"},
//            "list":false?}
//   server  {"type":"auth_ok","node":N,"doors":[{slug,name,description}],
//            "collections":[{slug,name,description,doors:[slug...]}]}
//            (collections since #89; a client that ignores them uses doors)
//        or {"type":"auth_fail","reason":"..."} and hang up
//   list:true   the door list is the whole answer; hang up
//   door given  launch it
//   neither     wait for {"type":"launch","door":"<slug>"} naming one of the
//               listed doors; the client draws its own menu
//
// After that the socket carries the terminal stream. Whatever the client
// names, CallManager.launchDoor checks doors.mayLaunchDoor again: a
// door-server session can only ever reach a door offered through a
// collection shown to the door server.

import { BaseHandler } from "./basehandler.js";
import * as alogger from "../utils/alogger.js";
import * as doorserver from "../models/doorserver.js";
import { offeredCollections, flattenOffered } from "../models/doorCollections.js";
import { logAuthFail } from "../utils/authFailLog.js";
import appConfig from "../config/appConfig.js";

const PROTOCOL = "canectic-doorserver/1";
const maxAuthBuffer = 4096; // Max bytes we'll accept before giving up

/**
 * Split complete top-level JSON objects off the front of a buffer, braces
 * inside strings ignored. Returns { frames: [text], rest }.
 */
function takeFrames(buffer) {
	var frames = [];
	var depth = 0, inString = false, escaped = false, start = -1;
	for (var i = 0; i < buffer.length; i++) {
		var ch = buffer[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === "{") { if (depth === 0) start = i; depth++; }
		else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) { frames.push(buffer.slice(start, i + 1)); start = -1; }
			if (depth < 0) depth = 0;
		}
	}
	var rest = start !== -1 ? buffer.slice(start) : "";
	return { frames: frames, rest: rest };
}

/**
 * What a door-server caller may choose from (#89): the offered doors of every
 * collection shown to the door server, as collections and as one flat list.
 * The flat list is what 0.9.13a clients read; the collections let a client
 * show a menu by collection.
 */
async function availableDoors() {
	var collections = await offeredCollections();
	return { collections: collections, doors: flattenOffered(collections) };
}

/** Live door-server sessions for a system, in this call's pool. */
function liveSessionsFor(call, systemId) {
	var calls = (call && call.callPool && call.callPool.connectedcalls) || [];
	return calls.filter(function (c) { return c && c !== call && c.doorsession && c.caller_bbs === systemId; }).length;
}

function clean(value, max) {
	return String(value === undefined || value === null ? "" : value).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
}

class DoorAuthHandler extends BaseHandler {
	constructor(call) {
		super(call, "DoorAuth");
		this.inactivityTO = appConfig.getNumber('doorAuthTO', 15) * 1000; // seconds → ms
		this.warnMsg = ""; // No warn for machine clients
		this.authBuffer = "";
		this.authenticated = false;
		this.awaitingLaunch = false;
		this.doors = [];
		this.collections = [];
		this.previousRawmode = false;
		this.previousRawtarget = null;
	}

	// --- Raw mode management ---
	_enableRawMode() {
		this.previousRawmode = this.call.rawmode;
		this.previousRawtarget = this.call.rawtarget;
		this.call.rawmode = true;
		this.call.rawtarget = (data) => {
			this._onRawData(data);
		};
	}

	_disableRawMode() {
		if (this.call) {
			this.call.rawmode = this.previousRawmode;
			this.call.rawtarget = this.previousRawtarget;
		}
	}

	// --- Data handling ---
	_onRawData(data) {
		if (!this.active) return;
		try {
			this.resetInactivityTimeouts();
			this.authBuffer += data.toString("utf8");
			if (this.authBuffer.length > maxAuthBuffer) {
				this._authFailed("Auth payload too large");
				return;
			}
			var parsed = takeFrames(this.authBuffer);
			this.authBuffer = parsed.rest;
			for (var text of parsed.frames) {
				if (!this.active || this.finished) break;
				var frame;
				try { frame = JSON.parse(text); } catch (_) { this._authFailed("Malformed JSON"); return; }
				if (!this.authenticated) this._processAuth(frame);
				else if (this.awaitingLaunch) this._processLaunch(frame);
			}
		} catch (err) {
			this._handleError("Raw data handling error", err);
		}
	}

	async _processAuth(frame) {
		if (this._authInFlight) return;
		this._authInFlight = true;
		try {
			var systemId = doorserver.normaliseSystemId(frame.system_id);
			if (frame.type !== "auth" || !systemId || !frame.secret) {
				this._authFailed("Expected an auth frame with system_id and secret");
				return;
			}
			var ip = this.call && this.call.callerId;
			var check = await doorserver.verifyLogin(systemId, frame.secret);
			if (!this.active) return;
			if (!check.ok) {
				// Wrong credentials are logged for fail2ban; a real system that
				// is pending or suspended is not an attack, just refused.
				if (!check.system) logAuthFail(check.unknown ? 'unknown' : 'failed', 'door server system ' + systemId, ip, 'door server');
				this._authFailed(check.reason);
				return;
			}
			var sys = check.system;
			var limit = parseInt(sys.max_concurrent) || appConfig.getNumber('doorserver_max_concurrent', 5);
			if (liveSessionsFor(this.call, sys.system_id) >= limit) {
				this._authFailed("Too many sessions for " + sys.system_id + " (limit " + limit + ")");
				return;
			}
			var offer = await availableDoors();
			this.doors = offer.doors;
			this.collections = offer.collections;
			if (!this.active) return;
			this._authSuccess(sys, frame);
		} catch (err) {
			this._authFailed("Auth validation error");
			alogger.writeAlog(2, this.loggingId + "\n  Door auth error: " + (err.stack || err), "redbright");
		} finally {
			this._authInFlight = false;
		}
	}

	_authSuccess(sys, frame) {
		this.authenticated = true;
		var call = this.call;
		var user = frame.user || {};
		var term = frame.term || {};
		var remoteName = clean(user.name, 40) || "Guest";

		call.doorsession = true;
		// The door server's own mark (#89): a web Play session sets doorsession too
		call.doorserver_session = true;
		call.caller_bbs = sys.system_id;
		call.caller_bbs_name = sys.bbs_name;
		call.caller_username = (sys.username_prefix || sys.system_id) + "_" + remoteName.replace(/\s+/g, "_");
		call.caller_fullname = clean(user.real_name, 60) || remoteName;
		call.caller_location = sys.bbs_name;
		call.security = appConfig.getNumber('doorserver_security', 50);
		call.term_type = "Door Client";
		var enc = String(term.encoding || "").toLowerCase();
		call.term_encoding = (enc === "utf8" || enc === "utf-8") ? "UTF-8" : "CP437";
		var w = parseInt(term.width), h = parseInt(term.height);
		if (w >= 20 && w <= 400) call.term_width = w;
		if (h >= 10 && h <= 200) call.term_height = h;

		alogger.writeAlog(3, this.loggingId + "\n  Door server login: " + call.caller_username + " from " + sys.system_id +
			" (" + sys.bbs_name + ")", "greenbright");
		doorserver.recordSession(sys.uuid).catch(function () {});
		if (typeof call.logCallStart === 'function') call.logCallStart().catch(function () {});
		if (call.nodeManager) {
			try {
				call.nodeManager.setNodeUsername(call.nodenum, call.caller_username);
				call.nodeManager.setNodeCallId(call.nodenum, call.uuid);
			} catch (_) {}
		}

		this._sendResponse({
			type: "auth_ok", node: call.nodenum, doors: this.doors,
			collections: this.collections.map(function (c) {
				return { slug: c.slug, name: c.name, description: c.description, doors: c.doors.map(function (d) { return d.slug; }) };
			})
		});

		if (frame.list) { this._finish(true); return; }
		var slug = clean(frame.door, 64);
		if (slug) { this._chooseDoor(slug); return; }
		// No door named: the client shows the list and sends a launch frame.
		this.awaitingLaunch = true;
	}

	_processLaunch(frame) {
		if (frame.type !== "launch" || !frame.door) {
			this._sendResponse({ type: "error", reason: "Expected a launch frame naming a door" });
			return;
		}
		this._chooseDoor(clean(frame.door, 64));
	}

	_chooseDoor(slug) {
		var found = this.doors.find(function (d) { return d.slug.toLowerCase() === slug.toLowerCase(); });
		if (!found) {
			this._sendResponse({ type: "error", reason: "No such door on this door server: " + slug });
			if (!this.awaitingLaunch) this._finish(true);
			return;
		}
		this.awaitingLaunch = false;
		this.call.doorTarget = found.slug;
		this._sendResponse({ type: "launch_ok", door: found.slug });
		this._finish(false);
	}

	// hangUp: the list request is done, or a named door does not exist.
	_finish(hangUp) {
		this._disableRawMode();
		this.finished = true;
		if (hangUp) { if (this.call) this.call.hangUpCall(); return; }
		this.signalReturn();
	}

	_authFailed(reason) {
		alogger.writeAlog(3, this.loggingId + "\n  Door auth failed: " + reason, "yellowbright");
		this._sendResponse({ type: "auth_fail", reason: reason });
		this._disableRawMode();
		this.finished = true;
		this.emitter.emit("AuthFailed");
	}

	_sendResponse(obj) {
		try {
			if (this.call && this.call.connection) {
				this.call.sendString(JSON.stringify(obj) + "\n");
			}
		} catch (_) {}
	}

	startStage() {
		try {
			this._enableRawMode();
			// Off by default (#86): the pool is mounted on every board, and
			// until door-server access is switched on nobody gets past here.
			if (!appConfig.getBoolean('doorserver_enabled', false)) {
				this._authFailed("Door server is not enabled on this board");
				return;
			}
			this._sendResponse({ type: "hello", protocol: PROTOCOL, board: appConfig.get('boardname', 'Canectic BBS') });
			this.setInactivityTimeouts();
		} catch (err) {
			this._handleError("startStage error", err);
		}
	}

	// Override inactivity kick to send JSON instead of terminal text
	onInactivityKick() {
		if (this.call) {
			this._sendResponse({ type: "auth_fail", reason: "Timed out" });
			this.call.hangUpCall();
		}
	}

	clearHandler() {
		if (!this.active) return;
		this._disableRawMode();
		this.authBuffer = "";
		super.clearHandler();
	}
}

export { DoorAuthHandler, takeFrames, PROTOCOL };
