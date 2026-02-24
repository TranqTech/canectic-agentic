//imports
import { EventEmitter } from 'node:events';
//internal modules
import * as alogger from "../utils/alogger.js";

class nodeManager {
	constructor() {
		this.emitter = new EventEmitter();
		this.nodenumsinuse = [];
		this.lastnodereleased = 0;

		// Node registry — keyed by node number
		// Each entry: { nodenum, username, status, detail, detail_display, connection_type, since, callId }
		this.nodeRegistry = {};
	}

	// --- Node number allocation ---

	getAvailNodeNum() {
		var numset = false;
		var i = 1;
		while (numset == false) {
			if (!this.nodenumsinuse.includes(i)) {
				numset = true;
				this.nodenumsinuse.push(i);
				// Initialize registry entry
				this.nodeRegistry[i] = {
					nodenum: i,
					username: "",
					status: "connecting",
					detail: "",
					detail_display: "",
					connection_type: "",
					since: Date.now(),
					callId: null
				};
				var nodemsg = "Node Number " + i + " selected for use";
				alogger.writeAlog(1, nodemsg, "yellowbright", true);
				return i;
			} else {
				i += 1;
			}
		}
	}

	releaseNodeNum(nodenum) {
		var releasemsg = "Attempting to release Node " + nodenum;
		alogger.writeAlog(1, releasemsg, "redbright", true);
		const index = this.nodenumsinuse.indexOf(nodenum);
		if (index > -1) {
			this.nodenumsinuse.splice(index, 1);
			// Remove from registry
			delete this.nodeRegistry[nodenum];
			this.lastnodereleased = nodenum;
			this.emitter.emit("NodeReleased");
			var nodemsg = "Node " + nodenum + " released";
			alogger.writeAlog(1, nodemsg, "redbright", true);
			this.listUsedNodes();
		}
	}

	// --- Node status updates ---

	updateNode(nodenum, status, detail, detailDisplay) {
		if (!this.nodeRegistry[nodenum]) return;
		this.nodeRegistry[nodenum].status = status || "";
		this.nodeRegistry[nodenum].detail = detail || "";
		if (detailDisplay !== undefined) {
			this.nodeRegistry[nodenum].detail_display = detailDisplay || "";
		}
		this.nodeRegistry[nodenum].since = Date.now();
	}

	setNodeUsername(nodenum, username) {
		if (!this.nodeRegistry[nodenum]) return;
		this.nodeRegistry[nodenum].username = username || "";
	}

	setNodeCallId(nodenum, callId) {
		if (!this.nodeRegistry[nodenum]) return;
		this.nodeRegistry[nodenum].callId = callId || null;
	}

	setNodeConnectionType(nodenum, connectionType) {
		if (!this.nodeRegistry[nodenum]) return;
		this.nodeRegistry[nodenum].connection_type = connectionType || "";
	}

	getNodeInfo(nodenum) {
		return this.nodeRegistry[nodenum] || null;
	}

	// --- Door capacity ---

	// Count how many nodes are currently running a specific door
	getDoorCount(doorSlug) {
		var count = 0;
		for (var nodenum in this.nodeRegistry) {
			var entry = this.nodeRegistry[nodenum];
			if (entry.status === "door" && entry.detail === doorSlug) {
				count++;
			}
		}
		return count;
	}

	// Check if a door has capacity for another player
	// maxnodes: 0 or undefined = no limit
	doorHasCapacity(doorSlug, maxnodes) {
		if (!maxnodes || maxnodes <= 0) return true;
		return this.getDoorCount(doorSlug) < maxnodes;
	}

	// --- Who's online / node listing ---

	getActiveNodes() {
		var nodes = [];
		for (var nodenum in this.nodeRegistry) {
			nodes.push(Object.assign({}, this.nodeRegistry[nodenum]));
		}
		return nodes;
	}

	// Get nodes running a specific door (for lobby displays, etc.)
	getNodesInDoor(doorSlug) {
		var nodes = [];
		for (var nodenum in this.nodeRegistry) {
			var entry = this.nodeRegistry[nodenum];
			if (entry.status === "door" && entry.detail === doorSlug) {
				nodes.push(Object.assign({}, entry));
			}
		}
		return nodes;
	}

	// --- Display helpers ---

	getNodeNumString() {
		var numstring = "";
		var i = 1;
		for (var nnum of this.nodenumsinuse) {
			numstring += nnum;
			if (i != this.nodenumsinuse.length) {
				numstring += ", ";
			}
			i++;
		}
		return numstring;
	}

	listUsedNodes() {
		if (this.nodenumsinuse.length > 0) {
			if (this.nodenumsinuse.length > 1) {
				var nodemsg = "Node numbers ";
				var numstring = this.getNodeNumString();
				nodemsg += numstring;
				nodemsg += " are in use";
			} else {
				var nodemsg = "Node number ";
				var numstring = this.getNodeNumString();
				nodemsg += numstring;
				nodemsg += " is in use";
			}
			alogger.writeAlog(1, nodemsg, "greenbright", true);
		} else {
			var nodemsg = "There are no Nodes currently in use";
			alogger.writeAlog(1, nodemsg, "greenbright", true);
		}
	}
}

export { nodeManager };