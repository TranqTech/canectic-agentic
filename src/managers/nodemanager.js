//imports
import { EventEmitter } from 'node:events';
//internal modules
import * as alogger from "../utils/alogger.js"

class nodeManager{
	constructor(){
		//this.uuid = uuidv4()
		this.emitter = new EventEmitter();
		this.nodenumsinuse = []
		this.lastnodereleased = 0
		this.currentNodes = []		
	}
	getAvailNodeNum(){
		var numset = false
		var i = 1
		while (numset == false){
			if (!this.nodenumsinuse.includes(i)){
				numset = true
				this.nodenumsinuse.push(i)
				var nodemsg = "Node Number " + i + " selected for use"
				alogger.writeAlog(1, nodemsg, "yellowbright", true)
				return i
			}else{
				i += 1
			}
		}
	}
	releaseNodeNum(nodenum){
		var releasemsg = "Attempting to release Node " + nodenum
		alogger.writeAlog(1, releasemsg, "redbright", true)
		const index = this.nodenumsinuse.indexOf(nodenum);
		if (index > -1) { // only splice array when item is found
			this.nodenumsinuse.splice(index, 1); // 2nd parameter means remove one item only
			this.lastnodereleased = nodenum
			this.emitter.emit('NodeReleased')
			var nodemsg = "Node " + nodenum + " released"
			alogger.writeAlog(1, nodemsg, "redbright", true)
			this.listUsedNodes()
		}		
	}
	getNodeNumString(){
		var numstring = ""
		var i = 1
		for (var nnum of this.nodenumsinuse){
			numstring += nnum
			if (i != this.nodenumsinuse.length){
				numstring += ", "
			}
		}
		return numstring
	}
	listUsedNodes(){
		if (this.nodenumsinuse.length > 0){
			if (this.nodenumsinuse.length > 1){
				var nodemsg = "Node numbers "
				var numstring = this.getNodeNumString()
				nodemsg += numstring
				nodemsg += " are in use"
			}else{
				var nodemsg = "Node number "
				var numstring = this.getNodeNumString()
				nodemsg += numstring
				nodemsg += " is in use"
			}			
			alogger.writeAlog(1, nodemsg, "greenbright", true)
		}else{
			var nodemsg = "There are no Nodes currently in use"
			alogger.writeAlog(1, nodemsg, "greenbright", true)
		}
	}
}



export{nodeManager}