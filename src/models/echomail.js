// echomail.js — FTN-specific message helpers.
//
// All generic message and threading logic lives in messages.js. This file
// contains only the FTN protocol-specific bits used by the FTN tosser:
// - ftnToDb / dbToFtn -- conversion between FTN message objects and DB rows
// - getOutboundForConnection -- builds outbound message list for an FTN peer
// - updateMsgIndexes / updateSeenbyArray -- internal helpers for outbound

//imports
import { v4 as uuidv4 } from 'uuid';
import * as postgres from '../middleware/db/postgres.js';
import * as ftnUtils from "../utils/ftnUtils.js";
import * as ftnTosser from "../middleware/tossers/ftnTosser.js";
import * as systemAddresses from "./systemAddresses.js";
import * as alogger from "../utils/alogger.js";

const maxOutbound = 1000;

function toIntOrNull(v) {
	if (v === null || v === undefined || v === '') return null;
	var n = parseInt(v, 10);
	return Number.isFinite(n) ? n : null;
}

// Extract the zone (left of ':') from a "zone:net/node" address string,
// falling back to a supplied integer when the string is missing/malformed.
function parseAddrPart(addrStr, intFallback) {
	if (addrStr && typeof addrStr === 'string' && addrStr.indexOf(':') > 0) {
		var n = parseInt(addrStr.split(':')[0], 10);
		if (Number.isFinite(n)) return n;
	}
	return toIntOrNull(intFallback);
}

async function ftnToDb(ftnMessage) {
	var currtime   = new Date();
	var systemTime = await ftnUtils.getSystemTime(ftnMessage.DateTime, ftnMessage.TZUTC);
	var uuid       = uuidv4();

	// Split the incoming full-string MSGID ("address serial") into the
	// tuple storage format: msg_id column holds the 8-char serial only,
	// msg_orig_addr holds the origin FTN address. Same split for reply_to.
	// See docs/reference/NETWORKING_ARCHITECTURE.md "MSGID tuple storage".
	var msgidSplit = ftnUtils.splitFullMsgid(ftnMessage.MsgId);
	var replySplit = ftnUtils.splitFullMsgid(ftnMessage.ReplyTo);

	// Parse zone from the Source/Destination address strings; fall back to
	// the integer Source/DestinationZone fields when the strings are absent
	// (e.g. bad-echomail recovery rebuilds a partial message object). Always
	// use null instead of "" so integer columns don't barf on empty strings.
	var srcZone  = parseAddrPart(ftnMessage.Source,      ftnMessage.SourceZone);
	var destZone = parseAddrPart(ftnMessage.Destination, ftnMessage.DestinationZone);

	var dbObj = {
		user_id: 0,
		uuid: uuid,
		msg_id: msgidSplit.msg_id,
		msg_orig_addr: msgidSplit.msg_orig_addr,
		reply_to: replySplit.msg_id,
		reply_orig_addr: replySplit.msg_orig_addr,
		tosser_id: ftnMessage.TosserId,
		optional_attributes: ftnMessage.OptionalAttributes,
		source: ftnMessage.Source || null,
		domain: "",
		destination: ftnMessage.Destination || null,
		source_zone: srcZone,
		source_net: toIntOrNull(ftnMessage.SourceNet),
		source_node: toIntOrNull(ftnMessage.SourceNode),
		destination_zone: destZone,
		destination_net: toIntOrNull(ftnMessage.DestinationNet),
		destination_node: toIntOrNull(ftnMessage.DestinationNode),
		to_user: ftnMessage.ToUser,
		from_user: ftnMessage.FromUser,
		subject: ftnMessage.Subject     ? ftnMessage.Subject.replace(/\x00/g, '').trim() : "",
		body_text: ftnMessage.BodyText  ? ftnMessage.BodyText.replace(/\x00/g, '')       : "",
		origin_line: ftnMessage.OriginLine ? ftnMessage.OriginLine.replace(/\x00/g, '')  : "",
		raw_text: ftnMessage.RawText    ? ftnMessage.RawText.replace(/\x00/g, '')        : "",
		datetime_string: ftnMessage.DateTime,
		tz_utc: ftnMessage.TZUTC,
		seen_by: ftnMessage.SeenBy,
		path: ftnMessage.Path,
		system_time: systemTime,
		created_at: currtime,
		updated_at: null
	};
	return dbObj;
}

async function dbToFtn(dbMessage) {
	var optional_attributes = dbMessage.optional_attributes || [];

	// Reassemble the full "address serial" MSGID for the outbound FTN
	// message object from the tuple columns. Legacy rows where the split
	// migration hasn't run yet may still have the full string in msg_id
	// and an empty msg_orig_addr -- joinMsgidTuple handles that case
	// gracefully (returns msg_id alone when origAddr is empty).
	var fullMsgId  = ftnUtils.joinMsgidTuple(dbMessage.msg_orig_addr,  dbMessage.msg_id);
	var fullReplyTo = ftnUtils.joinMsgidTuple(dbMessage.reply_orig_addr, dbMessage.reply_to);

	var ftnMsg = {
		Type: "Echomail",
		Id: dbMessage.id,
		MsgId: fullMsgId,
		ReplyTo: fullReplyTo,
		OptionalAttributes: optional_attributes,
		Source: dbMessage.source,
		SourceZone: dbMessage.source_zone,
		SourceNet: dbMessage.source_net,
		SourceNode: dbMessage.source_node,
		Domain: dbMessage.domain,
		Destination: dbMessage.destination,       // fixed: was dbMessage.Destination
		DestinationZone: dbMessage.destination_zone,
		DestinationNet: dbMessage.destination_net,
		DestinationNode: dbMessage.destination_node,
		ToUser: dbMessage.to_user,
		FromUser: dbMessage.from_user,
		Subject: dbMessage.subject,
		BodyText: dbMessage.body_text,
		OriginLine: dbMessage.origin_line,
		ProductLine: dbMessage.product_string,
		SignatureString: dbMessage.signature_string,
		DateTime: dbMessage.datetime_string,
		TZUTC: dbMessage.tz_utc,
		SeenBy: dbMessage.seen_by,
		Path: dbMessage.path                       // fixed: was dbMessage.Path
	};
	return ftnMsg;
}

// updateThread, mergeThreads, mergeRecentThreads, updateThreadArray,
// updateDailyThreads, updateAreaThreads, applyThreadingForArea, and
// reconcileOrphans all moved to messages.js. Re-exported below.

async function updateSeenbyArray(sbArray) {
	if (!sbArray || sbArray.length < 1) return false;
	for (var sb of sbArray) {
		try {
			await postgres.write(
				"UPDATE " + sb.msgtable + " SET seen_by = $1 WHERE id = $2",
				[sb.newsbstring, sb.id]
			);
		} catch (error) {
			alogger.writeAlog(3, "updateSeenbyArray: error for id " + sb.id + ": " + error.message, "redbright");
		}
	}
}

async function getOutboundForConnection(conn) {
	// conn is a peer_connections row joined with network fields.
	// connection_data holds FTN-specific transport fields.
	var cd = conn.connection_data || {};
	var nodeAddress = cd.address;

	if (!nodeAddress) {
		alogger.writeAlog(3, "getOutboundForConnection: no address in connection_data for conn " + conn.uuid, "redbright");
		return;
	}

	alogger.writeAlog(5, "Checking echomail for " + conn.peer_name + " - " + nodeAddress, "cyan");

	// Resolve our system address for this connection.
	// Priority: 1) explicitly set system_address_id on connection
	//           2) default address for this network
	//           3) first active address matching zone + domain (legacy fallback)
	var systemaddress = {};
	var resolvedRow   = null;

	if (conn.system_address_id) {
		resolvedRow = await systemAddresses.getAddressById(conn.system_address_id);
		if (resolvedRow && !resolvedRow.active) {
			alogger.writeAlog(4,
				"getOutboundForConnection: assigned system address " + resolvedRow.address +
				" is inactive for conn " + conn.uuid + " — falling back to network default",
				"yellow"
			);
			resolvedRow = null;
		}
	}

	if (!resolvedRow) {
		resolvedRow = await systemAddresses.getDefaultAddress(conn.network_id);
	}

	if (!resolvedRow) {
		// Legacy fallback: zone + domain scan
		var zone   = nodeAddress.split(":")[0];
		var domain = conn.domain || "";
		var dblist = await systemAddresses.getAddressesForZone(zone, domain);
		if (!dblist || dblist.length === 0) {
			if (domain) dblist = await systemAddresses.getAddressesForDomain(domain);
		}
		if (dblist && dblist.length > 0) resolvedRow = dblist[0];
	}

	if (!resolvedRow) {
		alogger.writeAlog(3,
			"getOutboundForConnection: no system address available for conn " + conn.uuid +
			" — cannot toss outbound",
			"redbright"
		);
		return;
	}

	var bzsplit  = resolvedRow.address.split(":");
	var bnnsplit = bzsplit[1].split("/");
	var bnpsplit = bnnsplit[1].split(".");
	systemaddress.address = resolvedRow.address;
	systemaddress.zone    = bzsplit[0];
	systemaddress.net     = bnnsplit[0];
	systemaddress.node    = bnpsplit[0];
	systemaddress.netnode = systemaddress.net + "/" + systemaddress.node;
	if (bnpsplit.length > 1) systemaddress.point = bnpsplit[1];

	// Parse destination node address and strip point component
	var netnode   = nodeAddress.split(":")[1];
	if (netnode.includes(".")) {
		var netnodeParts = netnode.split(".");
		netnode = netnodeParts[0];
	}

	// Get all enabled subscriptions for this connection, joined with areatag
	// from network_areas so we can stamp the FTN AreaTag on each message
	var enabledSubs = await postgres.query(
		`SELECT pas.id, pas.area_id, pas.msg_idx,
		        ma.shortcode, na.areatag
		 FROM peer_area_subscriptions pas
		 JOIN message_areas ma ON ma.id = pas.area_id
		 JOIN network_areas na ON na.area_id = pas.area_id
		                       AND na.network_id = $1
		 WHERE pas.peer_connection_id = $2
		   AND pas.enabled = true
		   AND na.active = true
		 ORDER BY ma.shortcode ASC`,
		[conn.network_id, conn.id]
	);

	if (!enabledSubs || enabledSubs.length === 0) {
		alogger.writeAlog(5, "No areas enabled for connection " + conn.uuid, "cyan");
		return;
	}

	var nodeSeenByUpdateArray = [];
	var tossableArray         = [];
	// Collect {pas_id, area_id, newIdx} for bulk msg_idx update on success
	var idxUpdateArray        = [];

	for (var sub of enabledSubs) {
		var curIdx  = sub.msg_idx || 0;
		var shorty  = sub.shortcode.toLowerCase().trim();
		var msgtable = "mb_" + shorty + "_msgs";

		var finalidxResult = await postgres.query(
			"SELECT id FROM " + msgtable + " ORDER BY id DESC LIMIT 1", []
		);
		var finalidx = (finalidxResult && finalidxResult[0]) ? finalidxResult[0].id : 0;

		if (curIdx > finalidx) {
			// Index got ahead somehow — reset
			curIdx = finalidx;
		}

		if (finalidx > curIdx) {
			outerLoop: while (finalidx > curIdx) {
				var msglist = await postgres.query(
					"SELECT * FROM " + msgtable + " WHERE id > $1 LIMIT 500",
					[curIdx]
				);

				if (msglist && msglist.length > 0) {
					for (var msg of msglist) {
						if (tossableArray.length >= maxOutbound) break outerLoop;

						var istossable   = true;
						var updateseenby = false;
						var seenbystring = "";

						// Deliberately NOT filtering on source_network_id here.
						//
						// This used to skip any message whose source_network_id
						// matched the connection's network, on the reasoning that
						// a message should not go back to the network it arrived
						// from. That conflates the network with the node. A hub
						// receives from its uplink on network N and must forward
						// to its downlinks, which are also on network N: that is
						// what echomail distribution is. The check suppressed
						// almost all forwarded traffic, leaving only locally
						// posted messages, because handleInboundEchoMessage
						// stamps source_network_id on every inbound message.
						//
						// Not re-sending to the node it came from is a separate
						// concern, and is covered twice below: the explicit
						// source-address check, and SEEN-BY per FTS-0004, which
						// is the standard loop prevention and also stops a
						// message reaching any node already listed.
						//
						// Imported history is held back by the outbound seal
						// (peerAreaSubscriptions.advanceOutboundIdxForArea),
						// which fast-forwards msg_idx past the import. That is
						// the correct mechanism and does not need this filter.

						// Never export imported history. This is the precise
						// replacement for the old source_network_id filter: it
						// marks rows that came from an SMB/JAM migration rather
						// than off the wire, so a migration is not echoed out to
						// peers while ordinary forwarding is untouched.
						//
						// The outbound seal advances msg_idx past an import so
						// caught-up peers never even scan these rows. This flag
						// covers the case the seal deliberately cannot: a peer
						// that was already behind at import time keeps its real
						// backlog, and a single watermark cannot say "send
						// 51-100 but skip the imported 101-5100".
						if (msg.imported) {
							istossable = false;
						}

						// FTN: skip if we received it from this node
						if (istossable && msg.source === nodeAddress) {
							istossable = false;
						}

						if (istossable) {
							msg.source           = systemaddress.address;
							msg.source_zone      = systemaddress.zone;
							msg.source_net       = systemaddress.net;
							msg.source_node      = systemaddress.node;
							msg.destination      = nodeAddress;
							msg.destination_zone = nodeAddress.split(":")[0];
							msg.destination_net  = netnode.split("/")[0];
							msg.destination_node = netnode.split("/")[1];

							if (msg.seen_by) {
								var netpresent = false;
								var sbArray    = msg.seen_by.split(" ");
								var sbnets     = [];
								var netobj;

								for (var sb of sbArray) {
									if (sb.includes("/")) {
										if (netobj) sbnets.push(netobj);
										var sbsplit = sb.split("/");
										netobj = {
											net: sbsplit[0],
											netstring: sb,
											nodes: [sbsplit[1]]
										};
									} else if (netobj) {
										netobj.nodes.push(sb);
										netobj.netstring += " " + sb;
									}
								}
								if (netobj) sbnets.push(netobj);

								for (var net of sbnets) {
									if (net.net === msg.destination_net) {
										netpresent = true;
										if (net.nodes.includes(msg.destination_node)) {
											istossable = false;
										} else {
											net.nodes.push(msg.destination_node);
											net.netstring += " " + msg.destination_node;
										}
									}
								}

								if (istossable) {
									updateseenby = true;
									if (netpresent) {
										for (var sn of sbnets) {
											if (seenbystring.length > 0) seenbystring += " ";
											seenbystring += sn.netstring;
										}
									} else {
										seenbystring = (msg.seen_by ? msg.seen_by + " " : "");
										seenbystring += msg.destination_net + "/" + msg.destination_node;
									}
								}
							} else {
								updateseenby = true;
								seenbystring = systemaddress.netnode;
								if (msg.destination_net === systemaddress.net) {
									seenbystring += " " + msg.destination_node;
								} else {
									seenbystring += " " + msg.destination_net + "/" + msg.destination_node;
								}
							}

							if (msg.path) {
								var patharr = msg.path.split(" ");
								if (patharr.includes(netnode)) istossable = false;
							}
						}

						if (istossable) {
							if (updateseenby) {
								msg.seen_by = seenbystring;
								nodeSeenByUpdateArray.push({
									id: msg.id,
									msgtable: msgtable,
									newsbstring: seenbystring
								});
							}
							msg.path = systemaddress.netnode;
							var ftnObj = await dbToFtn(msg);
							ftnObj.AreaTag = sub.areatag;
							tossableArray.push(ftnObj);
						}

						curIdx = msg.id;
					}
				} else {
					break;
				}
			}
		}

		idxUpdateArray.push({ pas_id: sub.id, area_id: sub.area_id, newIdx: curIdx });
	}

	if (tossableArray.length > 0) {
		var msgcount  = tossableArray.length;
		var pktresult = await ftnTosser.WritePktsToNode(tossableArray, conn, systemaddress);
		if (pktresult && pktresult.processedcount) {
			if (pktresult.processedcount >= msgcount) {
				alogger.writeAlog(5,
					"Wrote " + pktresult.processedcount + " messages in " + pktresult.pktcount +
					" packets to " + conn.peer_name,
					"greenbright"
				);
				await updateMsgIndexes(idxUpdateArray);
				await updateSeenbyArray(nodeSeenByUpdateArray);
			} else {
				// TODO: more graceful partial-send handling to allow re-tossing
				alogger.writeAlog(3,
					"getOutboundForConnection: failed to process all messages for " + conn.peer_name,
					"redbright"
				);
			}
		}
	} else {
		await updateMsgIndexes(idxUpdateArray);
	}
}

// Writes updated msg_idx values back to peer_area_subscriptions.
// Called after a successful outbound toss or when there was nothing to send.
async function updateMsgIndexes(idxUpdateArray) {
	if (!idxUpdateArray || idxUpdateArray.length === 0) return;
	var currtime = new Date();
	for (var entry of idxUpdateArray) {
		var err = await postgres.write(
			"UPDATE peer_area_subscriptions SET msg_idx = $1, updated_at = $2 WHERE id = $3",
			[entry.newIdx, currtime, entry.pas_id]
		);
		if (err) {
			alogger.writeAlog(3,
				"updateMsgIndexes: failed to update msg_idx for pas id " + entry.pas_id +
				": " + err.message,
				"redbright"
			);
		}
	}
}
// echomail.js exports — FTN-specific helpers only.
// All other message/threading logic lives in messages.js. Callers should
// import from messages.js directly.
export {
	ftnToDb,
	dbToFtn,
	getOutboundForConnection
};