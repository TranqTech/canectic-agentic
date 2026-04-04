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
import appConfig from "../config/appConfig.js";

// ============================================================
// Inbound: FTN Message → PM system
// ============================================================

// Main entry point for inbound FTN netmail. Replaces netmail.newInboundNetmail().
// Returns { status, duplicate, imported, relayed, undeliverable, processor, errormessages }
async function importFtnNetmail(ftnMessage) {
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
    if (appConfig.getBoolean('allow_netmail_relay', false)) {
      var relayResult = await relayNetmail(ftnMessage, pmObj);
      retObj.status = true;
      retObj.relayed = true;
      alogger.writeAlog(1, "FTN netmail relayed: " + pmObj.from_address + " → " + pmObj.to_address, "cyan");
    } else {
      // Reject: write to bad dir, notify sysops
      await rejectRelay(ftnMessage, pmObj);
      retObj.status = true;
      retObj.undeliverable = true;
      alogger.writeAlog(2, "FTN netmail relay rejected: " + pmObj.from_address + " → " + pmObj.to_address, "yellow");
    }
    return retObj;
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
async function isLocalAddress(addressString) {
  if (!addressString) return false;
  var row = await systemAddresses.getActiveAddressByNetworkType(addressString, 'FTN');
  return !!row;
}

// Relay netmail through outbound routing
async function relayNetmail(ftnMessage, pmObj) {
  // Route the message via ftnRouter
  try {
    var routeResult = await ftnRouter.resolveRoute(pmObj.to_address);
    if (routeResult && routeResult.nextHop) {
      // Queue for outbound via the PM model
      // The outbound tosser will pick it up via getPendingByTransport('FTN')
      var relayObj = Object.assign({}, pmObj, {
        user_id: 0, // system/relay — no local user
        transport_data: Object.assign({}, pmObj.transport_data, {
          relayed: true,
          relay_route: routeResult
        })
      });

      await privateMessages.queueOutbound(relayObj);
      alogger.writeAlog(1, "FTN netmail queued for relay via " + routeResult.nextHop, "cyan");
    } else {
      // No route found — treat as undeliverable
      alogger.writeAlog(2, "FTN netmail relay: no route to " + pmObj.to_address, "yellow");
      await rejectRelay(ftnMessage, pmObj);
    }
  } catch (error) {
    alogger.writeAlog(2, "FTN netmail relay error: " + error.message, "redbright");
    await rejectRelay(ftnMessage, pmObj);
  }
}

// Reject relay: write raw to bad dir, notify sysops
async function rejectRelay(ftnMessage, pmObj) {
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
    "Relay is disabled (allow_netmail_relay=false).\n" +
    "Raw message stored in " + badDir + "."
  );
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
  ftnToPrivateMessage,
  isLocalAddress
};
