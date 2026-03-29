

// UTF-8 hex-encoded equivalents of CP437 glyphs
// Same indices as cp437chars: arrows, faces, suits, block elements, etc.
const utf8chars = [
	"e28691", "e28693", "e28692", "e28690", "e28694", "e28695", // up,down,right,left,horiz,vert arrows
	"e298ba", "e298bb", "e299a5", "e299a6", "e299a3", "e299a0", // smile,smilefill,heart,diamond,club,spade
	"e28899", "e29982", "e29980",                                 // bullet,male,female
	"e299aa", "e299ab", "e298bc",                                 // note,dbnote,sun
	"e296ba", "e29784", "e296b2", "e296bc",                       // pointright,pointleft,pointup,pointdown
	"e29691", "e29692", "e29693",                                 // lightshade,medshade,darkshade
	"e29688", "e29684", "e29680", "e2968c", "e29690"              // block,halfblockb,halfblockt,halfblockl,halfblockr
]

const cp437chars = [
	"18", "19", "1a", "1b", "1d", "12", "01", "02", "03", "04",
 	"05", "06", "f9", "0b", "0c", "0d", "0e", "0f", "11", "12",
 	"1e", "1f", "b0", "b1", "b2", "db", "dc", "df", "dd", "de"
 	]

const cp437boxes = ["b3", "b4", "b5", "b6", "b7", "b8", "b9", "ba", "bb", "bc",
 	"bd", "be", "bf", "c0", "c1", "c2", "c3", "c4", "c5", "c6",
 	"c7", "c8", "c9", "ca", "cb", "cc", "cd", "ce", "cf", "d0",
 	"d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "da"]

const asciiboxes = ["b3", "b4", "b5", "b6", "b7", "b8", "b9", "ba", "bb", "bc",
 	"bd", "be", "bf", "c0", "c1", "c2", "c3", "c4", "c5", "c6",
 	"c7", "c8", "c9", "ca", "cb", "cc", "cd", "ce", "cf", "d0",
 	"d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "da"]

// UTF-8 hex-encoded box drawing characters (same indices as cp437boxes)
// Index: 0=vert, 1=vertleft, 2-9=double variants, 10=dblvert, 11-14=corners,
//        15=topright, 16-19=bottom variants, 20=horiz, 21=cross, 22-29=double variants,
//        30-39=more corners and variants
const utf8boxes = [
	"e29482", "e294a4", "e295a1", "e295a2", "e29596", "e29595", "e295a3", "e29591", "e29597", "e2959d",
	"e2959c", "e2959b", "e29490", "e29494", "e294b4", "e294ac", "e2949c", "e29480", "e294bc", "e2959e",
	"e2959f", "e2959a", "e29594", "e295a9", "e295a6", "e295a0", "e29590", "e295ac", "e295a7", "e295a8",
	"e295a4", "e295a5", "e29599", "e29598", "e29592", "e29593", "e295ab", "e295aa", "e29498", "e2948c"
]

const defaultchars = utf8chars


class charSet{
	constructor(encoding){
		console.log("Encoding", encoding)
		var chars = this.getchars(encoding)
		var boxes = this.getboxes(encoding)
		this.uparrow = chars[0]
		this.downarrow = chars[1]
		this.rightarrow = chars[2]
		this.leftarrow = chars[3]
		this.harrows = chars[4]
		this.varrows = chars[5]
		this.smile = chars[6]
		this.smilefill = chars[7]
		this.heart = chars[8]
		this.diamond = chars[9]
		this.club = chars[10]
		this.spade = chars[11]
		this.bullet = chars[12]
		this.malesign = chars[13]
		this.femalesign = chars[14]
		this.note = chars[15]
		this.dbnote = chars[16]
		this.sun = chars[17]
		this.pointleft = chars[18]
		this.pointright = chars[19]
		this.pointup = chars[20]
		this.pointdown = chars[21]
		this.lightshade = chars[22]
		this.medshade = chars[23]
		this.darkshade = chars[24]
		this.blockchar = chars[25]
		this.halfblockb = chars[26]
		this.halfblockt = chars[27]
		this.halfblockl = chars[28]
		this.halfblockr = chars[29]
		this.lightshadeBuff = Buffer.from(chars[22], "hex")
		this.medshadeBuff = Buffer.from(chars[23], "hex")
		this.darkshadeBuff = Buffer.from(chars[24], "hex")
		this.blockcharBuff = Buffer.from(chars[25], "hex")
		this.halfblockbBuff = Buffer.from(chars[26], "hex")
		this.halfblocktBuff = Buffer.from(chars[27], "hex")
		this.halfblocklBuff = Buffer.from(chars[28], "hex")
		this.halfblockrBuff = Buffer.from(chars[29], "hex")
		this.boxes = boxes
	}
	getBoxBuff(boxnum){
		return Buffer.from(this.boxes[boxnum], "hex")
	}
	getchars(encoding){
		if (encoding == "UTF8"){
			return utf8chars
		}
		if (encoding == "CP437"){
			return cp437chars
		}
		if (encoding == "ASCII"){
			return cp437chars
		}
		return cp437chars
	}
	getboxes(encoding){
		if (encoding == "UTF8"){
			return utf8boxes
		}
		if (encoding == "CP437"){
			return cp437boxes
		}
		if (encoding == "ASCII"){
			return asciiboxes
		}
		return asciiboxes
	}
}



export{charSet}