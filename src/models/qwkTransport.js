// qwkTransport.js
// Transport abstraction for QWK networking.
// FTP (basic-ftp), SFTP (ssh2-sftp-client), Directory (local filesystem).
//
// Usage:
//   var transport = makeTransport(connectionData);
//   await transport.connect(connectionData);
//   await transport.downloadFile(remotePath, localPath);
//   await transport.uploadFile(localPath, remotePath);
//   await transport.disconnect();

import * as fs from 'fs';
import * as ftp from 'basic-ftp';
import * as alogger from '../utils/alogger.js';

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

class QWKTransport {
	async connect(cd) {
		throw new Error('QWKTransport.connect() must be implemented by subclass');
	}

	async downloadFile(remotePath, localPath) {
		throw new Error('QWKTransport.downloadFile() must be implemented by subclass');
	}

	async uploadFile(localPath, remotePath) {
		throw new Error('QWKTransport.uploadFile() must be implemented by subclass');
	}

	async listDir(remotePath) {
		throw new Error('QWKTransport.listDir() must be implemented by subclass');
	}

	async disconnect() {
		throw new Error('QWKTransport.disconnect() must be implemented by subclass');
	}
}

// ---------------------------------------------------------------------------
// FTP transport — uses basic-ftp npm package
// ---------------------------------------------------------------------------

class FTPTransport extends QWKTransport {
	constructor() {
		super();
		this.client = null;
		this._host  = '';
		this._port  = 21;
	}

	async connect(cd) {
		this._host = cd.host || '(no host)';
		this._port = cd.port || 21;
		var user   = cd.username || 'anonymous';

		alogger.writeClog(3,
			'FTPTransport: connecting to ' + this._host + ':' + this._port +
			' as ' + user + (cd.secure ? ' (TLS)' : ' (plain)'), 'tosser',
			'cyan'
		, false, false);

		this.client = new ftp.Client();
		this.client.ftp.verbose = false;

		var accessOpts = {
			host:     cd.host,
			port:     this._port,
			user:     user,
			password: cd.password || '',
			secure:   cd.secure || false
		};

		try {
			var response = await this.client.access(accessOpts);
			alogger.writeClog(3,
				'FTPTransport: connected to ' + this._host + ':' + this._port +
				' — greeting: ' + (response ? response.message || response.code : 'none'), 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'FTPTransport: connection failed to ' + this._host + ':' + this._port +
				' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			this.client = null;
			throw err;
		}

		// Log current working directory for path debugging
		try {
			var pwd = await this.client.pwd();
			alogger.writeClog(5,
				'FTPTransport: cwd on ' + this._host + ' is ' + pwd, 'tosser',
				'cyan'
			, false, false);
		} catch (_) {
			// non-fatal — some servers may not support PWD
		}
	}

	async downloadFile(remotePath, localPath) {
		if (!this.client) throw new Error('FTPTransport: not connected');
		alogger.writeClog(5,
			'FTPTransport: downloading ' + remotePath + ' → ' + localPath +
			' from ' + this._host, 'tosser',
			'cyan'
		, false, false);
		try {
			await this.client.downloadTo(localPath, remotePath);
			alogger.writeClog(5,
				'FTPTransport: download complete — ' + remotePath, 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'FTPTransport: download failed for ' + remotePath +
				' from ' + this._host + ' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async uploadFile(localPath, remotePath) {
		if (!this.client) throw new Error('FTPTransport: not connected');

		// Split remotePath into directory and filename, cd into the directory
		// first, then upload by filename only. Some FTP servers (Synchronet)
		// reject uploads using a full path but accept them after a CWD.
		// If no directory component, upload to cwd directly.
		var lastSlash  = remotePath.lastIndexOf('/');
		var remoteDir  = lastSlash >= 0 ? remotePath.substring(0, lastSlash + 1) : '';
		var remoteFile = lastSlash >= 0 ? remotePath.substring(lastSlash + 1) : remotePath;

		alogger.writeClog(5,
			'FTPTransport: uploading ' + localPath + ' → ' +
			(remoteDir || '(cwd)') + remoteFile + ' to ' + this._host, 'tosser',
			'cyan'
		, false, false);

		if (remoteDir) {
			try {
				await this.client.cd(remoteDir);
				alogger.writeClog(5,
					'FTPTransport: cd to ' + remoteDir + ' on ' + this._host, 'tosser',
					'cyan'
				, false, false);
			} catch (cdErr) {
				alogger.writeClog(3,
					'FTPTransport: cd to ' + remoteDir + ' failed on ' +
					this._host + ' — ' + cdErr.message, 'tosser',
					'redbright'
				, false, false);
				throw cdErr;
			}
		}

		try {
			await this.client.uploadFrom(localPath, remoteFile);
			alogger.writeClog(5,
				'FTPTransport: upload complete — ' + remoteFile +
				' in ' + remoteDir, 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'FTPTransport: upload failed for ' + remoteFile +
				' in ' + remoteDir + ' on ' + this._host +
				' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async disconnect() {
		if (this.client) {
			alogger.writeClog(5,
				'FTPTransport: disconnecting from ' + this._host, 'tosser',
				'cyan'
			, false, false);
			this.client.close();
			this.client = null;
		}
	}

	// List a remote directory — returns array of { name, type, size }.
	// type is 1 for file, 2 for directory, 0 for unknown.
	// Used for path debugging; non-fatal if it fails.
	async listDir(remotePath) {
		if (!this.client) throw new Error('FTPTransport: not connected');
		alogger.writeClog(5,
			'FTPTransport: listing ' + remotePath + ' on ' + this._host, 'tosser',
			'cyan'
		, false, false);
		try {
			var list = await this.client.list(remotePath);
			for (var entry of list) {
				var kind = entry.type === 2 ? 'DIR' : entry.type === 1 ? 'FILE' : '???';
				alogger.writeClog(5,
					'FTPTransport:   ' + kind + '  ' + entry.name +
					(entry.size ? '  (' + entry.size + ' bytes)' : ''), 'tosser',
					'cyan'
				, false, false);
			}
			return list.map(e => ({ name: e.name, type: e.type, size: e.size }));
		} catch (err) {
			alogger.writeClog(3,
				'FTPTransport: listDir failed for ' + remotePath +
				' on ' + this._host + ' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}
}

// ---------------------------------------------------------------------------
// SFTP transport — uses ssh2-sftp-client npm package
// ---------------------------------------------------------------------------

class SFTPTransport extends QWKTransport {
	constructor() {
		super();
		this.client = null;
		this._host  = '';
		this._port  = 22;
	}

	async connect(cd) {
		// Lazy import — only load ssh2-sftp-client if SFTP is actually used
		var SftpClient = (await import('ssh2-sftp-client')).default;

		this._host = cd.host || '(no host)';
		this._port = cd.port || 22;
		var user   = cd.username || '';

		alogger.writeClog(3,
			'SFTPTransport: connecting to ' + this._host + ':' + this._port +
			' as ' + user +
			(cd.private_key ? ' (key auth)' : ' (password auth)'), 'tosser',
			'cyan'
		, false, false);

		this.client = new SftpClient();

		var connectOpts = {
			host:     cd.host,
			port:     this._port,
			username: user,
		};

		// Support both password and private key authentication
		if (cd.private_key) {
			connectOpts.privateKey = cd.private_key;
			if (cd.passphrase) {
				connectOpts.passphrase = cd.passphrase;
			}
		} else {
			connectOpts.password = cd.password || '';
		}

		try {
			await this.client.connect(connectOpts);
			alogger.writeClog(3,
				'SFTPTransport: connected to ' + this._host + ':' + this._port, 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'SFTPTransport: connection failed to ' + this._host + ':' + this._port +
				' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			this.client = null;
			throw err;
		}

		// Log current working directory for path debugging
		try {
			var cwd = await this.client.cwd();
			alogger.writeClog(5,
				'SFTPTransport: cwd on ' + this._host + ' is ' + cwd, 'tosser',
				'cyan'
			, false, false);
		} catch (_) {
			// non-fatal
		}
	}

	async downloadFile(remotePath, localPath) {
		if (!this.client) throw new Error('SFTPTransport: not connected');
		alogger.writeClog(5,
			'SFTPTransport: downloading ' + remotePath + ' → ' + localPath +
			' from ' + this._host, 'tosser',
			'cyan'
		, false, false);
		try {
			await this.client.fastGet(remotePath, localPath);
			alogger.writeClog(5,
				'SFTPTransport: download complete — ' + remotePath, 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'SFTPTransport: download failed for ' + remotePath +
				' from ' + this._host + ' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async uploadFile(localPath, remotePath) {
		if (!this.client) throw new Error('SFTPTransport: not connected');

		// Split into directory and filename, same as FTP transport.
		// SFTP generally handles full paths fine, but cd first for consistency.
		var lastSlash  = remotePath.lastIndexOf('/');
		var remoteDir  = lastSlash >= 0 ? remotePath.substring(0, lastSlash + 1) : '';
		var remoteFile = lastSlash >= 0 ? remotePath.substring(lastSlash + 1) : remotePath;
		var fullPath   = remoteDir ? remoteDir + remoteFile : remoteFile;

		alogger.writeClog(5,
			'SFTPTransport: uploading ' + localPath + ' → ' +
			(remoteDir || '(cwd)') + remoteFile + ' to ' + this._host, 'tosser',
			'cyan'
		, false, false);

		try {
			await this.client.fastPut(localPath, fullPath);
			alogger.writeClog(5,
				'SFTPTransport: upload complete — ' + remoteFile +
				' in ' + (remoteDir || '(cwd)'), 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'SFTPTransport: upload failed for ' + remoteFile +
				' in ' + (remoteDir || '(cwd)') + ' on ' + this._host +
				' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async listDir(remotePath) {
		if (!this.client) throw new Error('SFTPTransport: not connected');
		alogger.writeClog(5,
			'SFTPTransport: listing ' + remotePath + ' on ' + this._host, 'tosser',
			'cyan'
		, false, false);
		try {
			var list = await this.client.list(remotePath);
			for (var entry of list) {
				var kind = entry.type === 'd' ? 'DIR' : entry.type === '-' ? 'FILE' : '???';
				alogger.writeClog(5,
					'SFTPTransport:   ' + kind + '  ' + entry.name +
					(entry.size ? '  (' + entry.size + ' bytes)' : ''), 'tosser',
					'cyan'
				, false, false);
			}
			// Normalise type to numeric (1=file, 2=dir) for consistency with FTP
			return list.map(e => ({
				name: e.name,
				type: e.type === 'd' ? 2 : e.type === '-' ? 1 : 0,
				size: e.size
			}));
		} catch (err) {
			alogger.writeClog(3,
				'SFTPTransport: listDir failed for ' + remotePath +
				' on ' + this._host + ' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async disconnect() {
		if (this.client) {
			alogger.writeClog(5,
				'SFTPTransport: disconnecting from ' + this._host, 'tosser',
				'cyan'
			, false, false);
			try {
				await this.client.end();
			} catch (_) {
				// swallow close errors
			}
			this.client = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Directory transport — local filesystem copy (same machine or shared mount)
// ---------------------------------------------------------------------------
// For directory transport, remote_inbox and remote_outbox are local filesystem
// paths where QWK/REP files are read from and written to. No network connection
// needed. Useful for hubs on the same machine or shared filesystems.
// host/port/username/password are ignored.

class DirectoryTransport extends QWKTransport {
	constructor() {
		super();
		this._label = '';
	}

	async connect(cd) {
		this._label = cd.host || cd.remote_inbox || 'directory';
		alogger.writeClog(3,
			'DirectoryTransport: connected (local filesystem mode, label=' +
			this._label + ')', 'tosser',
			'greenbright'
		, false, false);
	}

	async downloadFile(remotePath, localPath) {
		alogger.writeClog(5,
			'DirectoryTransport: copying ' + remotePath + ' → ' + localPath, 'tosser',
			'cyan'
		, false, false);
		try {
			fs.copyFileSync(remotePath, localPath);
			alogger.writeClog(5,
				'DirectoryTransport: copy complete — ' + remotePath, 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'DirectoryTransport: copy failed for ' + remotePath +
				' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async uploadFile(localPath, remotePath) {
		// For directory transport, remotePath is already a full local path.
		// Ensure the target directory exists.
		var targetDir = remotePath.substring(0, remotePath.lastIndexOf('/') + 1);
		if (targetDir) {
			fs.mkdirSync(targetDir, { recursive: true });
		}

		alogger.writeClog(5,
			'DirectoryTransport: copying ' + localPath + ' → ' + remotePath, 'tosser',
			'cyan'
		, false, false);
		try {
			fs.copyFileSync(localPath, remotePath);
			alogger.writeClog(5,
				'DirectoryTransport: copy complete — ' + remotePath, 'tosser',
				'greenbright'
			, false, false);
		} catch (err) {
			alogger.writeClog(3,
				'DirectoryTransport: copy failed to ' + remotePath +
				' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async listDir(remotePath) {
		alogger.writeClog(5,
			'DirectoryTransport: listing ' + remotePath, 'tosser',
			'cyan'
		, false, false);
		try {
			var entries = fs.readdirSync(remotePath, { withFileTypes: true });
			for (var entry of entries) {
				var kind = entry.isDirectory() ? 'DIR' : entry.isFile() ? 'FILE' : '???';
				var size = '';
				if (entry.isFile()) {
					try {
						var stat = fs.statSync(remotePath + '/' + entry.name);
						size = '  (' + stat.size + ' bytes)';
					} catch (_) {}
				}
				alogger.writeClog(5,
					'DirectoryTransport:   ' + kind + '  ' + entry.name + size, 'tosser',
					'cyan'
				, false, false);
			}
			return entries.map(e => ({
				name: e.name,
				type: e.isDirectory() ? 2 : e.isFile() ? 1 : 0,
				size: e.isFile() ? (fs.statSync(remotePath + '/' + e.name).size || 0) : 0
			}));
		} catch (err) {
			alogger.writeClog(3,
				'DirectoryTransport: listDir failed for ' + remotePath +
				' — ' + err.message, 'tosser',
				'redbright'
			, false, false);
			throw err;
		}
	}

	async disconnect() {
		alogger.writeClog(5,
			'DirectoryTransport: disconnected (no-op)', 'tosser',
			'cyan'
		, false, false);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HTTP transport — this board as a QWK node of a Canectic hub
// ---------------------------------------------------------------------------
//
// Talks to the hub's /api/v1/qnet (src/routes/api/qnet.js). `host` is the
// hub's web address (https://bbs.example.com, a port in the URL if needed;
// https is assumed when no scheme is given). `username` is OUR QWK ID as the
// hub knows us, `password` the password the hub's sysop set for us. The
// remote paths the tosser passes are ignored: the hub decides what a node
// gets.
//
// downloadFile acknowledges the packet once it is safely on disk here, which
// is when the hub advances our high-water marks. The tosser imports from that
// local copy, and processes a leftover one before pulling again, so an
// import that fails later loses nothing. If the acknowledgement itself fails
// the hub offers the same packet again and dupe checking absorbs it.

function hubBaseUrl(host) {
	var h = String(host || '').trim().replace(/\/+$/, '');
	if (!h) return '';
	return /^https?:\/\//i.test(h) ? h : 'https://' + h;
}

class HttpTransport extends QWKTransport {
	constructor(opts) {
		super();
		this._fetch = (opts && opts.fetch) || globalThis.fetch;
		this._base = '';
		this._auth = '';
		this._timeout = 60000;
	}

	_url(p) { return this._base + '/api/v1/qnet' + p; }

	async _request(method, p, body) {
		var init = { method: method, headers: { Authorization: this._auth },
			signal: AbortSignal.timeout(this._timeout) };
		if (body) {
			init.headers['Content-Type'] = 'application/octet-stream';
			init.body = body;
		}
		var res;
		try {
			res = await this._fetch(this._url(p), init);
		} catch (err) {
			// fetch wraps the socket error; surface the cause so the transfer
			// log can tell a timeout from a refused connection.
			var cause = err && err.cause ? (err.cause.code || err.cause.message) : '';
			var msg = err && err.name === 'TimeoutError' ? 'Timeout (HTTP request)' : (err.message || String(err));
			throw new Error(msg + (cause ? ' (' + cause + ')' : '') + ' reaching ' + this._base);
		}
		if (res.status === 401) throw new Error('Hub refused our login (authentication failed) at ' + this._base);
		return res;
	}

	async connect(cd) {
		this._base = hubBaseUrl(cd.host);
		if (!this._base) throw new Error('No hub address configured');
		this._auth = 'Basic ' + Buffer.from((cd.username || '') + ':' + (cd.password || '')).toString('base64');
		if (cd.timeout_seconds) this._timeout = parseInt(cd.timeout_seconds) * 1000;
		var res = await this._request('GET', '/hello');
		if (res.status === 404) throw new Error('No QWK hub at ' + this._base + ' (HTTP 404; is it a Canectic board of this release or later?)');
		if (!res.ok) throw new Error('Hub answered HTTP ' + res.status + ' at ' + this._base);
		var hello = await res.json().catch(function () { return {}; });
		alogger.writeClog(5, 'HttpTransport: connected to ' + (hello.hub || this._base) + ' as ' + (hello.node || cd.username),
			'tosser', 'greenbright', false, false);
	}

	async downloadFile(remotePath, localPath) {
		var res = await this._request('GET', '/packet');
		if (res.status === 204) {
			// Same shape the tosser already treats as "nothing waiting".
			var none = new Error('No packet waiting');
			none.code = 'ENOENT';
			throw none;
		}
		if (!res.ok) throw new Error('Hub answered HTTP ' + res.status + ' for our packet');
		var id = res.headers.get('x-qnet-packet-id');
		var buf = Buffer.from(await res.arrayBuffer());
		var tmp = localPath + '.part';
		var fd = fs.openSync(tmp, 'w');
		try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(tmp, localPath);
		if (id) {
			var ack = await this._request('POST', '/packet/' + encodeURIComponent(id) + '/ack');
			if (!ack.ok) {
				alogger.writeClog(3, 'HttpTransport: hub did not accept our acknowledgement (HTTP ' + ack.status +
					'); it will offer the same packet again', 'tosser', 'yellow', false, false);
			}
		}
	}

	async uploadFile(localPath, remotePath) {
		var res = await this._request('POST', '/rep', fs.readFileSync(localPath));
		if (res.status !== 202 && !res.ok) {
			var detail = await res.text().catch(function () { return ''; });
			throw new Error('Hub refused our REP: HTTP ' + res.status + (detail ? ' ' + detail.slice(0, 200) : ''));
		}
	}

	async listDir() { return []; }
	async disconnect() {}
}

function makeTransport(cd) {
	var t = (cd.transport || 'ftp').toLowerCase();
	alogger.writeClog(5, 'makeTransport: creating ' + t + ' transport', 'tosser', 'cyan', false, false);
	if (t === 'ftp')       return new FTPTransport();
	if (t === 'sftp')      return new SFTPTransport();
	if (t === 'directory') return new DirectoryTransport();
	if (t === 'http')      return new HttpTransport();
	throw new Error('Unknown QWK transport: ' + t);
}

export {
	QWKTransport,
	FTPTransport,
	SFTPTransport,
	DirectoryTransport,
	HttpTransport,
	hubBaseUrl,
	makeTransport
};
