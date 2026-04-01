// nodeSpy.js -- Sysop node spy: view active nodes, watch live terminal output, chat
//
// States: list -> watching -> chatting -> watching -> list (or return)
// List state: shows active terminal nodes, sysop enters a node number
// Watching state: mirrors the target node's OutputRingBuffer in real-time
// Chatting state: split-screen chat with the target user
// ESC exits chatting (back to watching), watching (back to list), or list (return)

import { BaseSubModule } from "../basesubmodule.js";
import { formatActivity } from "../../utils/activityMap.js";
import { utf8ToCp437 } from "../../utils/codepageConversions.js";
import { SplitScreenChat } from "../splitscreenchat.js";
import * as alogger from "../../utils/alogger.js";

const headclr = 11;    // bright yellow
const nodeclr = 14;    // bright cyan
const unameclr = 13;   // bright magenta
const actclr = 6;      // cyan
const connclr = 12;    // bright blue
const titleclr = 10;   // bright green
const promptclr = 11;  // bright yellow
const errorclr = 1;    // red
const msgclr = 10;     // bright green

class nodeSpy extends BaseSubModule {
	constructor(call) {
		super(call, "NodeSpy");
		this._state = 'list';
		this._inputBuf = '';
		this._nodes = [];
		this._watchingNode = null;
		this._watchingCall = null;
		this._dataListener = null;
		this._endListener = null;

		// Chat state
		this._sysopChat = null;    // SplitScreenChat for sysop's terminal
		this._targetChat = null;   // SplitScreenChat for target's terminal
		this._targetPrevRaw = false;
		this._targetPrevRawtarget = null;
		this._chatQueued = false;

		// Column positions
		this.col1x = 3;   // Node
		this.col2x = 10;  // Username
		this.col3x = 32;  // Activity
		this.col4x = 62;  // Connection

		this.loggingId = "NodeSpy (Node " + call.nodenum + ")";
	}

	_getCallManager() {
		return this.call?.callPool?.callManager || null;
	}

	_getNodeManager() {
		return this.call?.nodeManager || null;
	}

	_formatConnection(node) {
		if (node.web_originated) return 'Web';
		var ct = node.connection_type || '';
		if (ct === 'Websock' || ct === 'Websocket' || ct === 'TCP' || ct === 'Telnet') return 'Terminal';
		return ct || 'Unknown';
	}

	// --- List state ---

	_showNodeList() {
		this._state = 'list';
		this._inputBuf = '';
		this._nodes = [];

		var nodeManager = this._getNodeManager();
		if (nodeManager) {
			this._nodes = nodeManager.getActiveNodes()
				.filter(n => n.nodenum !== this.call.nodenum)  // exclude self
				.sort((a, b) => a.nodenum - b.nodenum);
		}

		if (this.dumb) {
			this._showNodeListDumb();
			return;
		}

		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();

		// Title
		var title = "Node Spy";
		var titleX = Math.round((this.call.term_width || 80) / 2) - Math.round(title.length / 2);
		this.call.cmds.movecursor(titleX, 2);
		this.call.cmds.setfgcolor(titleclr);
		this.call.cmds.senddata(title);

		if (this._nodes.length === 0) {
			this.call.cmds.movecursor(this.col1x, 5);
			this.call.cmds.setfgcolor(msgclr);
			this.call.cmds.senddata("No other active nodes.");
			this._drawPrompt();
			return;
		}

		// Header
		var currY = 4;
		this.call.cmds.movecursor(this.col1x, currY);
		this.call.cmds.setfgcolor(headclr);
		this.call.cmds.senddata("Node");
		this.call.cmds.movecursor(this.col2x, currY);
		this.call.cmds.senddata("Username");
		this.call.cmds.movecursor(this.col3x, currY);
		this.call.cmds.senddata("Activity");
		this.call.cmds.movecursor(this.col4x, currY);
		this.call.cmds.senddata("Connection");
		currY++;

		this.call.cmds.movecursor(this.col1x, currY);
		this.call.cmds.setfgcolor(headclr);
		this.call.cmds.senddata("----");
		this.call.cmds.movecursor(this.col2x, currY);
		this.call.cmds.senddata("--------------------");
		this.call.cmds.movecursor(this.col3x, currY);
		this.call.cmds.senddata("----------------------------");
		this.call.cmds.movecursor(this.col4x, currY);
		this.call.cmds.senddata("----------");
		currY++;

		for (var i = 0; i < this._nodes.length; i++) {
			var node = this._nodes[i];

			this.call.cmds.movecursor(this.col1x, currY);
			this.call.cmds.setfgcolor(nodeclr);
			this.call.cmds.senddata(String(node.nodenum));

			this.call.cmds.movecursor(this.col2x, currY);
			this.call.cmds.setfgcolor(unameclr);
			this.call.cmds.senddata(node.username || '-');

			this.call.cmds.movecursor(this.col3x, currY);
			this.call.cmds.setfgcolor(actclr);
			this.call.cmds.senddata(formatActivity(node.status, node.detail, node.detail_display));

			this.call.cmds.movecursor(this.col4x, currY);
			this.call.cmds.setfgcolor(connclr);
			this.call.cmds.senddata(this._formatConnection(node));

			currY++;
		}

		this._drawPrompt();
	}

	_showNodeListDumb() {
		this.call.cmds.senddata("\r\n\r\n  Node Spy\r\n\r\n");

		if (this._nodes.length === 0) {
			this.call.cmds.senddata("  No other active nodes.\r\n\r\n");
			this.call.cmds.senddata("  ESC to exit\r\n");
			return;
		}

		this.call.cmds.senddata("  Node  Username              Activity                      Connection\r\n");
		this.call.cmds.senddata("  ----  --------------------  ----------------------------  ----------\r\n");

		for (var i = 0; i < this._nodes.length; i++) {
			var node = this._nodes[i];
			var line = "  " + String(node.nodenum).padEnd(6);
			line += (node.username || '-').padEnd(22);
			line += formatActivity(node.status, node.detail, node.detail_display).substring(0, 28).padEnd(30);
			line += this._formatConnection(node);
			this.call.cmds.senddata(line + "\r\n");
		}

		this.call.cmds.senddata("\r\n  Enter node number to watch (ESC to exit): ");
	}

	_drawPrompt() {
		if (this.dumb) return;
		var maxY = this.call.term_height || 25;
		this.call.cmds.movecursor(this.col1x, maxY - 1);
		this.call.cmds.setfgcolor(promptclr);
		this.call.cmds.senddata("Enter node number to watch (ESC to exit): ");
		this.call.cmds.setfgcolor(14);
		this.call.cmds.senddata(this._inputBuf);
	}

	_drawError(msg) {
		if (this.dumb) {
			this.call.cmds.senddata("\r\n  " + msg + "\r\n");
			return;
		}
		var maxY = this.call.term_height || 25;
		this.call.cmds.movecursor(this.col1x, maxY - 2);
		this.call.cmds.cleartoeol();
		this.call.cmds.setfgcolor(errorclr);
		this.call.cmds.senddata(msg);
	}

	_clearError() {
		if (this.dumb) return;
		var maxY = this.call.term_height || 25;
		this.call.cmds.movecursor(this.col1x, maxY - 2);
		this.call.cmds.cleartoeol();
	}

	// --- Watching state ---

	_startWatching(nodenum) {
		var callManager = this._getCallManager();
		if (!callManager) {
			this._drawError("CallManager not available");
			return;
		}

		var targetCall = callManager.getCallByNode(nodenum);
		if (!targetCall || !targetCall.outputBuffer) {
			this._drawError("Node " + nodenum + " is not active");
			return;
		}

		this._state = 'watching';
		this._watchingNode = nodenum;
		this._watchingCall = targetCall;

		alogger.writeAlog(2, "NodeSpy: Node " + this.call.nodenum + " (" +
			(this.call.caller_username || 'sysop') + ") watching node " + nodenum, "cyanbright");

		// Ring buffer is always UTF-8. If the sysop's terminal is CP437,
		// convert before sending. UTF-8 terminals get raw passthrough.
		var sysopEncoding = this.call.term_encoding || 'CP437';
		var needsCp437 = (sysopEncoding !== 'UTF8' && sysopEncoding !== 'utf-8' && sysopEncoding !== 'utf8');

		function convertForSysop(buf) {
			if (!needsCp437) return buf;
			return Buffer.from(utf8ToCp437(buf.toString('utf8')));
		}

		// Clear screen and send catch-up history
		this.call.cmds.clearscreen();
		var history = targetCall.outputBuffer.getHistory();
		if (history.length > 0) {
			this.call.cmds.senddata(convertForSysop(history));
		}

		// Live data listener
		var self = this;
		this._dataListener = function(buf) {
			if (!self.active || !self.call) return;
			// Don't forward ring buffer data while chatting --
			// the split-screen chat manages its own display
			if (self._state === 'chatting') return;
			self.call.cmds.senddata(convertForSysop(buf));
			// Redraw queued indicator after output
			if (self._chatQueued) self._drawQueuedIndicator();
		};

		// End listener (target disconnected)
		this._endListener = function() {
			if (!self.active || !self.call) return;
			if (self._state === 'chatting') {
				self._stopChat("Session ended on node " + nodenum);
			}
			self._stopWatching("Session ended on node " + nodenum);
		};

		targetCall.outputBuffer.emitter.on('data', this._dataListener);
		targetCall.outputBuffer.emitter.on('end', this._endListener);
	}

	_drawQueuedIndicator() {
		if (!this.call || !this.active) return;
		var cmds = this.call.cmds;
		var label = " CHAT QUEUED - waiting for menu ";
		var col = Math.max(1, (this.call.term_width || 80) - label.length);
		cmds.savecursor();
		cmds.movecursor(col, 1);
		cmds.senddata("\x1b[1;43;30m"); // bold black on yellow
		cmds.senddata(label);
		cmds.resetcolors();
		cmds.restorecursor();
	}

	_stopWatching(message) {
		// Cancel any queued chat
		this._cancelQueuedChat();

		// Remove listeners
		if (this._watchingCall && this._watchingCall.outputBuffer) {
			if (this._dataListener) {
				this._watchingCall.outputBuffer.emitter.removeListener('data', this._dataListener);
			}
			if (this._endListener) {
				this._watchingCall.outputBuffer.emitter.removeListener('end', this._endListener);
			}
		}

		var wasNode = this._watchingNode;
		this._dataListener = null;
		this._endListener = null;
		this._watchingCall = null;
		this._watchingNode = null;

		if (message) {
			alogger.writeAlog(2, "NodeSpy: Node " + this.call.nodenum + " stopped watching node " +
				wasNode + " (" + message + ")", "cyan");
		}

		// Show a brief message then return to list
		if (this.dumb) {
			this.call.cmds.senddata("\r\n\r\n  " + (message || "Stopped watching") + "\r\n");
			this.call.cmds.senddata("  Press any key...\r\n");
			this._state = 'message';
		} else {
			this.call.cmds.clearscreen();
			this.call.cmds.movecursor(3, 3);
			this.call.cmds.setfgcolor(msgclr);
			this.call.cmds.senddata(message || "Stopped watching");
			this.call.cmds.movecursor(3, 5);
			this.call.cmds.setfgcolor(8);
			this.call.cmds.senddata("Press any key to continue...");
			this.call.cmds.resetcolors();
			this._state = 'message';
		}
	}

	// --- Chat state ---

	_queueChat() {
		if (!this._watchingCall) return;
		var targetCall = this._watchingCall;
		var self = this;

		// Already queued
		if (targetCall.pendingChat) {
			this.call.cmds.sendbeep();
			return;
		}

		this._chatQueued = true;
		targetCall.pendingChat = {
			sysopCall: this.call,
			callback: function() {
				if (!self.active || !self.call) return;
				if (self._state !== 'watching') return;
				self._chatQueued = false;
				self._launchChat();
			}
		};

		this._drawQueuedIndicator();

		alogger.writeAlog(2, "NodeSpy: Node " + this.call.nodenum +
			" queued chat for node " + this._watchingNode +
			" (waiting for menu)", "cyan");
	}

	_cancelQueuedChat() {
		if (this._watchingCall && this._watchingCall.pendingChat) {
			this._watchingCall.pendingChat = null;
		}
		this._chatQueued = false;
	}

	_startChat() {
		if (!this._watchingCall || !this._watchingCall.cmds) {
			return;
		}

		var targetCall = this._watchingCall;

		// If not at a menu, queue the chat for when they return
		if (targetCall.call_status !== 'menu') {
			this._queueChat();
			return;
		}

		this._launchChat();
	}

	_launchChat() {
		var targetCall = this._watchingCall;
		if (!targetCall || !targetCall.cmds) return;

		var sysopName = this.call.caller_username || "Sysop";
		var targetName = targetCall.caller_username || "User";

		alogger.writeAlog(2, "NodeSpy: Node " + this.call.nodenum + " (" +
			sysopName + ") started chat with node " + this._watchingNode +
			" (" + targetName + ")", "cyanbright");

		this._state = 'chatting';

		var self = this;

		// --- Sysop side: split-screen with peek line ---
		this._sysopChat = new SplitScreenChat(this.call, {
			sysopLabel: sysopName,
			userLabel: targetName,
			showPeekLine: true,
			exitLabel: "ESC to exit chat",
			onSend: function(text) {
				self._sysopChat.sysopMessage(text);
				if (self._targetChat) {
					self._targetChat.sysopMessage(text);
				}
			},
			onExit: function() {
				self._stopChat();
			}
		});
		this._sysopChat.start();

		// --- Target side: hijack input and split-screen ---
		this._targetPrevRaw = targetCall.rawmode;
		this._targetPrevRawtarget = targetCall.rawtarget;

		this._targetChat = new SplitScreenChat(targetCall, {
			sysopLabel: sysopName,
			userLabel: targetName,
			allowExit: false,
			onSend: function(text) {
				self._targetChat.userMessage(text);
				if (self._sysopChat) {
					self._sysopChat.userMessage(text);
					self._sysopChat.clearPeekLine();
				}
			},
			onTyping: function(inputBuf) {
				if (self._sysopChat) {
					self._sysopChat.updatePeekLine(inputBuf);
				}
			}
		});

		// Alert the user with beeps
		for (var bi = 0; bi < 5; bi++) {
			(function(delay) {
				setTimeout(function() { if (targetCall.cmds) targetCall.cmds.sendbeep(); }, delay);
			})(bi * 100);
		}

		targetCall.rawmode = true;
		targetCall.rawtarget = function(data) {
			// Route target's raw input through the chat handler
			self._onTargetRawInput(data);
		};

		this._targetChat.start();

		// Update node status
		this.call.updateNodeStatus('sysop_chat', targetName);
		targetCall.updateNodeStatus('sysop_chat', sysopName);
	}

	_stopChat(message) {
		var targetCall = this._watchingCall;

		// Tear down sysop side
		if (this._sysopChat) {
			if (message) this._sysopChat._systemMessage(message);
			this._sysopChat._systemMessage("Chat ended");
			this._sysopChat.stop();
			this._sysopChat = null;
		}

		// Tear down target side
		if (this._targetChat && targetCall) {
			if (message) this._targetChat._systemMessage(message);
			this._targetChat._systemMessage("Chat ended");
			this._targetChat.stop();
			this._targetChat = null;

			// Restore target's input handler
			targetCall.rawmode = this._targetPrevRaw;
			targetCall.rawtarget = this._targetPrevRawtarget;
			this._targetPrevRaw = false;
			this._targetPrevRawtarget = null;

			// Redraw the target's menu (we only start chat when at a menu)
			targetCall.cmds.clearscreen();
			targetCall.cmds.resetcolors();
			if (targetCall.currentHandler && targetCall.currentHandler._drawMenu) {
				targetCall.currentHandler._drawMenu();
			}

			// Restore target's node status
			targetCall.updateNodeStatus('menu', targetCall.currentMenu || '');
		}

		alogger.writeAlog(2, "NodeSpy: Chat ended between node " + this.call.nodenum +
			" and node " + this._watchingNode, "cyan");

		// Return sysop to watching state
		this._state = 'watching';
		this.call.cmds.clearscreen();
		this.call.cmds.resetcolors();

		// Re-send target's current screen from ring buffer history
		if (targetCall && targetCall.outputBuffer) {
			var sysopEncoding = this.call.term_encoding || 'CP437';
			var needsCp437 = (sysopEncoding !== 'UTF8' && sysopEncoding !== 'utf-8' && sysopEncoding !== 'utf8');
			var history = targetCall.outputBuffer.getHistory();
			if (history.length > 0) {
				if (needsCp437) {
					this.call.cmds.senddata(Buffer.from(utf8ToCp437(history.toString('utf8'))));
				} else {
					this.call.cmds.senddata(history);
				}
			}
		}

		this.call.updateNodeStatus('nodespy', String(this._watchingNode));
	}

	// Handle raw bytes from the target user during chat
	_onTargetRawInput(data) {
		if (!this._targetChat || !this._targetChat.active) return;

		var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
		for (var i = 0; i < buf.length; i++) {
			var b = buf[i];

			if (b === 0x1B) { // ESC
				this._targetChat.handleKey('ESC');
			} else if (b === 0x0D) { // Enter
				this._targetChat.handleKey('Enter');
			} else if (b === 0x08 || b === 0x7F) { // Backspace / DEL
				this._targetChat.handleKey('Backspace');
			} else if (b >= 0x20 && b < 0x7F) { // Printable ASCII
				this._targetChat.handleChar(String.fromCharCode(b));
			}
		}
	}

	// --- Input ---

	onKey(key) {
		if (!this.active || !this.call) return;

		if (this._state === 'chatting') {
			// Route sysop input to chat handler
			if (this._sysopChat) {
				this._sysopChat.handleKey(key);
			}
			return;
		}

		if (this._state === 'watching') {
			if (key === 'ESC') {
				this._stopWatching();
				return;
			}
			// C key starts chat (not on dumb terminals)
			if (!this.dumb && (key === 'C' || key === 'c')) {
				this._startChat();
				return;
			}
			return;
		}

		if (this._state === 'message') {
			this._showNodeList();
			return;
		}

		if (this._state === 'list') {
			if (key === 'ESC') {
				this.signalReturn();
				return;
			}
			if (key === 'Enter') {
				this._clearError();
				var nodenum = parseInt(this._inputBuf);
				this._inputBuf = '';
				if (isNaN(nodenum) || nodenum < 1) {
					this._drawError("Invalid node number");
					this._drawPrompt();
					return;
				}
				if (nodenum === this.call.nodenum) {
					this._drawError("Cannot spy on your own node");
					this._drawPrompt();
					return;
				}
				this._startWatching(nodenum);
				return;
			}
			if (key === 'Backspace') {
				if (this._inputBuf.length > 0) {
					this._inputBuf = this._inputBuf.slice(0, -1);
					this._clearError();
					this._drawPrompt();
				}
				return;
			}
		}
	}

	onChar(ch) {
		if (!this.active || !this.call) return;

		if (this._state === 'chatting') {
			if (this._sysopChat) {
				this._sysopChat.handleChar(ch);
			}
			return;
		}

		if (this._state === 'watching') {
			// C key starts chat
			if (!this.dumb && (ch === 'C' || ch === 'c')) {
				this._startChat();
			}
			return;
		}

		if (this._state === 'message') {
			this._showNodeList();
			return;
		}

		if (this._state === 'list') {
			// Only accept digits for node number input
			if (ch >= '0' && ch <= '9' && this._inputBuf.length < 4) {
				this._inputBuf += ch;
				this._clearError();
				this._drawPrompt();
			}
		}
	}

	run() {
		if (!this.call) { this.signalReturn(); return; }
		this._showNodeList();
	}

	clearHandler() {
		// Cancel queued chat
		this._cancelQueuedChat();

		// Clean up any active chat session
		if (this._state === 'chatting') {
			this._stopChat("Sysop disconnected");
		}

		// Clean up any active snoop listeners
		if (this._watchingCall && this._watchingCall.outputBuffer) {
			if (this._dataListener) {
				this._watchingCall.outputBuffer.emitter.removeListener('data', this._dataListener);
			}
			if (this._endListener) {
				this._watchingCall.outputBuffer.emitter.removeListener('end', this._endListener);
			}
		}
		this._dataListener = null;
		this._endListener = null;
		this._watchingCall = null;
		this._watchingNode = null;
		this._sysopChat = null;
		this._targetChat = null;
		super.clearHandler();
	}
}

export { nodeSpy };
