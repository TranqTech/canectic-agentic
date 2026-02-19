//node imports
import { EventEmitter } from 'node:events';
import {appendFileSync, existsSync, mkdirSync, readdir, readdirSync, createReadStream, readFile, readFileSync} from 'fs';
import * as dotenv from 'dotenv';

//setup
dotenv.config();
const textdir = process.env.textdir
const escape_intermed = new RegExp("[!\"#$%&'()*+,-./]")
const escape_terminator1 = new RegExp("[A-Za-z]")
const escape_terminator2 = new RegExp("[@\\[\\]^_`\\{\\}\\|~]")
const valid_escape_chars = new RegExp("[0-9:;?= ]")
const df_esc_timeout = 50

class ansiInputParser{
	constructor(call){
		this.call = call
		this.emitter = new EventEmitter();
		this.hexbuffer = ""
		this.output_array = []
		this.runningparser = false
		this.escapemode = false
		this.esc_timeout = df_esc_timeout
		this.escapebuffer = ""
		this.zombieTO
	}
	queueOutput(data){
		this.output_array.push(data)
	}
	flushOutput(){
		if (this.output_array.length > 0 && this.call){
			var batch = this.output_array
			this.output_array = []
			// Route through the call's handleData which sends to the current handler
			if (this.call.currentHandler && this.call.currentHandler.active){
				this.call.currentHandler.handleInput(batch)
			}
		}
	}
	parseHexByte(hexbyte){
		clearTimeout(this.escTO)
		var stringchar = String.fromCharCode(parseInt(hexbyte, 16))
		if (this.escapemode){
			if ((this.escapebuffer.length == 0) && (stringchar == "[")){
				this.escapebuffer += stringchar
				return;
			}
			if (escape_intermed.test(stringchar)){
				this.escapebuffer += stringchar
				return;
			}
			if (valid_escape_chars.test(stringchar)){
				this.escapebuffer += stringchar
				return;
			}
			if (escape_terminator1.test(stringchar)){
				this.escapebuffer += stringchar
				this.doEscape()
				return;
			}
			if (escape_terminator2.test(stringchar)){
				this.escapebuffer += stringchar
				this.doEscape()
				return;
			}
			if (stringchar == "\x1b"){
				if (this.escapebuffer.length < 1){
					this.queueOutput("KEY_ESC")
				}
				this.escapebuffer = ""
				this.escTO = setTimeout(this.doEscape.bind(this), this.esc_timeout)
				return;
			}
			console.log(stringchar, "Not valid ESC")
			this.escapemode = false
		}
		if (stringchar == "\x1b"){
			this.escTO = setTimeout(this.doEscape.bind(this), this.esc_timeout)
			this.escapemode = true
			return;
		}
		var keyname = ""
		switch (stringchar){
			case "\t":
				keyname = "KEY_Tab"
				break;
			case "\r":
				keyname = "KEY_Enter"
				break;
			case "\b":
				keyname = "KEY_Backspace"
				break;
			case "\x7f":
				keyname = "KEY_Backspace"
				break;
			case "\x01":
				keyname = "KEY_^A"
				break;
			case "\x13":
				keyname = "KEY_^S"
				break;
			case "\x1a":
				keyname = "KEY_^Z"
				break;
			default:
				keyname = "CHAR_" + stringchar
				break;
		}
		if (keyname){
			this.queueOutput(keyname);
		}else{
			console.log("No Key Parsed")
		}
	}
	doEscape(){
		if (this.escapemode){
			this.escapemode = false
			if (this.escapebuffer.length < 1){
				this.queueOutput("KEY_ESC")
				this.flushOutput()
				return;
			}
			var keyname = ""
			switch (this.escapebuffer){
				case "[A":
					keyname = "KEY_UpArrow"
					break;
				case "[B":
					keyname = "KEY_DownArrow"
					break;
				case "[C":
					keyname = "KEY_RightArrow"
					break;
				case "[D":
					keyname = "KEY_LeftArrow"
					break;
				case "[3~":
					keyname = "KEY_Delete"
					break;
				case "[H":
					keyname = "KEY_Home"
					break;
				case "[F":
					keyname = "KEY_End"
					break;
				default:
					console.log("Unknown Escape Sequence:", this.escapebuffer)
					break;
			}
			this.escapebuffer = ""
			if (keyname){
				this.queueOutput(keyname)
			}
			// Flush here since this may fire from a timeout
			this.flushOutput()
		}
	}
	doHexBuffer(){
		while (this.hexbuffer.length > 0){
			var hexbyte = this.hexbuffer.substr(0,2)
			this.hexbuffer = this.hexbuffer.slice(2)
			this.parseHexByte(hexbyte)
		}
	}
	handleData(){
		if (!this.runningparser){
			this.runningparser = true
			this.doHexBuffer()
			// Flush any non-escape tokens that were queued during the parse
			if (!this.escapemode){
				this.flushOutput()
			}
			this.runningparser = false
		}
	}
	clearParser(){
		clearTimeout(this.escTO)
		this.call = null
	}
}

class ripCommands{
	constructor(socket){
		this.socket = socket
		this.ripstart = "!|"
	}
}


class tcpCommands{
	constructor(socket){
		this.socket = socket
		this.term_type = "Dumb"
		this.encoding = "CP437"
		this.rip_major = 0
		this.rip_minor = 0
		this.rip_string = ""
		this.use_rip = false
	}
	updateTermType(term_type, rip_major, rip_minor, rip_string, use_rip, encoding){
		this.term_type = term_type
		this.rip_major = rip_major
		this.rip_minor = rip_minor
		this.rip_string = rip_string
		this.use_rip = use_rip
		this.encoding = encoding
	}
	senddata(data){
		this.socket.write(Buffer.from(data))
	}
	sendbeep(){
		this.socket.write(Buffer.from("\x07"))
	}
	drawfile(artfile, doscreenclear){
		try{
			//read and convert to hex string so we can more easily split off sauce or translate
			var filehex = readFileSync(artfile).toString('hex')
			//remove sauce
			//split at eof byte. Have to iterate through bytes to avoid weird splits
			var posthex = ""
			while (filehex.length > 0){
				var hexbyte = filehex.substr(0,2)
				filehex = filehex.slice(2)
				if (hexbyte == "1a"){
					filehex = ""
				}else{
					posthex += hexbyte
				}				
			}
			if (posthex.length > 0){
				//put back together as a buffer
				var sendbuffer = new Buffer.from(posthex, 'hex')
				//send the buffer
				if (doscreenclear){
					this.clearscreen()
				}
				this.senddata(sendbuffer)
				this.resetcolors()
			}			
		}catch(err){
			console.log(err)
		}
	}
	drawscreen(filename, type, doscreenclear){
		switch(type){
			case "Screen":
				var subdir = "screens"
				break
			case "Header":
				var subdir = "headers"
				break
			default:
				var subdir = "misc"
				break;
		}
		if (this.term_type == "Dumb"){
			var artdir = textdir + "/asc"
		}else{
			if (this.use_rip){
				var artdir = textdir + "/rip"
				filename = filename + ".rip"
			}
			else if (this.encoding == "UTF8"){
				var artdir = textdir + "/utf8"
				filename = filename + ".ut8"
			}else{
				var artdir = textdir + "/ans"
				filename = filename + ".ans"
			}
		}
		artdir = artdir + "/" + subdir
		//check if directory exists
		if (!existsSync(artdir)) {
			console.log("Text dir", artdir, "doesn't exist!")
			return;
		}
		var artfile = artdir + "/" + filename
		if (!existsSync(artfile)) {
			console.log("Text file", artfile, "doesn't exist!")
			return;
		}
		if (doscreenclear){
			this.drawfile(artfile, true)
			return
		}
		this.drawfile(artfile)
	}
	drawrandomscreen(screentype, doscreenclear){
		switch(screentype){
			case "Logon":
				var subdir = "logon"
				break;
			case "Login":
				var subdir = "login"
				break;
			case "Logoff":
				var subdir = "logoff"
				break;
			case "Goodbye":
				var subdir = "goodbye"
				break;
			case "Registration":
				var subdir = "registration"
				break;
			default:
				var subdir = "random"
		}
		if (this.term_type == "Dumb"){
			var artdir = textdir + "/asc"
		}else{
			if (this.use_rip){
				var artdir = textdir + "/rip"
			}
			else if (this.encoding == "UTF8"){
				var artdir = textdir + "/utf8"
			}else{
				var artdir = textdir + "/ans"
			}
		}
		artdir = artdir + "/" + subdir
		//check if directory exists
		if (!existsSync(artdir)) {
			console.log("Text dir", artdir, "doesn't exist!")
			return;
		}
		//check if directory contains files
		var filecount = 0
		var filearray = []
		readdirSync(artdir).forEach(file => {
			filecount += 1
			filearray.push(file)
		})
		if (filecount < 1){
			console.log("No files in directory")
			return;
		}		
		//select random file
		var artfilename = filearray[Math.floor(Math.random()*filearray.length)];
		if (!artfilename){
			console.log("Could not select file")
			return;
		}
		var artfile = artdir + "/" + artfilename
		if (doscreenclear){
			this.drawfile(artfile, true)
			return
		}
		this.drawfile(artfile)
	}
	resetcolors(){
		if (this.term_type != "Dumb"){
			this.socket.write("\x1b[0m")
			this.socket.write("\x1b[39m")
			//this.socket.write("\x1b[49m")
			//this.socket.write("\x1b[40m")
			if (this.term_type == "Unknown"){
				this.setbgcolor("0")
			}else{
				this.socket.write("\x1b[49m")
			}
		}
	}
	setfgcolor(fgcolor){
		if (this.term_type != "Dumb"){
			//console.log("Setting fg color")
			var setclr = fgcolor
			if (isNaN(fgcolor)){
				setclr = 7
			}
			if (setclr > 7){
				setclr = setclr + 30
				var fgcolorstring="\x1b[1;"+ (setclr-8) + "m"
			}else{
				setclr = setclr + 30
				var fgcolorstring="\x1b[0;"+ setclr + "m"
			}
			var fgcolorstringbuff = Buffer.from(fgcolorstring)
			this.socket.write(fgcolorstringbuff)
		}
		return;
		
	}
	setbgcolor(bgcolor){
		if (this.term_type != "Dumb"){
			//console.log("Setting bg color")
			var setclr = bgcolor
			if (isNaN(bgcolor)){
				setclr = 0
			}
			if (setclr > 7){
				setclr = setclr + 40
				var fgcolorstring="\x1b[1;"+ (setclr-8) + "m"
			}else{
				setclr = setclr + 40
				var fgcolorstring="\x1b[0;"+ setclr + "m"
			}
			var fgcolorstringbuff = Buffer.from(fgcolorstring)
			this.socket.write(fgcolorstringbuff)
			return;
		}
	}
	clearscreen(){
		if (this.term_type == "Dumb"){
			this.socket.write("\r\n\r\n\r\n\r\n")
			return;
		}
		this.socket.write("\x1b[2J")
	}
	cleartoeol(){
		var clearstr = "\x1b[0K"
		this.socket.write(clearstr)
	}
	cleartocursor(){
		var clearstr = "\x1b[1K"
		this.socket.write(clearstr)
	}
	clearfullline(){
		var clearstr = "\x1b[2K"
		this.socket.write(clearstr)
	}
	movecursor(xpos, ypos){
		var movestring = "\x1b[" + ypos + ";" + xpos + "H"
		this.socket.write(movestring)
	}
	movecursorup(num){
		var movestring = "\x1b[" + num + "A"
		this.socket.write(movestring)
	}
	movecursordown(num){
		var movestring = "\x1b[" + num + "B"
		this.socket.write(movestring)
	}
	movecursorright(num){
		var movestring = "\x1b[" + num + "C"
		this.socket.write(movestring)
	}
	movecursorleft(num){
		var movestring = "\x1b[" + num + "D"
		this.socket.write(movestring)
	}
	moveupone(){
		this.socket.write("\x1b[A")
	}
	movedownone(){
		this.socket.write("\x1b[B")
	}
	moveleftone(){
		this.socket.write("\x1b[D")
	}
	moverightone(){
		this.socket.write("\x1b[C")
	}

	homecursor(){
		this.socket.write("\x1b[H")
	}
	clearline(lineint){
		if (clint){
			var clearstr = "\x1b[" + lineint + "K"
		}else{
			var clearstr = "\x1b[K"
		}
		this.socket.write(clearstr)
	}
	clearhandler(){
		this.socket = null
		delete this
	}
}

class websockCommands{
	constructor(socket){
		this.commandType = "Websock"
		this.socket = socket
		this.term_type = "Dumb"
		this.encoding = "CP437"
		this.rip_major = 0
		this.rip_minor = 0
		this.rip_string = ""
		this.use_rip = false
	}
	senddata(data){
		this.socket.send(Buffer.from(data))
	}
	sendstring(string){
		this.socket.send(Buffer.from(string))
	}
	sendbeep(){
		this.socket.send(Buffer.from("\x07"))
	}
	drawfile(artfile, doscreenclear){
		try{
			//read and convert to hex string so we can more easily split off sauce or translate
			var filehex = readFileSync(artfile).toString('hex')
			//remove sauce
			//split at eof byte. Have to iterate through bytes to avoid weird splits
			var posthex = ""
			while (filehex.length > 0){
				var hexbyte = filehex.substr(0,2)
				filehex = filehex.slice(2)
				if (hexbyte == "1a"){
					filehex = ""
				}else{
					posthex += hexbyte
				}				
			}
			if (posthex.length > 0){
				//put back together as a buffer
				var sendbuffer = new Buffer.from(posthex, 'hex')
				//send the buffer
				if (doscreenclear){
					this.clearscreen()
				}
				this.senddata(sendbuffer)
				this.resetcolors()
			}			
		}catch(err){
			console.log(err)
		}
	}
	drawscreen(filename, type, doscreenclear){
		switch(type){
			case "Screen":
				var subdir = "screens"
				break
			case "Header":
				var subdir = "headers"
				break
			default:
				var subdir = "misc"
				break;
		}
		if (this.term_type == "Dumb"){
			var artdir = textdir + "/asc"
		}else{
			if (this.use_rip){
				var artdir = textdir + "/rip"
				filename = filename + ".rip"
			}
			else if (this.encoding == "UTF8"){
				var artdir = textdir + "/utf8"
				filename = filename + ".ut8"
			}else{
				var artdir = textdir + "/ans"
				filename = filename + ".ans"
			}
		}
		artdir = artdir + "/" + subdir
		//check if directory exists
		if (!existsSync(artdir)) {
			console.log("Text dir", artdir, "doesn't exist!")
			return;
		}
		var artfile = artdir + "/" + filename
		if (!existsSync(artfile)) {
			console.log("Text file", artfile, "doesn't exist!")
			return;
		}
		if (doscreenclear){
			this.drawfile(artfile, true)
			return
		}
		this.drawfile(artfile)
	}
	drawrandomscreen(screentype, doscreenclear){
		switch(screentype){
			case "Logon":
				var subdir = "logon"
				break;
			case "Login":
				var subdir = "login"
				break;
			case "Logoff":
				var subdir = "logoff"
				break;
			case "Goodbye":
				var subdir = "goodbye"
				break;
			case "Registration":
				var subdir = "registration"
				break;
			default:
				var subdir = "random"
		}
		if (this.term_type == "Dumb"){
			var artdir = textdir + "/asc"
		}else{
			if (this.use_rip){
				var artdir = textdir + "/rip"
			}
			else if (this.encoding == "UTF8"){
				var artdir = textdir + "/utf8"
			}else{
				var artdir = textdir + "/ans"
			}
		}
		artdir = artdir + "/" + subdir
		//check if directory exists
		if (!existsSync(artdir)) {
			console.log("Text dir", artdir, "doesn't exist!")
			return;
		}
		//check if directory contains files
		var filecount = 0
		var filearray = []
		readdirSync(artdir).forEach(file => {
			filecount += 1
			filearray.push(file)
		})
		if (filecount < 1){
			console.log("No files in directory")
			return;
		}		
		//select random file
		var artfilename = filearray[Math.floor(Math.random()*filearray.length)];
		if (!artfilename){
			console.log("Could not select file")
			return;
		}
		var artfile = artdir + "/" + artfilename
		if (doscreenclear){
			this.drawfile(artfile, true)
			return
		}
		this.drawfile(artfile)
	}
	resetcolors(){
		if (this.term_type != "Dumb"){
			this.socket.send("\x1b[0m")
			this.socket.send("\x1b[39m")
			//this.socket.write("\x1b[49m")
			//this.socket.write("\x1b[40m")
			if (this.term_type == "Unknown"){
				this.setbgcolor("0")
			}else{
				this.socket.send("\x1b[49m")
			}
		}
	}
	setfgcolor(fgcolor){
		if (this.term_type != "Dumb"){
			//console.log("Setting fg color")
			var setclr = fgcolor
			if (isNaN(fgcolor)){
				setclr = 7
			}
			if (setclr > 7){
				setclr = setclr + 30
				var fgcolorstring="\x1b[1;"+ (setclr-8) + "m"
			}else{
				setclr = setclr + 30
				var fgcolorstring="\x1b[0;"+ setclr + "m"
			}
			var fgcolorstringbuff = Buffer.from(fgcolorstring)
			this.socket.send(fgcolorstringbuff)
		}
		return;
		
	}
	setbgcolor(bgcolor){
		if (this.term_type != "Dumb"){
			//console.log("Setting bg color")
			var setclr = bgcolor
			if (isNaN(bgcolor)){
				setclr = 0
			}
			if (setclr > 7){
				setclr = setclr + 40
				var fgcolorstring="\x1b[1;"+ (setclr-8) + "m"
			}else{
				setclr = setclr + 40
				var fgcolorstring="\x1b[0;"+ setclr + "m"
			}
			var fgcolorstringbuff = Buffer.from(fgcolorstring)
			this.socket.send(fgcolorstringbuff)
			return;
		}
	}
	clearscreen(){
		if (this.term_type == "Dumb"){
			this.socket.send("\r\n\r\n\r\n\r\n")
			return;
		}
		this.socket.write("\x1b[2J")
	}
	cleartoeol(){
		var clearstr = "\x1b[0K"
		this.socket.send(clearstr)
	}
	cleartocursor(){
		var clearstr = "\x1b[1K"
		this.socket.send(clearstr)
	}
	clearfullline(){
		var clearstr = "\x1b[2K"
		this.socket.send(clearstr)
	}
	movecursor(xpos, ypos){
		var movestring = "\x1b[" + ypos + ";" + xpos + "H"
		this.socket.send(movestring)
	}
	movecursorup(num){
		var movestring = "\x1b[" + num + "A"
		this.socket.send(movestring)
	}
	movecursordown(num){
		var movestring = "\x1b[" + num + "B"
		this.socket.send(movestring)
	}
	movecursorright(num){
		var movestring = "\x1b[" + num + "C"
		this.socket.send(movestring)
	}
	movecursorleft(num){
		var movestring = "\x1b[" + num + "D"
		this.socket.send(movestring)
	}
	moveupone(){
		this.socket.send("\x1b[A")
	}
	movedownone(){
		this.socket.send("\x1b[B")
	}
	moveleftone(){
		this.socket.send("\x1b[D")
	}
	moverightone(){
		this.socket.send("\x1b[C")
	}

	homecursor(){
		this.socket.send("\x1b[H")
	}
	clearline(lineint){
		if (clint){
			var clearstr = "\x1b[" + lineint + "K"
		}else{
			var clearstr = "\x1b[K"
		}
		this.socket.send(clearstr)
	}
	clearhandler(){
		this.socket = null
		delete this
	}
}

class telnetCommands{
	constructor(){
		this.commandType = "Telnet"
	}
	clearscreen(){

	}
}


export{tcpCommands, websockCommands, telnetCommands, ansiInputParser}