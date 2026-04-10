// privateMessages.js — Unified private messaging model
// Transport-agnostic inbox/outbox/undeliverable operations.
// Transport-specific conversion logic belongs in adapter modules (ftnNetmailAdapter.js, etc.)

import * as postgres from '../middleware/db/postgres.js';
import * as userAccounts from './useraccounts.js';
import * as alogger from '../utils/alogger.js';
import { v4 as uuidv4 } from 'uuid';
import { formatBodyHtml } from '../utils/terminalText.js';
import { sanitizeMessageFields } from './messages.js';
import appConfig from "../config/appConfig.js";
import { createEventPublisher, EVENTS } from '../queues/events.js';

// Lazy-initialized event publisher for PM read/delivery notifications
var _pmEventPublisher = null;
function getPmEventPublisher() {
	if (!_pmEventPublisher) _pmEventPublisher = createEventPublisher();
	return _pmEventPublisher;
}

// --- Outbound toss trigger ---
// After a non-LOCAL message is queued in pm_outbox, signal the worker to
// run the appropriate outbound toss cycle.  Uses dynamic import so the
// model has no hard dependency on BullMQ/Redis — works in tests and
// one-shot scripts without queue infrastructure.

var _jobs = null;
async function _getJobs() {
  if (_jobs) return _jobs;
  try {
    _jobs = await import('../queues/jobs.js');
    return _jobs;
  } catch (err) {
    // Queue infrastructure not available (tests, standalone scripts) — skip
    return null;
  }
}

async function _triggerOutboundToss(transportType) {
  var jobs = await _getJobs();
  if (!jobs) return;

  try {
    switch (transportType) {
      case 'FTN':
        await jobs.enqueueFtnOutbound();
        break;
      case 'QWK':
        await jobs.enqueueQwkPushAll();
        break;
      case 'EMAIL':
        await jobs.enqueueEmailOutbound();
        break;
      // NNTP PMs are not currently supported
      // MESHTASTIC — future transport
    }
  } catch (err) {
    alogger.writeAlog(4, 'PM outbound trigger failed for ' + transportType + ': ' + err.message, 'yellow');
  }
}

// --- Simple text-to-HTML fallback ---
// Used when formatBodyHtml fails or returns empty.
// Escapes HTML entities and converts line breaks to <br>.
function simpleTextToHtml(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n/g, '<br>')
    .replace(/\r/g, '<br>')
    .replace(/\n/g, '<br>');
}

// --- Known automated processor names (case-insensitive match) ---
const AUTOMATED_PROCESSORS = [
  'areafix', 'areamgr',
  'filefix', 'filemgr', 'tic',
  'raidfix'
];

// ============================================================
// Transport Access Control
// ============================================================

// Maps transport types to their access control rules.
// Each entry defines:
//   permissionFlag  — flag required in user.permissionflags (null = no flag needed)
//   restrictionFlag — flag in user.restrictionflags that blocks access
//   defaultAllow    — whether access is granted when no flags apply
//
// Sysop flag always grants access regardless of permission requirements.
// Restriction flags always override permissions including Sysop.

const TRANSPORT_ACCESS_RULES = {
  LOCAL: {
    permissionFlag: null,
    restrictionFlag: 'Private Messages',
    defaultAllow: true
  },
  FTN: {
    permissionFlag: 'Netmail',
    restrictionFlag: 'Netmail',
    defaultAllow: false
  },
  QWK: {
    permissionFlag: 'Netmail',
    restrictionFlag: 'Netmail',
    defaultAllow: false
  },
  MESHTASTIC: {
    permissionFlag: 'Netmail',
    restrictionFlag: 'Netmail',
    defaultAllow: false
  },
  EMAIL: {
    permissionFlag: 'Email',
    restrictionFlag: 'Email',
    defaultAllow: false
  }
};

// Check whether a user can send via a given transport type.
// userSession is the session/user object with permissionflags and restrictionflags arrays.
// transportType is 'LOCAL', 'FTN', 'QWK', 'EMAIL', etc.
// Returns { allowed: true/false, reason: string }
function checkTransportAccess(userSession, transportType) {
  var upperType = (transportType || '').toUpperCase();
  var rules = TRANSPORT_ACCESS_RULES[upperType];

  if (!rules) {
    // Unknown transport — deny by default, log for investigation
    return { allowed: false, reason: 'unknown_transport' };
  }

  var perms = Array.isArray(userSession.permissionflags) ? userSession.permissionflags : [];
  var restrictions = Array.isArray(userSession.restrictionflags) ? userSession.restrictionflags : [];
  var isSysop = perms.includes('Sysop');

  // Restriction flags always win — even over Sysop
  if (rules.restrictionFlag && restrictions.includes(rules.restrictionFlag)) {
    return { allowed: false, reason: 'restricted' };
  }

  // If no permission flag is required, access is allowed (default-allow transports like LOCAL)
  if (!rules.permissionFlag) {
    return { allowed: true, reason: 'default_allow' };
  }

  // Sysop bypasses permission flag requirements
  if (isSysop) {
    return { allowed: true, reason: 'sysop' };
  }

  // Check for the required permission flag
  if (perms.includes(rules.permissionFlag)) {
    return { allowed: true, reason: 'permitted' };
  }

  // No permission
  return { allowed: false, reason: 'no_permission' };
}

// Return the list of transport types a user is allowed to send via.
// Useful for the compose UI to know which buttons/forms to show.
function getAllowedTransports(userSession) {
  var allowed = [];
  for (var transportType of Object.keys(TRANSPORT_ACCESS_RULES)) {
    var check = checkTransportAccess(userSession, transportType);
    if (check.allowed) {
      allowed.push(transportType);
    }
  }
  return allowed;
}

// ============================================================
// Resolution
// ============================================================

// Generate an additional fullname lookup candidate from a dot-separated
// local-part. "kostie.muirhead" → "kostie muirhead" (matched
// case-insensitively against users.fullname in the DB layer).
//
// This mirrors imapAdapter.networkEmailAddress() which slugifies a
// user's display name as `lowercase + whitespace → dots` for the SMTP
// local-part on outbound. Applying the reverse transformation here
// makes the convention round-trip so VRFY and RCPT TO probes arriving
// from external mailers with <first.last@domain> can verify against
// the same users whose outbound mail uses that form.
//
// Returns null if there are no dots to transform (caller should just
// use the original string).
function _dottedLocalToFullname(input) {
  if (!input || input.indexOf('.') < 0) return null;
  var candidate = input.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  return candidate || null;
}

// Resolve a to_user display name to a local user account.
// Returns { resolved: true, userId, username } or { resolved: false, reason }
async function resolveRecipient(toUser) {
  if (!toUser || !toUser.trim()) {
    return { resolved: false, reason: 'empty_to_user' };
  }

  var trimmed = toUser.trim();

  // 1. Exact username match (case-insensitive). Handles "kostie" and
  //    also legitimate dotted usernames like "dr.smith" before the
  //    dotted-realname fallback kicks in, so the latter can't shadow
  //    a real username that happens to contain a dot.
  var userByName = await userAccounts.getUserRecord(trimmed);
  if (userByName) {
    return { resolved: true, userId: userByName.id, username: userByName.username };
  }

  // 2. Realname match — check for ambiguity first. Matches on the
  //    as-typed form so "Kostie Muirhead" works for terminal/web
  //    compose where the user types their real name directly.
  var realnameMatches = await userAccounts.getUsersByRealname(trimmed);
  if (realnameMatches.length === 1) {
    return { resolved: true, userId: realnameMatches[0].id, username: realnameMatches[0].username };
  }
  if (realnameMatches.length > 1) {
    return { resolved: false, reason: 'ambiguous_match' };
  }

  // 3. Dotted-local-part realname fallback. "first.last" → "first last"
  //    so external mailers using the imap convention can verify and
  //    deliver to local users by realname. Only fires if the input
  //    actually contains a dot, so plain-username lookups are unaffected.
  var dottedCandidate = _dottedLocalToFullname(trimmed);
  if (dottedCandidate && dottedCandidate !== trimmed) {
    var dottedMatches = await userAccounts.getUsersByRealname(dottedCandidate);
    if (dottedMatches.length === 1) {
      return { resolved: true, userId: dottedMatches[0].id, username: dottedMatches[0].username };
    }
    if (dottedMatches.length > 1) {
      return { resolved: false, reason: 'ambiguous_match' };
    }
  }

  // 4. Sysop alias fallback
  var sysopAliases = ['sysop', 'system operator', 'sysadmin'];
  if (sysopAliases.includes(trimmed.toLowerCase())) {
    var sysopUsers = await userAccounts.getUsersByPermissionFlag('Sysop');
    if (sysopUsers.length > 0) {
      // Deliver to the first sysop by id (lowest = oldest account)
      sysopUsers.sort(function(a, b) { return a.id - b.id; });
      return { resolved: true, userId: sysopUsers[0].id, username: sysopUsers[0].username };
    }
  }

  return { resolved: false, reason: 'no_user_match' };
}

// Check if to_user is an automated processor name
function isAutomatedProcessor(toUser) {
  if (!toUser) return false;
  return AUTOMATED_PROCESSORS.includes(toUser.trim().toLowerCase());
}

// ============================================================
// Inbox — Delivery
// ============================================================

// Main delivery path. Expects a fully populated messageObj:
//   { user_id, from_user, to_user, from_address, to_address, subject,
//     body_text, utf8, raw_text, transport_type, transport_data, system_time }
// Runs dupe check, body_html generation, sanitization, then inserts.
// Returns { status, duplicate, insertId, errormessages }
async function deliverMessage(messageObj) {
  var retObj = {
    status: false,
    duplicate: false,
    insertId: null,
    errormessages: []
  };

  // Dupe check: msg_id + transport_type + user_id + subject + body length.
  // Some FTN implementations (notably SBBSecho areafix) reuse the same MSGID
  // across multiple distinct messages (split replies, related responses).
  // Including subject and body length prevents false dupe rejection while
  // still catching true duplicates (identical message delivered twice).
  if (messageObj.msg_id) {
    var bodyLen = (messageObj.body_text || '').length;
    var existing = await postgres.queryOne(
      "SELECT id FROM pm_inbox WHERE msg_id = $1 AND transport_type = $2 AND user_id = $3 AND subject = $4 AND LENGTH(COALESCE(body_text, '')) = $5",
      [messageObj.msg_id, messageObj.transport_type, messageObj.user_id, messageObj.subject || '', bodyLen]
    );
    if (existing) {
      retObj.status = true;
      retObj.duplicate = true;
      return retObj;
    }
  }

  // Sanitize text fields
  sanitizeMessageFields(messageObj);

  // Generate body_html from display text
  var displayText = messageObj.utf8 || messageObj.body_text || '';
  if (displayText && typeof displayText === 'string' && displayText.trim().length > 0) {
    try {
      var generatedHtml = formatBodyHtml(displayText);
      if (generatedHtml && typeof generatedHtml === 'string' && generatedHtml.trim().length > 0) {
        messageObj.body_html = generatedHtml;
      } else {
        // formatBodyHtml returned empty/non-string — fall back to simple conversion
        alogger.writeAlog(3, "PM body_html generation returned empty, using simple conversion", "yellow");
        messageObj.body_html = simpleTextToHtml(displayText);
      }
    } catch (error) {
      alogger.writeAlog(3, "PM body_html generation failed: " + error.message + " — using simple conversion", "yellow");
      messageObj.body_html = simpleTextToHtml(displayText);
    }
  } else {
    messageObj.body_html = null;
  }

  // Build insert object
  var insertObj = {
    uuid: messageObj.uuid || uuidv4(),
    user_id: messageObj.user_id,
    msg_id: messageObj.msg_id || null,
    from_user: messageObj.from_user || '',
    to_user: messageObj.to_user || '',
    from_address: messageObj.from_address || '',
    to_address: messageObj.to_address || '',
    subject: messageObj.subject || '',
    body_text: messageObj.body_text || '',
    utf8: messageObj.utf8 || null,
    body_html: messageObj.body_html || null,
    raw_text: messageObj.raw_text || null,
    read: false,
    transport_type: messageObj.transport_type,
    transport_data: JSON.stringify(messageObj.transport_data || {}),
    system_time: messageObj.system_time || new Date()
  };

  var result = await postgres.insertObject(insertObj, 'pm_inbox');
  if (result.status) {
    retObj.status = true;
    retObj.insertId = result.insertId;
    retObj.uuid = insertObj.uuid;

    // Notify recipient
    try {
      var notif = await import('./notifications.js');
      await notif.create(messageObj.user_id, 'pm_received',
        'New PM from ' + (messageObj.from_user || 'Unknown'),
        messageObj.subject || '(no subject)',
        { link: '/pm/inbox', icon: 'envelope', severity: 'info' }
      );
    } catch (_) {}
  } else {
    retObj.errormessages = result.errormessages;
    alogger.writeAlog(2, "PM delivery failed: " + result.errormessages.join(', '), "redbright");
  }

  return retObj;
}

// ============================================================
// Inbox — Reading
// ============================================================

// Paginated inbox listing. Excludes deleted by default.
// Options: { limit, offset, unreadOnly }
async function getInbox(userId, options) {
  var opts = options || {};
  var limit = opts.limit || 50;
  var offset = opts.offset || 0;

  var whereClause = "WHERE user_id = $1 AND deleted = false";
  var params = [userId];
  var paramIdx = 2;

  if (opts.unreadOnly) {
    whereClause += " AND read = false";
  }

  var sql = "SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
    "read, read_at, transport_type, system_time, created_at " +
    "FROM pm_inbox " + whereClause +
    " ORDER BY system_time DESC LIMIT $" + paramIdx + " OFFSET $" + (paramIdx + 1);
  params.push(limit, offset);

  return await postgres.query(sql, params);
}

// Trash listing — soft-deleted messages
async function getTrash(userId, options) {
  var opts = options || {};
  var limit = opts.limit || 50;
  var offset = opts.offset || 0;

  // UNION inbox and outbox deleted messages with a source column
  var sql = "(SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
    "transport_type, system_time, deleted_at, 'inbox' AS source " +
    "FROM pm_inbox WHERE user_id = $1 AND deleted = true) " +
    "UNION ALL " +
    "(SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
    "transport_type, system_time, deleted_at, 'sent' AS source " +
    "FROM pm_outbox WHERE user_id = $1 AND deleted = true) " +
    "ORDER BY deleted_at DESC LIMIT $2 OFFSET $3";

  return await postgres.query(sql, [userId, limit, offset]);
}

// Single message fetch. Validates user_id ownership. Marks read on first access.
async function getMessage(userId, uuid) {
  var row = await postgres.queryOne(
    "SELECT * FROM pm_inbox WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
  if (!row) return null;

  // Mark read on first access
  if (!row.read) {
    await postgres.write(
      "UPDATE pm_inbox SET read = true, read_at = NOW(), updated_at = NOW() WHERE id = $1",
      [row.id]
    );
    row.read = true;
    row.read_at = new Date();
    getPmEventPublisher().publish(EVENTS.PM_READ_CHANGED, {
      userId: userId, pmId: row.id, read: true, source: 'model'
    });
  }

  return row;
}

// ============================================================
// Inbox — State Management
// ============================================================

async function markRead(userId, uuid) {
  var result = await postgres.write(
    "UPDATE pm_inbox SET read = true, read_at = NOW(), updated_at = NOW() WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
  getPmEventPublisher().publish(EVENTS.PM_READ_CHANGED, {
    userId: userId, read: true, source: 'model'
  });
  return result;
}

async function markUnread(userId, uuid) {
  var result = await postgres.write(
    "UPDATE pm_inbox SET read = false, read_at = NULL, updated_at = NOW() WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
  getPmEventPublisher().publish(EVENTS.PM_READ_CHANGED, {
    userId: userId, read: false, source: 'model'
  });
  return result;
}

async function markAllRead(userId) {
  var result = await postgres.write(
    "UPDATE pm_inbox SET read = true, read_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND read = false AND deleted = false",
    [userId]
  );
  getPmEventPublisher().publish(EVENTS.PM_READ_CHANGED, {
    userId: userId, read: true, source: 'model'
  });
  return result;
}

// Unread count for nav badge (excludes deleted)
async function getUnreadCount(userId) {
  var row = await postgres.queryOne(
    "SELECT COUNT(*) FROM pm_inbox WHERE user_id = $1 AND read = false AND deleted = false",
    [userId]
  );
  return row ? parseInt(row.count) : 0;
}

// ============================================================
// Inbox — Soft Delete / Trash
// ============================================================

async function deleteMessage(userId, uuid) {
  return await postgres.write(
    "UPDATE pm_inbox SET deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
}

async function restoreMessage(userId, uuid) {
  return await postgres.write(
    "UPDATE pm_inbox SET deleted = false, deleted_at = NULL, updated_at = NOW() WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
}

// Soft delete for outbox messages
async function deleteSentMessage(userId, uuid) {
  return await postgres.write(
    "UPDATE pm_outbox SET deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
}

async function restoreSentMessage(userId, uuid) {
  return await postgres.write(
    "UPDATE pm_outbox SET deleted = false, deleted_at = NULL, updated_at = NOW() WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
}

// Maintenance: hard-delete messages older than retention period from both tables
async function purgeDeleted(retentionDays) {
  var days = retentionDays || appConfig.getNumber('pm_trash_retention_days', 30);

  // Get UUIDs of messages to purge (for attachment cleanup)
  var inboxUuids = await postgres.query(
    "SELECT uuid FROM pm_inbox WHERE deleted = true AND deleted_at < NOW() - ($1 || ' days')::interval",
    [days.toString()]
  );
  var outboxUuids = await postgres.query(
    "SELECT uuid FROM pm_outbox WHERE deleted = true AND deleted_at < NOW() - ($1 || ' days')::interval",
    [days.toString()]
  );

  // Clean up attachments before deleting messages
  var pmAtt = null;
  try { pmAtt = await import('./pmAttachments.js'); } catch (_) {}
  if (pmAtt) {
    for (var row of (inboxUuids || [])) {
      await pmAtt.deleteAttachments(row.uuid);
    }
    for (var row of (outboxUuids || [])) {
      await pmAtt.deleteAttachments(row.uuid);
    }
  }

  var inboxResult = await postgres.query(
    "DELETE FROM pm_inbox WHERE deleted = true AND deleted_at < NOW() - ($1 || ' days')::interval RETURNING id",
    [days.toString()]
  );

  var outboxResult = await postgres.query(
    "DELETE FROM pm_outbox WHERE deleted = true AND deleted_at < NOW() - ($1 || ' days')::interval RETURNING id",
    [days.toString()]
  );

  var inboxCount = inboxResult ? inboxResult.length : 0;
  var outboxCount = outboxResult ? outboxResult.length : 0;

  if (inboxCount > 0 || outboxCount > 0) {
    alogger.writeAlog(1, "PM trash purge: " + inboxCount + " inbox, " + outboxCount + " outbox messages removed", "cyan");
  }

  return { inboxPurged: inboxCount, outboxPurged: outboxCount };
}

// ============================================================
// Outbox
// ============================================================

// Queue a message for sending. For LOCAL transport, also delivers to recipient inbox.
// messageObj needs: user_id (sender), to_user, from_user, from_address, to_address,
//   subject, body_text, transport_type, transport_data
// For LOCAL: transport_data should have { recipient_user_id }
// userSession is optional — when provided (web routes), transport access is enforced.
// When omitted (system-level calls), access check is skipped.
async function queueMessage(messageObj, userSession) {
  var retObj = {
    status: false,
    outboxId: null,
    deliveryResult: null,
    errormessages: []
  };

  // Enforce transport access if a user session is provided
  if (userSession) {
    var accessCheck = checkTransportAccess(userSession, messageObj.transport_type);
    if (!accessCheck.allowed) {
      retObj.errormessages.push("You do not have permission to send " + (messageObj.transport_type || 'unknown') + " messages");
      return retObj;
    }
  }

  // Sanitize
  sanitizeMessageFields(messageObj);

  // Generate body_html for the outbox copy
  var displayText = messageObj.utf8 || messageObj.body_text || '';
  if (displayText && typeof displayText === 'string' && displayText.trim().length > 0) {
    try {
      var generatedHtml = formatBodyHtml(displayText);
      if (generatedHtml && typeof generatedHtml === 'string' && generatedHtml.trim().length > 0) {
        messageObj.body_html = generatedHtml;
      } else {
        messageObj.body_html = simpleTextToHtml(displayText);
      }
    } catch (error) {
      messageObj.body_html = simpleTextToHtml(displayText);
    }
  } else {
    messageObj.body_html = null;
  }

  var outboxUuid = messageObj.uuid || uuidv4();
  var isLocal = messageObj.transport_type === 'LOCAL';

  // Insert into outbox
  var outboxObj = {
    uuid: outboxUuid,
    user_id: messageObj.user_id,
    msg_id: messageObj.msg_id || uuidv4(),
    from_user: messageObj.from_user || '',
    to_user: messageObj.to_user || '',
    from_address: messageObj.from_address || '',
    to_address: messageObj.to_address || '',
    subject: messageObj.subject || '',
    body_text: messageObj.body_text || '',
    utf8: messageObj.utf8 || null,
    body_html: messageObj.body_html || null,
    raw_text: messageObj.raw_text || null,
    transport_type: messageObj.transport_type,
    transport_data: JSON.stringify(messageObj.transport_data || {}),
    queued: !isLocal,
    sent: isLocal,
    sent_at: isLocal ? new Date() : null,
    system_time: messageObj.system_time || new Date()
  };

  var outboxResult = await postgres.insertObject(outboxObj, 'pm_outbox');
  if (!outboxResult.status) {
    retObj.errormessages = outboxResult.errormessages;
    return retObj;
  }

  retObj.outboxId = outboxResult.insertId;
  retObj.outboxUuid = outboxUuid;

  // For non-LOCAL transports, signal the worker to toss outbound.
  // This triggers the next toss cycle immediately rather than waiting
  // for the scheduled poll.  Works from both web routes and terminal.
  if (!isLocal) {
    await _triggerOutboundToss(messageObj.transport_type);
  }

  // For LOCAL: deliver directly to recipient inbox
  if (isLocal) {
    var recipientId = messageObj.transport_data && messageObj.transport_data.recipient_user_id;
    if (!recipientId) {
      retObj.errormessages.push("LOCAL message missing recipient_user_id in transport_data");
      return retObj;
    }

    var inboxMsg = Object.assign({}, messageObj, {
      uuid: uuidv4(),
      user_id: recipientId,
      msg_id: outboxObj.msg_id,
      transport_data: {
        sender_user_id: messageObj.user_id,
        recipient_user_id: recipientId,
        outbox_uuid: outboxUuid
      }
    });

    var deliveryResult = await deliverMessage(inboxMsg);
    retObj.deliveryResult = deliveryResult;
    if (!deliveryResult.status) {
      retObj.errormessages.push("Local delivery failed: " + deliveryResult.errormessages.join(', '));
      return retObj;
    }

    // Notify other processes (IMAP IDLE push, gateway unread badge)
    getPmEventPublisher().publish(EVENTS.PM_DELIVERED, {
      userId: recipientId,
      fromUser: messageObj.from_user
    });
  }

  retObj.status = true;
  return retObj;
}

// Queue an outbound message without local delivery logic.
// Used for system-level operations like relay forwarding where there is
// no local sender user. Inserts directly into pm_outbox as queued.
async function queueOutbound(messageObj) {
  var insertObj = {
    uuid: messageObj.uuid || uuidv4(),
    user_id: messageObj.user_id || 0,
    msg_id: messageObj.msg_id || null,
    from_user: messageObj.from_user || '',
    to_user: messageObj.to_user || '',
    from_address: messageObj.from_address || '',
    to_address: messageObj.to_address || '',
    subject: messageObj.subject || '',
    body_text: messageObj.body_text || '',
    utf8: messageObj.utf8 || null,
    body_html: messageObj.body_html || null,
    raw_text: messageObj.raw_text || null,
    transport_type: messageObj.transport_type,
    transport_data: JSON.stringify(messageObj.transport_data || {}),
    queued: true,
    sent: false,
    system_time: messageObj.system_time || new Date()
  };

  var result = await postgres.insertObject(insertObj, 'pm_outbox');

  // Signal outbound toss for the transport
  if (result.status && messageObj.transport_type) {
    await _triggerOutboundToss(messageObj.transport_type);
  }

  return result;
}

// Paginated sent messages listing. Excludes deleted.
async function getSentMessages(userId, options) {
  var opts = options || {};
  var limit = opts.limit || 50;
  var offset = opts.offset || 0;

  var sql = "SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
    "transport_type, queued, sent, sent_at, send_error, system_time, created_at " +
    "FROM pm_outbox WHERE user_id = $1 AND deleted = false " +
    "ORDER BY system_time DESC LIMIT $2 OFFSET $3";

  return await postgres.query(sql, [userId, limit, offset]);
}

// View a single sent message
async function getSentMessage(userId, uuid) {
  return await postgres.queryOne(
    "SELECT * FROM pm_outbox WHERE uuid = $1 AND user_id = $2",
    [uuid, userId]
  );
}

// Tosser entry point: get unsent messages for a transport type
async function getPendingByTransport(transportType) {
  return await postgres.query(
    "SELECT * FROM pm_outbox WHERE transport_type = $1 AND sent = false AND queued = true AND undeliverable = false AND deleted = false ORDER BY created_at ASC",
    [transportType]
  );
}

// Mark a single message as sent
async function markSent(id, tosserName) {
  return await postgres.write(
    "UPDATE pm_outbox SET sent = true, queued = false, sent_at = NOW(), updated_at = NOW() WHERE id = $1",
    [id]
  );
}

// Mark multiple messages as sent
async function markSentArray(ids, tosserName) {
  if (!ids || ids.length === 0) return null;
  return await postgres.write(
    "UPDATE pm_outbox SET sent = true, queued = false, sent_at = NOW(), updated_at = NOW() WHERE id = ANY($1)",
    [ids]
  );
}

// Record a delivery failure (transient — tosser may retry)
async function markSendError(id, errorText) {
  return await postgres.write(
    "UPDATE pm_outbox SET send_error = $2, updated_at = NOW() WHERE id = $1",
    [id, errorText]
  );
}

// Mark an outbound message as permanently undeliverable.
// Stops the tosser from retrying and notifies the sender.
// reason: human-readable explanation (e.g. "zone 99 not found on any configured FTN network")
async function markOutboxUndeliverable(id, reason) {
  await postgres.write(
    "UPDATE pm_outbox SET undeliverable = true, undeliverable_reason = $2, queued = false, updated_at = NOW() WHERE id = $1",
    [id, reason]
  );

  // Notify the sender
  var pmRow = await postgres.queryOne("SELECT * FROM pm_outbox WHERE id = $1", [id]);
  if (pmRow && pmRow.user_id && pmRow.user_id > 0) {
    await notifySenderUndeliverable(pmRow, reason);
  }
}

// Deliver a bounce notification to the sender of an undeliverable outbound message.
// Creates a LOCAL system message in their inbox explaining the failure.
async function notifySenderUndeliverable(pmRow, reason) {
  var bodyText = "Your message could not be delivered.\n\n" +
    "To: " + (pmRow.to_user || '(unknown)') + "\n" +
    "Address: " + (pmRow.to_address || '(none)') + "\n" +
    "Subject: " + (pmRow.subject || '(none)') + "\n" +
    "Transport: " + (pmRow.transport_type || 'unknown') + "\n\n" +
    "Reason: " + reason + "\n\n" +
    "This message will not be retried. If the address is incorrect, " +
    "you can compose a new message with the corrected address.";

  var bounceMsg = {
    user_id: pmRow.user_id,
    from_user: 'SYSTEM',
    to_user: pmRow.from_user || 'User',
    from_address: 'SYSTEM',
    to_address: pmRow.from_user || '',
    subject: 'Undeliverable: ' + (pmRow.subject || '(no subject)'),
    body_text: bodyText,
    utf8: bodyText,
    transport_type: 'LOCAL',
    transport_data: {
      system_notification: true,
      bounce_for_outbox_id: pmRow.id,
      original_transport: pmRow.transport_type
    },
    system_time: new Date()
  };

  await deliverMessage(bounceMsg);
}

// ============================================================
// Undeliverable
// ============================================================

// Insert a message that couldn't be delivered to a local user
async function insertUndeliverable(messageObj, reason) {
  var insertObj = {
    uuid: messageObj.uuid || uuidv4(),
    msg_id: messageObj.msg_id || null,
    from_user: messageObj.from_user || '',
    to_user: messageObj.to_user || '',
    from_address: messageObj.from_address || '',
    to_address: messageObj.to_address || '',
    subject: messageObj.subject || '',
    body_text: messageObj.body_text || '',
    utf8: messageObj.utf8 || null,
    body_html: messageObj.body_html || null,
    raw_text: messageObj.raw_text || null,
    transport_type: messageObj.transport_type,
    transport_data: JSON.stringify(messageObj.transport_data || {}),
    reason: reason,
    system_time: messageObj.system_time || new Date()
  };

  var result = await postgres.insertObject(insertObj, 'pm_undeliverable');
  if (!result.status) {
    alogger.writeAlog(2, "Failed to insert undeliverable PM: " + result.errormessages.join(', '), "redbright");
  }

  // Notify sysop
  try {
    var notif = await import('./notifications.js');
    await notif.createSysop('pm_undeliverable',
      'Undeliverable PM to "' + (messageObj.to_user || 'unknown') + '"',
      'From: ' + (messageObj.from_user || 'unknown') + ', Subject: ' + (messageObj.subject || '(none)') + ', Reason: ' + (reason || 'unknown'),
      { severity: 'warning', icon: 'envelope-x', link: '/pm/undeliverable' }
    );
  } catch (_) {}

  return result;
}

// Admin/sysop: list undeliverable messages
async function getUndeliverableList(options) {
  var opts = options || {};
  var limit = opts.limit || 50;
  var offset = opts.offset || 0;
  var reviewedFilter = opts.reviewed;

  var whereClause = "WHERE 1=1";
  var params = [];
  var paramIdx = 1;

  if (reviewedFilter === true) {
    whereClause += " AND reviewed = true";
  } else if (reviewedFilter === false) {
    whereClause += " AND reviewed = false";
  }
  // else: no filter, show all

  var sql = "SELECT id, uuid, from_user, from_address, to_user, to_address, subject, " +
    "transport_type, reason, reviewed, reviewed_at, action_taken, system_time, created_at " +
    "FROM pm_undeliverable " + whereClause +
    " ORDER BY created_at DESC LIMIT $" + paramIdx + " OFFSET $" + (paramIdx + 1);
  params.push(limit, offset);

  return await postgres.query(sql, params);
}

// Get single undeliverable message (full detail for review)
async function getUndeliverableMessage(uuid) {
  return await postgres.queryOne(
    "SELECT * FROM pm_undeliverable WHERE uuid = $1",
    [uuid]
  );
}

// Sysop review action
// Actions: 'delivered' (deliver to a user), 'deleted', 'forwarded', 'returned'
async function reviewMessage(id, reviewerUserId, action, deliverToUserId) {
  var retObj = {
    status: false,
    errormessages: []
  };

  // If delivering, move it into the target user's inbox
  if (action === 'delivered' && deliverToUserId) {
    var undeliverable = await postgres.queryOne(
      "SELECT * FROM pm_undeliverable WHERE id = $1",
      [id]
    );
    if (!undeliverable) {
      retObj.errormessages.push("Undeliverable message not found");
      return retObj;
    }

    var inboxMsg = {
      user_id: deliverToUserId,
      msg_id: undeliverable.msg_id,
      from_user: undeliverable.from_user,
      to_user: undeliverable.to_user,
      from_address: undeliverable.from_address,
      to_address: undeliverable.to_address,
      subject: undeliverable.subject,
      body_text: undeliverable.body_text,
      utf8: undeliverable.utf8,
      raw_text: undeliverable.raw_text,
      transport_type: undeliverable.transport_type,
      transport_data: typeof undeliverable.transport_data === 'string'
        ? JSON.parse(undeliverable.transport_data)
        : undeliverable.transport_data,
      system_time: undeliverable.system_time
    };

    var deliveryResult = await deliverMessage(inboxMsg);
    if (!deliveryResult.status) {
      retObj.errormessages = deliveryResult.errormessages;
      return retObj;
    }
  }

  // Mark as reviewed
  var err = await postgres.write(
    "UPDATE pm_undeliverable SET reviewed = true, reviewed_at = NOW(), reviewed_by = $2, action_taken = $3, delivered_to = $4, updated_at = NOW() WHERE id = $1",
    [id, reviewerUserId, action, deliverToUserId || null]
  );

  if (err) {
    retObj.errormessages.push("Failed to update review status: " + err.message);
    return retObj;
  }

  retObj.status = true;
  return retObj;
}

// ============================================================
// Sysop Notifications
// ============================================================

// Deliver a system notification to all users with the Sysop permission flag.
// from_user is "SYSTEM", transport_type is LOCAL.
async function notifySysops(subject, bodyText) {
  var sysopUsers = await userAccounts.getUsersByPermissionFlag('Sysop');

  if (!sysopUsers || sysopUsers.length === 0) {
    alogger.writeAlog(3, "notifySysops: No sysop-flagged users found, notification not delivered: " + subject, "yellow");
    return { delivered: 0 };
  }

  var delivered = 0;
  for (var sysop of sysopUsers) {
    var msgObj = {
      user_id: sysop.id,
      from_user: 'SYSTEM',
      to_user: sysop.username,
      from_address: 'SYSTEM',
      to_address: sysop.username,
      subject: subject,
      body_text: bodyText,
      utf8: bodyText,
      transport_type: 'LOCAL',
      transport_data: { sender_user_id: null, system_notification: true },
      system_time: new Date()
    };

    var result = await deliverMessage(msgObj);
    if (result.status && !result.duplicate) {
      delivered++;
    }
  }

  alogger.writeAlog(1, "System notification delivered to " + delivered + " sysop(s): " + subject, "cyan");
  return { delivered: delivered };
}

export {
  // Access Control
  checkTransportAccess,
  getAllowedTransports,
  // Resolution
  resolveRecipient,
  isAutomatedProcessor,
  _dottedLocalToFullname,
  // Inbox
  deliverMessage,
  getInbox,
  getTrash,
  getMessage,
  markRead,
  markUnread,
  markAllRead,
  getUnreadCount,
  deleteMessage,
  restoreMessage,
  deleteSentMessage,
  restoreSentMessage,
  purgeDeleted,
  // Outbox
  queueMessage,
  queueOutbound,
  getSentMessages,
  getSentMessage,
  getPendingByTransport,
  markSent,
  markSentArray,
  markSendError,
  markOutboxUndeliverable,
  // Undeliverable
  insertUndeliverable,
  getUndeliverableList,
  getUndeliverableMessage,
  reviewMessage,
  // Notifications
  notifySysops
};
