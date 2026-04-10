// src/models/messageTemplates.js
// Sysop-authored message templates triggered on user lifecycle and activity events.
//
// Two tables:
//   message_template_events  -- event type registry (built-in + custom)
//   message_templates        -- the actual templates (subject, body, delivery opts)
//
// Core API:
//   fireEvent(eventCode, userId, extraVars)       -> delivers all matching templates
//   fireEventForMany(eventCode, userIds, extraVars) -> batch fire
//
// Delivery routes through src/models/privateMessages.js (deliverMessage for PM,
// queueOutbound for email/netmail). Each transport is independently enabled per
// template; missing addresses skip individually (per-transport skip semantics).
//
// See docs/reference/MESSAGE_TEMPLATES_DESIGN.md for the full design.

import { v4 as uuidv4 } from 'uuid';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as postgres from '../middleware/db/postgres.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';
import { applyTemplate, buildContext } from '../utils/templateVars.js';

var VALID_EVENT_CODE = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Event registry -- message_template_events
// ---------------------------------------------------------------------------

async function getAllEvents() {
	return await postgres.query(
		'SELECT * FROM message_template_events ORDER BY is_builtin DESC, code ASC'
	) || [];
}

async function getEventByCode(code) {
	return await postgres.queryOne(
		'SELECT * FROM message_template_events WHERE code = $1',
		[code]
	);
}

async function getEventById(id) {
	return await postgres.queryOne(
		'SELECT * FROM message_template_events WHERE id = $1',
		[parseInt(id)]
	);
}

async function createEvent(formObj) {
	var ret = { status: false, errormessages: [], insertId: 0 };

	var code = (formObj.code || '').trim().toLowerCase();
	if (!code) ret.errormessages.push('Event code is required');
	if (code && !VALID_EVENT_CODE.test(code)) {
		ret.errormessages.push('Event code must start with a letter and contain only lowercase letters, digits, and underscores');
	}
	if (!formObj.label || !formObj.label.trim()) ret.errormessages.push('Label is required');
	if (ret.errormessages.length > 0) return ret;

	var existing = await getEventByCode(code);
	if (existing) {
		ret.errormessages.push('Event "' + code + '" already exists');
		return ret;
	}

	var dbObj = {
		code:           code,
		label:          formObj.label.trim(),
		description:    (formObj.description || '').trim() || null,
		is_builtin:     false,
		context_schema: formObj.context_schema ? JSON.stringify(formObj.context_schema) : null,
		created_at:     new Date()
	};

	var res = await postgres.insertObject(dbObj, 'message_template_events');
	if (!res.status) {
		ret.errormessages = ret.errormessages.concat(res.errormessages || ['Database insert failed']);
		return ret;
	}
	ret.status = true;
	ret.insertId = res.insertId;
	alogger.writeAlog(5, 'Template event created: ' + code, 'greenbright');
	return ret;
}

async function updateEvent(id, formObj) {
	var ret = { status: false, errormessages: [] };
	var existing = await getEventById(id);
	if (!existing) { ret.errormessages.push('Event not found'); return ret; }

	var updateObj = { updated_at: new Date() };
	if (formObj.label !== undefined) updateObj.label = formObj.label.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim() || null;
	// Built-in events: can only edit label/description, not code or schema
	if (!existing.is_builtin) {
		if (formObj.code !== undefined) {
			var code = formObj.code.trim().toLowerCase();
			if (!VALID_EVENT_CODE.test(code)) {
				ret.errormessages.push('Invalid event code');
				return ret;
			}
			if (code !== existing.code) {
				var dupe = await getEventByCode(code);
				if (dupe) { ret.errormessages.push('Event "' + code + '" already exists'); return ret; }
			}
			updateObj.code = code;
		}
		if (formObj.context_schema !== undefined) {
			updateObj.context_schema = formObj.context_schema
				? JSON.stringify(formObj.context_schema)
				: null;
		}
	}

	var count = await postgres.updateById(parseInt(id), updateObj, 'message_template_events');
	if (count === 0) { ret.errormessages.push('No rows updated'); return ret; }
	ret.status = true;
	return ret;
}

async function deleteEvent(id) {
	var ret = { status: false, errormessages: [] };
	var existing = await getEventById(id);
	if (!existing) { ret.errormessages.push('Event not found'); return ret; }
	if (existing.is_builtin) {
		ret.errormessages.push('Built-in events cannot be deleted');
		return ret;
	}
	// Check for templates referencing this event
	var refs = await postgres.queryOne(
		'SELECT COUNT(*)::int AS cnt FROM message_templates WHERE event_code = $1',
		[existing.code]
	);
	if (refs && refs.cnt > 0) {
		ret.errormessages.push('Cannot delete: ' + refs.cnt + ' template(s) still use this event');
		return ret;
	}
	var err = await postgres.write('DELETE FROM message_template_events WHERE id = $1', [parseInt(id)]);
	if (err) { ret.errormessages.push('Delete failed: ' + err.message); return ret; }
	ret.status = true;
	return ret;
}

// ---------------------------------------------------------------------------
// Templates -- message_templates
// ---------------------------------------------------------------------------

async function getAllTemplates() {
	return await postgres.query(
		'SELECT * FROM message_templates ORDER BY event_code ASC, sort_order ASC, name ASC'
	) || [];
}

async function getTemplatesForEvent(eventCode) {
	return await postgres.query(
		'SELECT * FROM message_templates WHERE event_code = $1 AND active = true ORDER BY sort_order ASC, id ASC',
		[eventCode]
	) || [];
}

async function getTemplateById(id) {
	return await postgres.queryOne(
		'SELECT * FROM message_templates WHERE id = $1',
		[parseInt(id)]
	);
}

async function createTemplate(formObj) {
	var ret = { status: false, errormessages: [], insertId: 0 };

	if (!formObj.name || !formObj.name.trim()) ret.errormessages.push('Name is required');
	if (!formObj.event_code || !formObj.event_code.trim()) ret.errormessages.push('Event code is required');
	if (!formObj.subject || !formObj.subject.trim()) ret.errormessages.push('Subject is required');
	if (ret.errormessages.length > 0) return ret;

	// Verify event exists
	var event = await getEventByCode(formObj.event_code.trim());
	if (!event) {
		ret.errormessages.push('Unknown event: ' + formObj.event_code);
		return ret;
	}

	var dbObj = {
		uuid:           uuidv4(),
		name:           formObj.name.trim(),
		description:    (formObj.description || '').trim() || null,
		event_code:     event.code,
		from_user:      (formObj.from_user || '').trim() || null,
		subject:        formObj.subject.trim(),
		body_text:      formObj.body_text || '',
		body_html:      formObj.body_html || null,
		deliver_pm:     formObj.deliver_pm === 'true' || formObj.deliver_pm === true,
		deliver_email:  formObj.deliver_email === 'true' || formObj.deliver_email === true,
		deliver_netmail: formObj.deliver_netmail === 'true' || formObj.deliver_netmail === true,
		conditions:     formObj.conditions ? JSON.stringify(formObj.conditions) : null,
		active:         formObj.active !== 'false' && formObj.active !== false,
		sort_order:     parseInt(formObj.sort_order) || 0,
		fire_count:     0,
		created_at:     new Date()
	};

	// At least one delivery method must be enabled
	if (!dbObj.deliver_pm && !dbObj.deliver_email && !dbObj.deliver_netmail) {
		ret.errormessages.push('At least one delivery method must be enabled');
		return ret;
	}

	var res = await postgres.insertObject(dbObj, 'message_templates');
	if (!res.status) {
		ret.errormessages = ret.errormessages.concat(res.errormessages || ['Database insert failed']);
		return ret;
	}
	ret.status = true;
	ret.insertId = res.insertId;
	alogger.writeAlog(5, 'Message template created: ' + dbObj.name + ' (' + event.code + ')', 'greenbright');
	return ret;
}

async function updateTemplate(id, formObj) {
	var ret = { status: false, errormessages: [] };
	var existing = await getTemplateById(id);
	if (!existing) { ret.errormessages.push('Template not found'); return ret; }

	var updateObj = { updated_at: new Date() };

	if (formObj.name !== undefined) updateObj.name = formObj.name.trim();
	if (formObj.description !== undefined) updateObj.description = formObj.description.trim() || null;
	if (formObj.event_code !== undefined) {
		var event = await getEventByCode(formObj.event_code.trim());
		if (!event) { ret.errormessages.push('Unknown event: ' + formObj.event_code); return ret; }
		updateObj.event_code = event.code;
	}
	if (formObj.from_user !== undefined) updateObj.from_user = formObj.from_user.trim() || null;
	if (formObj.subject !== undefined) updateObj.subject = formObj.subject.trim();
	if (formObj.body_text !== undefined) updateObj.body_text = formObj.body_text;
	if (formObj.body_html !== undefined) updateObj.body_html = formObj.body_html || null;
	if (formObj.deliver_pm !== undefined) updateObj.deliver_pm = formObj.deliver_pm === 'true' || formObj.deliver_pm === true;
	if (formObj.deliver_email !== undefined) updateObj.deliver_email = formObj.deliver_email === 'true' || formObj.deliver_email === true;
	if (formObj.deliver_netmail !== undefined) updateObj.deliver_netmail = formObj.deliver_netmail === 'true' || formObj.deliver_netmail === true;
	if (formObj.conditions !== undefined) {
		updateObj.conditions = formObj.conditions ? JSON.stringify(formObj.conditions) : null;
	}
	if (formObj.active !== undefined) updateObj.active = formObj.active !== 'false' && formObj.active !== false;
	if (formObj.sort_order !== undefined) updateObj.sort_order = parseInt(formObj.sort_order) || 0;

	var count = await postgres.updateById(parseInt(id), updateObj, 'message_templates');
	if (count === 0) { ret.errormessages.push('No rows updated'); return ret; }
	ret.status = true;
	return ret;
}

async function deleteTemplate(id) {
	var ret = { status: false, errormessages: [] };
	var err = await postgres.write('DELETE FROM message_templates WHERE id = $1', [parseInt(id)]);
	if (err) { ret.errormessages.push('Delete failed: ' + err.message); return ret; }
	ret.status = true;
	return ret;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a template's conditions JSONB against a user record and event data.
 * Supported conditions (all optional):
 *   security_min       -- user.security >= value
 *   security_max       -- user.security <= value
 *   verified           -- user.mailverified === value (boolean)
 *   has_email          -- user has mailaddress with mailtype=email
 *   has_netmail        -- user has mailaddress with mailtype=netmail
 *   nth_count          -- event-specific count (logoncount, post count, etc) matches one of [values]
 *   days_inactive      -- for user_dormant: user.lastlogon >= N days ago
 *   permission_flags   -- all listed flags present on user
 *   restriction_flags  -- none of the listed flags present on user
 */
function evaluateConditions(conditions, user, extraVars) {
	if (!conditions) return true;
	var cond = conditions;
	if (typeof cond === 'string') {
		try { cond = JSON.parse(cond); } catch (_) { return true; }
	}
	if (!cond || typeof cond !== 'object') return true;

	if (cond.security_min !== undefined && (user.security || 0) < cond.security_min) return false;
	if (cond.security_max !== undefined && (user.security || 0) > cond.security_max) return false;
	if (cond.verified !== undefined && !!user.mailverified !== !!cond.verified) return false;
	if (cond.has_email && !(user.mailaddress && (user.mailtype || '').toLowerCase() === 'email')) return false;
	if (cond.has_netmail && !(user.mailaddress && (user.mailtype || '').toLowerCase() === 'netmail')) return false;

	if (cond.nth_count && Array.isArray(cond.nth_count)) {
		// Look up the count from extraVars.event (event-specific field)
		// Any of login_number, post_count, upload_count
		var count = extraVars && extraVars.event
			? (extraVars.event.login_number || extraVars.event.post_count || extraVars.event.upload_count)
			: null;
		if (count === null || count === undefined) return false;
		if (!cond.nth_count.includes(count)) return false;
	}

	if (cond.days_inactive !== undefined) {
		if (!user.lastlogon) return false;
		var last = new Date(user.lastlogon).getTime();
		var cutoff = Date.now() - (cond.days_inactive * 24 * 60 * 60 * 1000);
		if (last > cutoff) return false;
	}

	if (cond.permission_flags && Array.isArray(cond.permission_flags)) {
		var perms = user.permissionflags || [];
		if (typeof perms === 'string') { try { perms = JSON.parse(perms); } catch (_) { perms = []; } }
		for (var pf of cond.permission_flags) {
			if (!perms.includes(pf)) return false;
		}
	}

	if (cond.restriction_flags && Array.isArray(cond.restriction_flags)) {
		var rests = user.restrictionflags || [];
		if (typeof rests === 'string') { try { rests = JSON.parse(rests); } catch (_) { rests = []; } }
		for (var rf of cond.restriction_flags) {
			if (rests.includes(rf)) return false;
		}
	}

	return true;
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

/**
 * Fire an event, sending matching templates to a single user.
 * @param {string} eventCode
 * @param {number} userId
 * @param {object} [extraVars] - Event-specific variables, typically { event: {...} }
 * @returns {object} { fired, skipped, errors, templatesMatched }
 */
async function fireEvent(eventCode, userId, extraVars) {
	var ret = { fired: 0, skipped: 0, errors: [], templatesMatched: 0 };

	if (!eventCode || !userId) {
		ret.errors.push('eventCode and userId required');
		return ret;
	}

	var templates = await getTemplatesForEvent(eventCode);
	if (!templates || templates.length === 0) {
		// Normal -- no templates attached to this event
		return ret;
	}

	var user = await postgres.queryOne('SELECT * FROM users WHERE id = $1', [parseInt(userId)]);
	if (!user) {
		ret.errors.push('User ' + userId + ' not found');
		return ret;
	}

	// Lazy-import privateMessages to avoid circular deps at module load time
	var pm = await import('./privateMessages.js');

	for (var tmpl of templates) {
		try {
			// Evaluate conditions
			if (!evaluateConditions(tmpl.conditions, user, extraVars)) {
				ret.skipped++;
				continue;
			}
			ret.templatesMatched++;

			// Build substitution context
			var ctx = buildContext(user, extraVars);

			// Apply template
			var subject = applyTemplate(tmpl.subject, ctx);
			var bodyText = applyTemplate(tmpl.body_text || '', ctx);
			var bodyHtml = tmpl.body_html ? applyTemplate(tmpl.body_html, ctx) : null;

			var fromUser = tmpl.from_user || appConfig.get('boardname', 'BBS');
			var delivered = false;

			// Deliver: PM
			if (tmpl.deliver_pm) {
				try {
					var pmResult = await pm.deliverMessage({
						uuid: uuidv4(),
						user_id: user.id,
						from_user: fromUser,
						to_user: user.username,
						subject: subject,
						body_text: bodyText,
						body_html: bodyHtml,
						transport_type: 'LOCAL',
						transport_data: { system_notification: true, template_id: tmpl.id, event_code: eventCode },
						system_time: new Date()
					});
					if (pmResult.status) delivered = true;
					else ret.errors.push('PM delivery failed for template ' + tmpl.id + ': ' + (pmResult.errormessages || []).join(', '));
				} catch (err) {
					ret.errors.push('PM delivery exception for template ' + tmpl.id + ': ' + err.message);
				}
			}

			// Deliver: Email (only if user has email address)
			if (tmpl.deliver_email) {
				var mailtype = (user.mailtype || '').toLowerCase();
				if (mailtype === 'email' && user.mailaddress) {
					var relayHost = appConfig.get('email_relay_host', '');
					var fromAddr = appConfig.get('email_from_address', '');
					if (!relayHost || !fromAddr) {
						alogger.writeAlog(3, '[Template] Email relay not configured; skipping email for ' + user.username, 'yellow');
					} else {
						try {
							await pm.queueOutbound({
								user_id: 0,
								from_user: fromUser,
								to_user: user.username,
								from_address: fromAddr,
								to_address: user.mailaddress,
								subject: subject,
								body_text: bodyText,
								utf8: bodyText,
								body_html: bodyHtml,
								transport_type: 'EMAIL',
								transport_data: {
									email_address: user.mailaddress,
									system_notification: true,
									template_id: tmpl.id,
									event_code: eventCode
								},
								system_time: new Date()
							});
							delivered = true;
						} catch (err) {
							ret.errors.push('Email queue exception for template ' + tmpl.id + ': ' + err.message);
						}
					}
				} else {
					alogger.writeAlog(5, '[Template] Skipping email delivery: user ' + user.username + ' has no email address', 'cyan');
				}
			}

			// Deliver: Netmail (only if user has netmail address)
			if (tmpl.deliver_netmail) {
				var mt = (user.mailtype || '').toLowerCase();
				if (mt === 'netmail' && user.mailaddress) {
					var ftnAddr = _parseFtnAddress(user.mailaddress);
					if (!ftnAddr) {
						alogger.writeAlog(3, '[Template] Could not parse FTN address ' + user.mailaddress + ' for ' + user.username, 'yellow');
					} else {
						try {
							await pm.queueOutbound({
								user_id: 0,
								from_user: fromUser,
								to_user: user.username,
								from_address: '',
								to_address: user.mailaddress,
								subject: subject,
								body_text: bodyText,
								utf8: bodyText,
								transport_type: 'FTN',
								transport_data: {
									destination: user.mailaddress,
									destination_zone: ftnAddr.zone,
									destination_net: ftnAddr.net,
									destination_node: ftnAddr.node,
									source_zone: 0,
									source_net: 0,
									source_node: 0,
									system_notification: true,
									template_id: tmpl.id,
									event_code: eventCode
								},
								system_time: new Date()
							});
							delivered = true;
						} catch (err) {
							ret.errors.push('Netmail queue exception for template ' + tmpl.id + ': ' + err.message);
						}
					}
				} else {
					alogger.writeAlog(5, '[Template] Skipping netmail delivery: user ' + user.username + ' has no netmail address', 'cyan');
				}
			}

			if (delivered) {
				ret.fired++;
				// Bump fire_count and last_fired_at (non-blocking)
				try {
					await postgres.write(
						'UPDATE message_templates SET fire_count = fire_count + 1, last_fired_at = NOW() WHERE id = $1',
						[tmpl.id]
					);
				} catch (_) {}
			}
		} catch (err) {
			ret.errors.push('Template ' + tmpl.id + ' fire exception: ' + err.message);
		}
	}

	if (ret.fired > 0 || ret.errors.length > 0) {
		alogger.writeAlog(4,
			'[Template] Event ' + eventCode + ' fired for user ' + user.username +
			': ' + ret.fired + ' delivered, ' + ret.skipped + ' skipped' +
			(ret.errors.length ? ', ' + ret.errors.length + ' errors' : ''),
			ret.errors.length ? 'yellow' : 'cyan'
		);
	}

	return ret;
}

/**
 * Fire an event for a batch of users. Returns aggregate counts.
 */
async function fireEventForMany(eventCode, userIds, extraVars) {
	var total = { fired: 0, skipped: 0, errors: [], usersProcessed: 0 };
	if (!Array.isArray(userIds) || userIds.length === 0) return total;

	for (var uid of userIds) {
		var res = await fireEvent(eventCode, uid, extraVars);
		total.fired += res.fired;
		total.skipped += res.skipped;
		total.errors = total.errors.concat(res.errors);
		total.usersProcessed++;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Parse "zone:net/node" or "zone:net/node.point@domain"
function _parseFtnAddress(addr) {
	if (!addr || typeof addr !== 'string') return null;
	var clean = addr.split('@')[0].trim();
	var match = clean.match(/^(\d+):(\d+)\/(\d+)(?:\.(\d+))?$/);
	if (!match) return null;
	return {
		zone: parseInt(match[1]),
		net:  parseInt(match[2]),
		node: parseInt(match[3]),
		point: match[4] ? parseInt(match[4]) : 0
	};
}

// ---------------------------------------------------------------------------
// Seed built-in events from JSON
// ---------------------------------------------------------------------------

async function seedBuiltinEvents() {
	var jsonPath = path.join(process.cwd(), 'config', 'default', 'message-template-events.json');
	var events;
	try {
		events = JSON.parse(readFileSync(jsonPath, 'utf8'));
	} catch (err) {
		alogger.writeAlog(3, '[Template] Could not load built-in events seed: ' + err.message, 'yellow');
		return;
	}

	var seeded = 0;
	var updated = 0;
	for (var evt of events) {
		var existing = await getEventByCode(evt.code);
		if (!existing) {
			await postgres.insertObject({
				code:           evt.code,
				label:          evt.label,
				description:    evt.description || null,
				is_builtin:     true,
				context_schema: evt.context_schema ? JSON.stringify(evt.context_schema) : null,
				created_at:     new Date()
			}, 'message_template_events');
			seeded++;
		} else if (existing.is_builtin) {
			// Refresh label/description/context_schema from seed (sysop can still override via admin UI)
			var needsUpdate = existing.label !== evt.label ||
				existing.description !== (evt.description || null);
			if (needsUpdate) {
				await postgres.updateById(existing.id, {
					label: evt.label,
					description: evt.description || null,
					context_schema: evt.context_schema ? JSON.stringify(evt.context_schema) : null,
					updated_at: new Date()
				}, 'message_template_events');
				updated++;
			}
		}
	}

	if (seeded > 0 || updated > 0) {
		alogger.writeAlog(2, '[Template] Seeded ' + seeded + ' new events, refreshed ' + updated + ' existing', 'greenbright');
	}
}

export {
	// Event registry
	getAllEvents,
	getEventByCode,
	getEventById,
	createEvent,
	updateEvent,
	deleteEvent,
	// Templates
	getAllTemplates,
	getTemplatesForEvent,
	getTemplateById,
	createTemplate,
	updateTemplate,
	deleteTemplate,
	// Dispatch
	fireEvent,
	fireEventForMany,
	evaluateConditions,
	// Seed
	seedBuiltinEvents
};
