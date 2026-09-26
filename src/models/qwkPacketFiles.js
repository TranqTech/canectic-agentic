// src/models/qwkPacketFiles.js: the files that go into a user's personal QWK
// packet beside the messages (#75): the new-files list, the batch download
// queue, and private mail attachments, as Synchronet's pack_qwk.cpp adds them.
//
// The archive is built with `zip -j`, which stores each file under its name
// on disk, and a file area keeps a file under disk_path (NAME_1.EXT for a
// second NAME.EXT), so each file is linked into the build directory under the
// name the user should see. Names are made plain, may not be a packet's own
// member names, and never collide: a second file of a name gets a number.

import fs from 'fs';
import path from 'path';

var RESERVED = ['CONTROL.DAT', 'MESSAGES.DAT', 'HEADERS.DAT', 'VOTING.DAT', 'NETFLAGS.DAT', 'DOOR.ID', 'TOREADER.EXT'];

/** A plain file name: letters, digits, dot, dash, underscore. Pure. */
function plainName(name) {
	var n = String(name || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
	return n.slice(0, 200) || 'file';
}

class PacketFileSet {
	constructor(dir) {
		this.dir = dir;
		this.names = new Set();
		this.paths = [];
	}

	/** The name a file will have in the packet: plain, not reserved, unique. Pure given the set. */
	nameFor(wanted) {
		var base = plainName(wanted);
		var dot = base.lastIndexOf('.');
		var stem = dot > 0 ? base.slice(0, dot) : base;
		var ext = dot > 0 ? base.slice(dot) : '';
		var name = base, n = 1;
		while (this.names.has(name.toUpperCase()) || RESERVED.indexOf(name.toUpperCase()) !== -1 || /\.(NDX|MSG)$/i.test(name)) {
			name = stem + '_' + (n++) + ext;
			if (/\.(NDX|MSG)$/i.test(name)) name = name + '_';
		}
		return name;
	}

	/** Add bytes as a file. @returns the name used */
	addBytes(wanted, bytes) {
		var name = this.nameFor(wanted);
		fs.mkdirSync(this.dir, { recursive: true });
		var p = path.join(this.dir, name);
		fs.writeFileSync(p, bytes);
		this.names.add(name.toUpperCase());
		this.paths.push(p);
		return name;
	}

	/** Add a file from disk under `wanted`. @returns the name used, or null when the source is gone */
	addFile(wanted, source) {
		if (!source || !fs.existsSync(source)) return null;
		var name = this.nameFor(wanted);
		fs.mkdirSync(this.dir, { recursive: true });
		var p = path.join(this.dir, name);
		try {
			fs.symlinkSync(path.resolve(source), p);   // zip stores what the link points at
		} catch (_) {
			fs.copyFileSync(source, p);
		}
		this.names.add(name.toUpperCase());
		this.paths.push(p);
		return name;
	}

	get count() { return this.paths.length; }
}

export { plainName, PacketFileSet };
