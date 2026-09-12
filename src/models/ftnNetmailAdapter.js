// ftnNetmailAdapter.js — FTN Netmail ↔ Private Message adapter
// Converts between FTN Message objects (from ftnClasses.js) and the
// unified pm_inbox/pm_outbox schema. Handles the FTN-specific parts
// of the inbound resolution cascade (system address check, relay logic,
// processor routing) before handing off to privateMessages.js.

import * as privateMessages from './privateMessages.js';
import * as ftnRouter from './ftnRouter.js';
import * as systemAddresses from './systemAddresses.js';
import { Message } from './ftnClasses.js';
import * as alogger from '../utils/alogger.js';
import * as fs from 'fs';
import * as path from 'path';
import * as postgres from '../middleware/db/postgres.js';
import { storeAttachments } from './pmAttachments.js';
import * as netmailRoutes from './netmailRoutes.js';
import { resolveFileboxPath } from '../utils/fileboxPath.js';
import * as ftnVia from '../utils/ftnVia.js';
import * as ftnNodelist from './ftnNodelist.js';
import { parseFtnAddress } from './ftnRouter.js';
import appConfig from "../config/appConfig.js";
import * as netmailRelayLog from './netmailRelayLog.js';
import { v4 as uuidv4 } from 'uuid';

// ============================================================
// Inbound: FTN Message → PM system
// ============================================================

// Main entry point for inbound FTN netmail. Replaces netmail.newInboundNetmail().
// Returns { status, duplicate, imported, relayed, undeliverable, processor, errormessages }
async function importFtnNetmail(ftnMessage, pktOrigin) {
  var retObj = {
    status: false,
    duplicate: false,
    imported: false,
    relayed: false,
    undeliverable: false,
    processor: null,
    errormessages: []
  };

  // Build the common message object with FTN transport_data
  var pmObj = ftnToPrivateMessage(ftnMessage);

  // --- Step 1: Is the destination address ours? ---
  var isLocal = await isLocalAddress(pmObj.to_address);

  if (!isLocal) {
    // Transit/relay mail
    var relayMode = currentRelayMode();
    var relayGate = { allowed: relayMode === RELAY_ON, reason: 'relay is off' };

    // Every outcome below writes one row. Refusals matter as much as relays:
    // a gate nobody can see refusing anything is a gate nobody can validate.
    var logBase = relayLogBase(pmObj, relayMode, pktOrigin);

    if (relayMode === RELAY_NODELIST) {
      relayGate = await relayAllowedByNodelist(pmObj.from_address, pmObj.to_address);
      if (!relayGate.allowed) {
        alogger.writeAlog(2, "FTN netmail relay refused (nodelist): " +
          pmObj.from_address + " -> " + pmObj.to_address + ": " + relayGate.reason, "yellow");
      }
    }

    if (relayGate.allowed) {
      var relayResult = await relayNetmail(ftnMessage, pmObj);
      retObj.status = true;
      if (relayResult && relayResult.looped) {
        // Reported honestly rather than as a relay: the message went nowhere.
        retObj.undeliverable = true;
        retObj.relayLoop = true;
        await netmailRelayLog.logDecision(Object.assign({}, logBase, {
          decision: netmailRelayLog.RELAY_LOOP,
          reason: 'already passed through this system, per the Via chain'
        }));
      } else if (relayResult && relayResult.norouted) {
        retObj.undeliverable = true;
        await netmailRelayLog.logDecision(Object.assign({}, logBase, {
          decision: netmailRelayLog.RELAY_NO_ROUTE,
          reason: relayResult.reason || 'no route to ' + pmObj.to_address
        }));
      } else {
        retObj.relayed = true;
        alogger.writeAlog(1, "FTN netmail relayed: " + pmObj.from_address + " → " + pmObj.to_address, "cyan");
        await netmailRelayLog.logDecision(Object.assign({}, logBase, {
          decision:     netmailRelayLog.RELAY_SENT,
          nextHop:      relayResult && relayResult.nextHop,
          routeMethod:  relayResult && relayResult.routeMethod,
          viaStamped:   relayResult && relayResult.viaStamped,
          // The netmail_out row, so delivery can be followed from here.
          outboundUuid: relayResult && relayResult.outboundUuid
        }));
      }
    } else {
      // Reject: write to bad dir, notify sysops
      await rejectRelay(ftnMessage, pmObj, relayMode, relayGate.reason);
      retObj.status = true;
      retObj.undeliverable = true;
      retObj.relayRefused = relayGate.reason;
      alogger.writeAlog(2, "FTN netmail relay rejected: " + pmObj.from_address + " → " + pmObj.to_address, "yellow");
      await netmailRelayLog.logDecision(Object.assign({}, logBase, {
        decision: netmailRelayLog.RELAY_REFUSED,
        reason: relayGate.reason
      }));
    }
    return retObj;
  }

  // --- Step 1.5: Custom sysop-configured routes ---
  // Matches on to_user (required) with optional from_user / from_addr
  // filters. First-match-wins by sort_order. Applies one of:
  //   - alias: rewrite to_user, fall through to Step 2+
  //   - dump: write as JSON, consume
  //   - ignore: consume silently (no PM, no undeliverable, no response).
  // File attachments are NOT touched -- they stay in the inbound dir for
  // wildcards / TIC / etc to handle independently.
  var routeMatch = await netmailRoutes.matchRoute({
    to_user:   ftnMessage.ToUser,
    from_user: ftnMessage.FromUser,
    from_addr: pmObj.from_address,
  });

  if (routeMatch) {
    if (routeMatch.log_level && routeMatch.log_level > 0) {
      alogger.writeAlog(routeMatch.log_level,
        "FTN netmail route '" + routeMatch.name + "' (" + routeMatch.action + ") matched: " +
        (ftnMessage.FromUser || '?') + " @ " + (pmObj.from_address || '?') +
        " -> " + (ftnMessage.ToUser || '?'),
        'cyan');
    }

    if (routeMatch.action === 'ignore') {
      retObj.status = true;
      retObj.routeMatched = routeMatch.name;
      retObj.routeAction = 'ignore';
      return retObj;
    }

    if (routeMatch.action === 'dump') {
      try {
        var dumpPath = await _dumpNetmailToJson(ftnMessage, pmObj, routeMatch.target);
        retObj.status = true;
        retObj.routeMatched = routeMatch.name;
        retObj.routeAction = 'dump';
        retObj.dumpPath = dumpPath;
      } catch (dumpErr) {
        alogger.writeAlog(2,
          "FTN netmail route dump failed for '" + routeMatch.name + "': " + dumpErr.message,
          'redbright');
        // Fall through to undeliverable path so the sysop sees it rather
        // than silently losing the message on a bad dump config.
        await privateMessages.insertUndeliverable(pmObj, 'dump_failed: ' + dumpErr.message);
        retObj.status = true;
        retObj.undeliverable = true;
      }
      return retObj;
    }

    if (routeMatch.action === 'alias' && routeMatch.target) {
      var aliasedTo = routeMatch.target;
      ftnMessage.ToUser = aliasedTo;
      pmObj.to_user = aliasedTo;
      retObj.routeMatched = routeMatch.name;
      retObj.routeAction = 'alias';
      retObj.aliasedTo = aliasedTo;
      // Fall through to Step 2 (processor) / Step 3 (user resolve)
    }
  }

  // --- Step 2: Is to_user an automated processor? ---
  if (privateMessages.isAutomatedProcessor(ftnMessage.ToUser)) {
    retObj.status = true;
    retObj.processor = ftnMessage.ToUser.trim().toLowerCase();
    alogger.writeAlog(1, "FTN netmail routed to processor: " + retObj.processor, "cyan");

    // Route to the appropriate processor handler
    if (retObj.processor === 'areafix' || retObj.processor === 'areamgr') {
      try {
        var areafix = await import('./areafix.js');
        var afResult = await areafix.handleRequest(ftnMessage);
        if (afResult.responseLines && afResult.responseLines.length > 0) {
          retObj.responseMessage = areafix.buildResponse(ftnMessage, afResult.responseLines, 'AreaFix');
        }
      } catch (afErr) {
        alogger.writeAlog(3, "AreaFix handler error: " + afErr.message, "redbright");
      }
    } else if (retObj.processor === 'ping') {
      try {
        var netmailPing = await import('./netmailPing.js');
        var pingResult = await netmailPing.handleRequest(ftnMessage);
        if (pingResult.responseLines && pingResult.responseLines.length > 0) {
          retObj.responseMessage = netmailPing.buildResponse(
            ftnMessage, pingResult.responseLines, netmailPing.PROCESSOR_NAME);
        }
      } catch (pingErr) {
        alogger.writeAlog(3, "Ping handler error: " + pingErr.message, "redbright");
      }
    } else if (retObj.processor === 'filefix' || retObj.processor === 'filemgr' || retObj.processor === 'tic') {
      try {
        var filefix = await import('./filefix.js');
        var ffResult = await filefix.handleRequest(ftnMessage);
        if (ffResult.responseLines && ffResult.responseLines.length > 0) {
          retObj.responseMessage = filefix.buildResponse(ftnMessage, ffResult.responseLines, 'FileFix');
        }
      } catch (ffErr) {
        alogger.writeAlog(3, "FileFix handler error: " + ffErr.message, "redbright");
      }
    }

    return retObj;
  }

  // --- Step 3: Resolve to_user to a local account ---
  var resolution = await privateMessages.resolveRecipient(ftnMessage.ToUser);

  if (!resolution.resolved) {
    // Undeliverable — insert into review queue, notify sysops
    await privateMessages.insertUndeliverable(pmObj, resolution.reason);
    await privateMessages.notifySysops(
      "Undeliverable FTN Netmail",
      "Netmail to '" + (ftnMessage.ToUser || '(empty)') + "' at " + pmObj.to_address +
      " from " + (ftnMessage.FromUser || '(unknown)') + " at " + pmObj.from_address +
      " could not be delivered: " + resolution.reason +
      ".\n\nSubject: " + (ftnMessage.Subject || '(none)') +
      "\n\nMessage stored in the undeliverable review queue."
    );
    retObj.status = true;
    retObj.undeliverable = true;
    alogger.writeAlog(2, "FTN netmail undeliverable: to '" + ftnMessage.ToUser + "' — " + resolution.reason, "yellow");
    return retObj;
  }

  // --- Step 4: Deliver ---
  pmObj.user_id = resolution.userId;

  var deliveryResult = await privateMessages.deliverMessage(pmObj);
  retObj.status = deliveryResult.status;
  retObj.duplicate = deliveryResult.duplicate;
  retObj.imported = deliveryResult.status && !deliveryResult.duplicate;

  if (retObj.imported) {
    // Check for file-attach flag (bit 4 = 0x0010)
    var attr = parseInt(ftnMessage.Attribute) || 0;
    if ((attr & 0x0010) && deliveryResult.uuid) {
      await _processFileAttach(ftnMessage, deliveryResult.uuid);
    }

    alogger.writeAlog(1, "FTN netmail delivered: " + ftnMessage.FromUser + " → " + resolution.username + " (" + ftnMessage.Subject + ")" +
      ((attr & 0x0010) ? " [FILE ATTACH]" : ""), "green");
  } else if (retObj.duplicate) {
    alogger.writeAlog(1, "FTN netmail dupe skipped: " + (pmObj.msg_id || '(no msgid)'), "yellow");
  }

  if (deliveryResult.errormessages && deliveryResult.errormessages.length > 0) {
    retObj.errormessages = deliveryResult.errormessages;
  }

  return retObj;
}

// ============================================================
// Outbound: PM outbox row → FTN Message object
// ============================================================

// Convert a pm_outbox row (with transport_type='FTN') back into an FTN Message object
// suitable for WritePkts() / WritePktsToNode().
function privateMessageToFtn(pmRow) {
  var td = pmRow.transport_data;
  if (typeof td === 'string') {
    td = JSON.parse(td);
  }

  var msg = new Message();
  msg.Type = "Netmail";
  msg.FromUser = pmRow.from_user || '';
  msg.ToUser = pmRow.to_user || '';
  msg.Subject = pmRow.subject || '';
  msg.BodyText = pmRow.body_text || '';

  // Attribute: bit 0 = Private (required for netmail)
  // bit 4 = FileAttach (set by caller if attachments present)
  msg.Attribute = 0x0001;
  if (pmRow.has_attachments) {
    msg.Attribute |= 0x0010; // File-attach flag
  }
  msg.Cost = 0;

  // DateTime: FTN format "DD Mon YY  HH:MM:SS" (20 bytes with null terminator)
  // Use transport_data.datetime_string if available (inbound relay),
  // otherwise generate from the DB row's system_time or current time.
  if (td.datetime_string) {
    msg.DateTime = td.datetime_string;
  } else {
    msg.DateTime = formatFtnDateTime(pmRow.system_time || pmRow.created_at || new Date());
  }

  // Address fields
  msg.Source = td.source || pmRow.from_address || '';
  msg.Destination = td.destination || pmRow.to_address || '';
  msg.SourceZone = td.source_zone || 1;
  msg.SourceNet = td.source_net || 0;
  msg.SourceNode = td.source_node || 0;
  msg.DestinationZone = td.destination_zone || 1;
  msg.DestinationNet = td.destination_net || 0;
  msg.DestinationNode = td.destination_node || 0;

  // Identifiers
  msg.MsgId = td.msg_id || pmRow.msg_id || '';
  msg.ReplyTo = td.reply_to || '';
  msg.TosserId = td.tosser_id || '';
  msg.TZUTC = td.tz_utc || '';

  // FTN-specific fields
  msg.OriginLine = td.origin_line || '';
  msg.SeenBy = td.seen_by || '';
  msg.Path = td.path || '';

  // Optional attributes — restore from transport_data if present
  msg.OptionalAttributes = [];
  if (td.optional_attributes && Array.isArray(td.optional_attributes)) {
    msg.OptionalAttributes = td.optional_attributes;
  }

  // DB row id for marking sent after tosser writes the packet
  msg.Id = pmRow.id;

  return msg;
}

// ============================================================
// Conversion: FTN Message → PM object
// ============================================================

// Convert an FTN Message (from ReadPkt/processMessageText) into a
// privateMessages-compatible object. Does NOT set user_id — that's
// resolved by the cascade in importFtnNetmail().
function ftnToPrivateMessage(ftnMessage) {
  var source = ftnMessage.Source || '';
  var destination = ftnMessage.Destination || '';

  // Build transport_data with all FTN-specific metadata
  var transportData = {
    source: source,
    destination: destination,
    source_zone: ftnMessage.SourceZone || 1,
    source_net: ftnMessage.SourceNet || 0,
    source_node: ftnMessage.SourceNode || 0,
    destination_zone: ftnMessage.DestinationZone || 1,
    destination_net: ftnMessage.DestinationNet || 0,
    destination_node: ftnMessage.DestinationNode || 0,
    domain: ftnMessage.Domain || '',
    msg_id: ftnMessage.MsgId || '',
    reply_to: ftnMessage.ReplyTo || '',
    tosser_id: ftnMessage.TosserId || '',
    tz_utc: ftnMessage.TZUTC || '',
    origin_line: ftnMessage.OriginLine || '',
    seen_by: ftnMessage.SeenBy || '',
    path: ftnMessage.Path || '',
    datetime_string: ftnMessage.DateTime || ''
  };

  // Preserve full optional attributes array
  if (ftnMessage.OptionalAttributes && ftnMessage.OptionalAttributes.length > 0) {
    transportData.optional_attributes = ftnMessage.OptionalAttributes;
  }

  return {
    // user_id: set by caller after resolution
    msg_id: ftnMessage.MsgId || null,
    from_user: ftnMessage.FromUser || '',
    to_user: ftnMessage.ToUser || '',
    from_address: source,
    to_address: destination,
    subject: ftnMessage.Subject || '',
    body_text: ftnMessage.BodyText || '',
    utf8: ftnMessage.utf8 || ftnMessage.BodyText || '',
    raw_text: ftnMessage.RawText || '',
    transport_type: 'FTN',
    transport_data: transportData,
    system_time: ftnMessage.SystemTime || new Date()
  };
}

// ============================================================
// Helpers
// ============================================================

// Format a Date object as an FTN datetime string.
// FTS-0001 format: "DD Mon YY  HH:MM:SS" (two spaces between year and time)
// 19 characters + null terminator = 20 bytes in the packet.
function formatFtnDateTime(dateInput) {
  var d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) d = new Date();

  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var dd = String(d.getDate()).padStart(2, '0');
  var mon = months[d.getMonth()];
  var yy = String(d.getFullYear() % 100).padStart(2, '0');
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  var ss = String(d.getSeconds()).padStart(2, '0');

  return dd + ' ' + mon + ' ' + yy + '  ' + hh + ':' + mm + ':' + ss;
}

// Check if an FTN address is one of our system addresses
// Every FTN address this system answers to, as plain strings. Used for the
// relay loop check, which has to know all of them: a message that came back to
// a different AKA of ours is the same loop.
async function localAddressStrings() {
  try {
    var rows = await systemAddresses.getActiveAddressesByNetworkType('FTN');
    var out = [];
    for (var r of (rows || [])) {
      if (r.address) out.push(r.address);
    }
    return out;
  } catch (err) {
    alogger.writeAlog(3, "Could not load local addresses for relay loop check: " +
      err.message, "redbright");
    return [];
  }
}

async function isLocalAddress(addressString) {
  if (!addressString) return false;
  var row = await systemAddresses.getActiveAddressByNetworkType(addressString, 'FTN');
  return !!row;
}

// The fields every relay log row carries, whatever the decision was.
//
// from_address is who wrote the message; packet_source is who handed us the
// packet. They are the same for mail originated by the sender and different
// for transit, and keeping both is the only way to see which of your links is
// actually feeding you transit traffic.
function relayLogBase(pmObj, relayMode, pktOrigin) {
  var origin = pktOrigin || {};
  var attrs = (pmObj.transport_data && pmObj.transport_data.optional_attributes) || [];

  // The Via chain as it arrived, kept as text so another system's hop reads
  // back exactly as it was written.
  var viaIn = attrs
    .filter(function (a) { return a && /^via$/i.test(a.attribute || ''); })
    .map(function (a) { return a.value; })
    .join('\n');

  return {
    receivedAt:   new Date(),
    msgId:        pmObj.msg_id,
    fromUser:     pmObj.from_user,
    fromAddress:  pmObj.from_address,
    toUser:       pmObj.to_user,
    toAddress:    pmObj.to_address,
    subject:      pmObj.subject,
    packetSource: origin.packetSource || origin.peerAddress || null,
    relayMode:    relayMode,
    viaIn:        viaIn || null
  };
}

// Relay netmail through outbound routing
async function relayNetmail(ftnMessage, pmObj) {
  // Route the message via ftnRouter
  try {
    // Loop check first, before anything is queued. Two systems that route to
    // each other will otherwise pass the same message back and forth until a
    // sysop notices, and the Via chain is the only thing that can tell us we
    // have already handled it.
    var ourAddresses = await localAddressStrings();
    if (ftnVia.hasPassedThrough(ftnMessage.OptionalAttributes, ourAddresses)) {
      alogger.writeAlog(2,
        "FTN netmail relay: refusing loop, message already passed through this system (" +
        pmObj.from_address + " -> " + pmObj.to_address + ")", "yellow");
      await privateMessages.insertUndeliverable(pmObj, 'relay_loop');
      return { looped: true };
    }

    var routeResult = await ftnRouter.resolveRoute(pmObj.to_address);
    if (routeResult && routeResult.nextHop) {
      // Stamp our hop into the chain so the next system can do the same check,
      // and so the path is readable at the far end.
      // The address of ours that fits the destination's zone, so the chain
      // names the AKA the next hop actually knows us by.
      var viaAddress = ourAddresses[0] || '';
      try {
        var destZone = parseInt(String(pmObj.to_address || '').split(':')[0]) || 0;
        if (destZone) {
          var viaSrc = await systemAddresses.resolveSourceForDestinationZone(destZone);
          if (viaSrc && viaSrc.address && viaSrc.address.address) {
            viaAddress = viaSrc.address.address;
          }
        }
      } catch (_) { /* fall back to the first address we hold */ }

      var attrs = Array.isArray(ftnMessage.OptionalAttributes)
        ? ftnMessage.OptionalAttributes.slice()
        : [];
      ftnVia.appendVia(attrs, viaAddress, new Date(), appConfig.get('version', ''));
      pmObj.transport_data = Object.assign({}, pmObj.transport_data, {
        optional_attributes: attrs
      });
      // Queue for outbound via the PM model
      // The outbound tosser will pick it up via getPendingByTransport('FTN')
      var relayObj = Object.assign({}, pmObj, {
        user_id: 0, // system/relay — no local user
        transport_data: Object.assign({}, pmObj.transport_data, {
          relayed: true,
          relay_route: routeResult
        })
      });

      // Carry the uuid so the relay log can point at the row this became and
      // delivery can be followed from the decision that made it.
      if (!relayObj.uuid) relayObj.uuid = uuidv4();
      await privateMessages.queueOutbound(relayObj);
      alogger.writeAlog(1, "FTN netmail queued for relay via " + routeResult.nextHop, "cyan");

      return {
        relayed:      true,
        nextHop:      routeResult.nextHop,
        routeMethod:  routeResult.method,
        viaStamped:   viaAddress,
        outboundUuid: relayObj.uuid
      };
    } else {
      // No route found — treat as undeliverable
      alogger.writeAlog(2, "FTN netmail relay: no route to " + pmObj.to_address, "yellow");
      await rejectRelay(ftnMessage, pmObj, currentRelayMode(), 'no route to ' + pmObj.to_address);
      return { norouted: true, reason: 'no route to ' + pmObj.to_address };
    }
  } catch (error) {
    alogger.writeAlog(2, "FTN netmail relay error: " + error.message, "redbright");
    await rejectRelay(ftnMessage, pmObj, currentRelayMode(), 'routing error: ' + error.message);
    return { norouted: true, reason: 'routing error: ' + error.message };
  }
}

// Reject relay: write raw to bad dir, notify sysops
async function rejectRelay(ftnMessage, pmObj, mode, reason) {
  var badDir = appConfig.get('ftnbad', 'ftn/bad');
  // Ensure bad directory exists
  try {
    if (!fs.existsSync(badDir)) {
      fs.mkdirSync(badDir, { recursive: true });
    }
  } catch (error) {
    alogger.writeAlog(2, "Could not create bad dir: " + error.message, "redbright");
  }

  // Write a text dump of the rejected message for reference
  try {
    var filename = badDir + "/netmail_" + Date.now() + ".txt";
    var dump = "Rejected FTN Netmail Relay\n" +
      "Date: " + new Date().toISOString() + "\n" +
      "From: " + (ftnMessage.FromUser || '') + " @ " + (pmObj.from_address || '') + "\n" +
      "To: " + (ftnMessage.ToUser || '') + " @ " + (pmObj.to_address || '') + "\n" +
      "Subject: " + (ftnMessage.Subject || '') + "\n" +
      "---\n" +
      (ftnMessage.BodyText || '') + "\n";
    fs.writeFileSync(filename, dump);
  } catch (error) {
    alogger.writeAlog(2, "Could not write rejected netmail to bad dir: " + error.message, "redbright");
  }

  // Notify sysops
  await privateMessages.notifySysops(
    "FTN Netmail Relay Rejected",
    "Netmail relay rejected.\n\n" +
    "From: " + (ftnMessage.FromUser || '') + " at " + (pmObj.from_address || '') + "\n" +
    "To: " + (ftnMessage.ToUser || '') + " at " + (pmObj.to_address || '') + "\n" +
    "Subject: " + (ftnMessage.Subject || '') + "\n\n" +
    explainRefusal(mode, reason) + "\n" +
    "Raw message stored in " + badDir + "."
  );
}

// ============================================================
// Relay policy
// ============================================================

const RELAY_OFF = 'off';
const RELAY_NODELIST = 'nodelist';
const RELAY_ON = 'on';
const RELAY_MODES = [RELAY_OFF, RELAY_NODELIST, RELAY_ON];

/**
 * Which relay mode is configured?
 *
 *   nodelist  the default: relay only when both the sender and the recipient
 *             are listed in the same network's nodelist
 *   off       refuse all transit mail
 *   on        relay anything the router can find a way to, including between
 *             two networks this system happens to carry
 *
 * Nodelist is the default rather than off because it is safe enough to leave
 * on: it cannot be used to reach a network this system does not carry, or a
 * node that does not exist, so a new install is a good FTN citizen without the
 * sysop having to know the setting is there.
 *
 * `allow_netmail_relay` was the original boolean and is now ignored. It cannot
 * be honoured: configStore seeds every default into the settings table, so a
 * sysop who deliberately set it false is indistinguishable from one who never
 * touched it, and guessing wrong in that direction would either pin every
 * upgrade to the old behaviour or switch relay on for someone who had turned
 * it off. Since relay never worked correctly before this release anyway (the
 * message and packet headers were swapped on every transit message), there is
 * no working configuration to preserve. Upgrades land on nodelist and the
 * change is called out in the docs.
 *
 * @param {string} mode  configured mode, or empty for the default
 */
function resolveRelayMode(mode) {
	var m = String(mode === null || mode === undefined ? '' : mode).trim().toLowerCase();
	if (RELAY_MODES.indexOf(m) !== -1) return m;

	// A value we do not recognise must fail closed, and closed means off rather
	// than the default. A misspelled mode is a mistake, and the safe answer to
	// a mistake is to carry nothing.
	if (m) {
		alogger.writeAlog(2, "Unknown netmail_relay_mode '" + mode +
			"', treating as off", "yellow");
		return RELAY_OFF;
	}
	return RELAY_NODELIST;
}

function currentRelayMode() {
	return resolveRelayMode(appConfig.get('netmail_relay_mode', ''));
}

/**
 * Nodelist gate: are both ends real, listed nodes of the same network?
 *
 * This is the whole of the "nodelist" mode, and it is doing more work than it
 * looks like. Nodelists here are scoped per network, so requiring both ends in
 * the *same* one stops this system carrying mail between two networks it
 * happens to link with. Without it, a node on one othernet can reach any node
 * on any other othernet this system carries, which is the shape of an open
 * relay even when every individual link is trusted.
 *
 * It also puts a floor under the router. resolveRoute will happily find a way
 * to anything dialable in the nodelist, or walk up to a hub or coordinator for
 * anything else, so "on" really does mean the whole of whatever networks this
 * system carries. Requiring both ends to be listed keeps the relay inside one
 * network rather than between them.
 *
 * Points are stripped before the lookup. Points are not listed in a nodelist,
 * and a point's mail is its boss node's responsibility, so 1:229/426.1 is
 * checked as 1:229/426.
 *
 * What this deliberately does not do is verify that the sender is who the
 * message says. FTN has no way to do that: the origin address is whatever the
 * packet claims. That is a problem for a network whose nodelist can carry
 * public keys, not one this system can solve from the outside.
 *
 * @returns {object} { allowed, reason }
 */
async function relayAllowedByNodelist(sourceAddress, destAddress) {
	var src = parseFtnAddress(bareAddress(sourceAddress));
	var dst = parseFtnAddress(bareAddress(destAddress));

	if (!src) return { allowed: false, reason: 'unparseable sender address' };
	if (!dst) return { allowed: false, reason: 'unparseable recipient address' };

    // Which network owns each end? Answered by the zone, via the addresses this
    // system holds. A zone we hold no address in is a network we do not carry,
    // so there is nothing to relay within.
	var srcNetwork = await networkIdForZone(src.zone);
	if (!srcNetwork) {
		return { allowed: false, reason: 'sender zone ' + src.zone + ' is not a network this system carries' };
	}
	var dstNetwork = await networkIdForZone(dst.zone);
	if (!dstNetwork) {
		return { allowed: false, reason: 'recipient zone ' + dst.zone + ' is not a network this system carries' };
	}
	if (srcNetwork !== dstNetwork) {
		return { allowed: false, reason: 'sender and recipient are on different networks' };
	}

	// Point stripped: points are not listed, and the boss node answers for them.
	var srcNode = await ftnNodelist.getNode(srcNetwork, src.zone, src.net, src.node, 0);
	if (!srcNode) {
		return { allowed: false, reason: 'sender ' + fmtAddr(src) + ' is not in the nodelist' };
	}
	var dstNode = await ftnNodelist.getNode(dstNetwork, dst.zone, dst.net, dst.node, 0);
	if (!dstNode) {
		return { allowed: false, reason: 'recipient ' + fmtAddr(dst) + ' is not in the nodelist' };
	}

	return { allowed: true, reason: null };
}

/**
 * The network that owns a zone, by way of the addresses this system holds in
 * it. Null when we hold none, which is the same as saying we do not carry that
 * network.
 */
async function networkIdForZone(zone) {
	var rows = await systemAddresses.getAddressesForZone(parseInt(zone));
	for (var r of (rows || [])) {
		if (r.network_id) return r.network_id;
	}
	return null;
}

function fmtAddr(a) {
	return a.zone + ':' + a.net + '/' + a.node;
}

// ============================================================
// Outbound source stamping
// ============================================================

/**
 * Who does this message claim to be from, and who is sending the packet?
 *
 * Two different questions that were being answered with one address, and got
 * swapped in the process. The message header names the system that wrote the
 * message. The packet header names the system handing the packet over. For
 * mail we originated they are the same address, which is why this went
 * unnoticed. For relayed transit mail they are not: the message stays from
 * whoever wrote it, and the packet is from us, because we are the ones sending
 * it.
 *
 * Before this existed, TossOutboundNetmail stamped our address over the
 * message header while WritePkts read the packet header out of the INTL
 * kludge, which on transit mail carries the original endpoints. So a relayed
 * netmail went out with the message claiming to be from us and the packet
 * claiming to be from the originator: backwards on both counts, replies coming
 * back to the wrong system.
 *
 * @param {object} msg      FTN message, source fields already restored from
 *                          transport_data by privateMessageToFtn
 * @param {object} srcAddr  our system address for the destination zone
 *                          ({ address, address_zone, address_net, address_node })
 * @param {object} transportData  the pm row's transport_data; `relayed` marks
 *                          transit mail
 * @returns {object} { relayed, message: {...}, packet: {...} }
 */
function resolveOutboundSource(msg, srcAddr, transportData) {
	var td = transportData || {};
	var relayed = td.relayed === true;
	var ours = {
		address: bareAddress(srcAddr && srcAddr.address),
		zone:    (srcAddr && srcAddr.address_zone) || 1,
		net:     (srcAddr && srcAddr.address_net)  || 0,
		node:    (srcAddr && srcAddr.address_node) || 0
	};

	// The packet is always from us. We are the system sending it, whoever
	// wrote what is inside.
	var out = { relayed: relayed, packet: ours, message: ours };
	if (!relayed) return out;

	// Transit mail keeps its author. Fall back to our address only if the
	// originator did not survive, which would mean a malformed inbound
	// message: better to send it as ours than to emit a 0:0/0 header.
	var origin = {
		address: bareAddress(msg && msg.Source) || ours.address,
		zone:    numberOr((msg && msg.SourceZone), ours.zone),
		net:     numberOr((msg && msg.SourceNet),  ours.net),
		node:    numberOr((msg && msg.SourceNode), ours.node)
	};
	if (!origin.net && !origin.node) {
		return out;
	}

	out.message = origin;
	return out;
}

function bareAddress(addr) {
	if (!addr) return '';
	var s = String(addr).trim();
	var at = s.indexOf('@');
	return at >= 0 ? s.substring(0, at) : s;
}

function numberOr(value, fallback) {
	var n = parseInt(value, 10);
	return isNaN(n) ? fallback : n;
}

// Why a relay was refused, in words a sysop can act on. "Relay is disabled" was
// the only message this ever produced, which was wrong as soon as there was
// more than one reason to refuse.
function explainRefusal(mode, reason) {
  if (mode === RELAY_NODELIST) {
    return "Relay is set to nodelist only and this message did not qualify: " +
      (reason || 'unknown reason') + ".";
  }
  if (mode === RELAY_ON) {
    return "Relay is on but this message could not be relayed: " +
      (reason || 'no route') + ".";
  }
  return "Relay is off (netmail_relay_mode=off).";
}

// ============================================================
// Netmail dump (for custom route action)
// ============================================================

// Write an inbound netmail to a JSON file in the configured dump directory
// for an external handler to pick up. Used by custom netmail_routes with
// action='dump'. File attachments referenced by the netmail are NOT copied
// -- they stay in the inbound dir for wildcard/TIC handling.
//
// Path resolution uses resolveFileboxPath() so the target respects %X
// substitution and anchors relative paths under filebox_base_dir.
async function _dumpNetmailToJson(ftnMessage, pmObj, targetDir) {
  if (!targetDir) throw new Error('no target directory configured for dump route');

  var resolvedDir = resolveFileboxPath(targetDir);
  await fs.promises.mkdir(resolvedDir, { recursive: true });

  // Filename: <iso-ts>-<fromaddr>-<touser>.json. Sanitise aggressively --
  // to_user can be anything a remote mailer decides to send.
  var ts = new Date().toISOString().replace(/[:.]/g, '-');
  var sanitise = function (s) {
    return String(s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').substring(0, 64) || 'unknown';
  };
  var fromPart = sanitise(pmObj.from_address);
  var toPart   = sanitise(ftnMessage.ToUser);
  // Include the process id + a short random suffix to avoid clobbering on
  // bursts with sub-ms-identical timestamps.
  var rand = Math.random().toString(36).substring(2, 8);
  var filename = ts + '-' + fromPart + '-' + toPart + '-' + rand + '.json';

  var payload = {
    received_at:    new Date().toISOString(),
    from_user:      ftnMessage.FromUser || null,
    from_address:   pmObj.from_address || null,
    to_user:        ftnMessage.ToUser || null,
    to_address:     pmObj.to_address || null,
    subject:        ftnMessage.Subject || null,
    date_time:      ftnMessage.DateTime || null,
    msg_id:         pmObj.msg_id || null,
    msg_orig_addr:  pmObj.msg_orig_addr || null,
    attribute:      parseInt(ftnMessage.Attribute) || 0,
    file_attach:    (parseInt(ftnMessage.Attribute) & 0x0010) !== 0,
    body:           ftnMessage.Message || '',
  };

  var fullPath = path.join(resolvedDir, filename);
  await fs.promises.writeFile(fullPath, JSON.stringify(payload, null, 2), 'utf8');
  return fullPath;
}

// ============================================================
// File-attach processing
// ============================================================

// FTN file-attach netmail: the subject line contains filename(s) to attach.
// The files arrive separately via binkp and land in the inbound directory.
// We scan inbound for matching filenames and link them as PM attachments.
async function _processFileAttach(ftnMessage, inboxUuid) {
  var subject = (ftnMessage.Subject || '').trim();
  if (!subject) return;

  var inboundDir = appConfig.get('ftninbound', 'ftn/in');

  // Subject may contain full paths or bare filenames, separated by spaces.
  // Extract bare filenames from each token.
  var tokens = subject.split(/\s+/);
  var attachments = [];

  for (var token of tokens) {
    var filename = path.basename(token.trim());
    if (!filename) continue;

    // Look for the file in the inbound directory
    var filePath = path.join(inboundDir, filename);
    if (!fs.existsSync(filePath)) {
      // Try case-insensitive match
      try {
        var dirContents = fs.readdirSync(inboundDir);
        var match = dirContents.find(function(f) {
          return f.toLowerCase() === filename.toLowerCase();
        });
        if (match) {
          filePath = path.join(inboundDir, match);
          filename = match;
        } else {
          alogger.writeAlog(3, 'FTN file-attach: file not found in inbound: ' + filename, 'yellow');
          continue;
        }
      } catch (_) {
        continue;
      }
    }

    // Read the file
    try {
      var data = fs.readFileSync(filePath);
      attachments.push({
        filename: filename,
        mimeType: 'application/octet-stream',
        data: data
      });

      // Remove from inbound directory (it's been claimed)
      fs.unlinkSync(filePath);
      alogger.writeAlog(3, 'FTN file-attach: linked ' + filename + ' (' + data.length + ' bytes) to netmail', 'cyan');
    } catch (err) {
      alogger.writeAlog(3, 'FTN file-attach: error reading ' + filename + ': ' + err.message, 'yellow');
    }
  }

  if (attachments.length > 0) {
    var ids = await storeAttachments(inboxUuid, 'inbox', attachments);
    if (ids.length > 0) {
      await postgres.write('UPDATE pm_inbox SET has_attachments = true WHERE uuid = $1', [inboxUuid]);
    }
  }
}

export {
  importFtnNetmail,
  privateMessageToFtn,
  resolveOutboundSource,
  resolveRelayMode,
  currentRelayMode,
  relayAllowedByNodelist,
  RELAY_OFF,
  RELAY_NODELIST,
  RELAY_ON,
  localAddressStrings,
  ftnToPrivateMessage,
  isLocalAddress
};
