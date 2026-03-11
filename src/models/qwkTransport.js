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

		alogger.writeAlog(5,
			'FTPTransport: connecting to ' + this._host + ':' + this._port +
			' as ' + user + (cd.secure ? ' (TLS)' : ' (plain)'),
			'cyan'
		);

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
			alogger.writeAlog(5,
				'FTPTransport: connected to ' + this._host + ':' + this._port +
				' — greeting: ' + (response ? response.message || response.code : 'none'),
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'FTPTransport: connection failed to ' + this._host + ':' + this._port +
				' — ' + err.message,
				'redbright'
			);
			this.client = null;
			throw err;
		}

		// Log current working directory for path debugging
		try {
			var pwd = await this.client.pwd();
			alogger.writeAlog(5,
				'FTPTransport: cwd on ' + this._host + ' is ' + pwd,
				'cyan'
			);
		} catch (_) {
			// non-fatal — some servers may not support PWD
		}
	}

	async downloadFile(remotePath, localPath) {
		if (!this.client) throw new Error('FTPTransport: not connected');
		alogger.writeAlog(5,
			'FTPTransport: downloading ' + remotePath + ' → ' + localPath +
			' from ' + this._host,
			'cyan'
		);
		try {
			await this.client.downloadTo(localPath, remotePath);
			alogger.writeAlog(5,
				'FTPTransport: download complete — ' + remotePath,
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'FTPTransport: download failed for ' + remotePath +
				' from ' + this._host + ' — ' + err.message,
				'redbright'
			);
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

		alogger.writeAlog(5,
			'FTPTransport: uploading ' + localPath + ' → ' +
			(remoteDir || '(cwd)') + remoteFile + ' to ' + this._host,
			'cyan'
		);

		if (remoteDir) {
			try {
				await this.client.cd(remoteDir);
				alogger.writeAlog(5,
					'FTPTransport: cd to ' + remoteDir + ' on ' + this._host,
					'cyan'
				);
			} catch (cdErr) {
				alogger.writeAlog(3,
					'FTPTransport: cd to ' + remoteDir + ' failed on ' +
					this._host + ' — ' + cdErr.message,
					'redbright'
				);
				throw cdErr;
			}
		}

		try {
			await this.client.uploadFrom(localPath, remoteFile);
			alogger.writeAlog(5,
				'FTPTransport: upload complete — ' + remoteFile +
				' in ' + remoteDir,
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'FTPTransport: upload failed for ' + remoteFile +
				' in ' + remoteDir + ' on ' + this._host +
				' — ' + err.message,
				'redbright'
			);
			throw err;
		}
	}

	async disconnect() {
		if (this.client) {
			alogger.writeAlog(5,
				'FTPTransport: disconnecting from ' + this._host,
				'cyan'
			);
			this.client.close();
			this.client = null;
		}
	}

	// List a remote directory — returns array of { name, type, size }.
	// type is 1 for file, 2 for directory, 0 for unknown.
	// Used for path debugging; non-fatal if it fails.
	async listDir(remotePath) {
		if (!this.client) throw new Error('FTPTransport: not connected');
		alogger.writeAlog(5,
			'FTPTransport: listing ' + remotePath + ' on ' + this._host,
			'cyan'
		);
		try {
			var list = await this.client.list(remotePath);
			for (var entry of list) {
				var kind = entry.type === 2 ? 'DIR' : entry.type === 1 ? 'FILE' : '???';
				alogger.writeAlog(5,
					'FTPTransport:   ' + kind + '  ' + entry.name +
					(entry.size ? '  (' + entry.size + ' bytes)' : ''),
					'cyan'
				);
			}
			return list.map(e => ({ name: e.name, type: e.type, size: e.size }));
		} catch (err) {
			alogger.writeAlog(3,
				'FTPTransport: listDir failed for ' + remotePath +
				' on ' + this._host + ' — ' + err.message,
				'redbright'
			);
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

		alogger.writeAlog(5,
			'SFTPTransport: connecting to ' + this._host + ':' + this._port +
			' as ' + user +
			(cd.private_key ? ' (key auth)' : ' (password auth)'),
			'cyan'
		);

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
			alogger.writeAlog(5,
				'SFTPTransport: connected to ' + this._host + ':' + this._port,
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'SFTPTransport: connection failed to ' + this._host + ':' + this._port +
				' — ' + err.message,
				'redbright'
			);
			this.client = null;
			throw err;
		}

		// Log current working directory for path debugging
		try {
			var cwd = await this.client.cwd();
			alogger.writeAlog(5,
				'SFTPTransport: cwd on ' + this._host + ' is ' + cwd,
				'cyan'
			);
		} catch (_) {
			// non-fatal
		}
	}

	async downloadFile(remotePath, localPath) {
		if (!this.client) throw new Error('SFTPTransport: not connected');
		alogger.writeAlog(5,
			'SFTPTransport: downloading ' + remotePath + ' → ' + localPath +
			' from ' + this._host,
			'cyan'
		);
		try {
			await this.client.fastGet(remotePath, localPath);
			alogger.writeAlog(5,
				'SFTPTransport: download complete — ' + remotePath,
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'SFTPTransport: download failed for ' + remotePath +
				' from ' + this._host + ' — ' + err.message,
				'redbright'
			);
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

		alogger.writeAlog(5,
			'SFTPTransport: uploading ' + localPath + ' → ' +
			(remoteDir || '(cwd)') + remoteFile + ' to ' + this._host,
			'cyan'
		);

		try {
			await this.client.fastPut(localPath, fullPath);
			alogger.writeAlog(5,
				'SFTPTransport: upload complete — ' + remoteFile +
				' in ' + (remoteDir || '(cwd)'),
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'SFTPTransport: upload failed for ' + remoteFile +
				' in ' + (remoteDir || '(cwd)') + ' on ' + this._host +
				' — ' + err.message,
				'redbright'
			);
			throw err;
		}
	}

	async listDir(remotePath) {
		if (!this.client) throw new Error('SFTPTransport: not connected');
		alogger.writeAlog(5,
			'SFTPTransport: listing ' + remotePath + ' on ' + this._host,
			'cyan'
		);
		try {
			var list = await this.client.list(remotePath);
			for (var entry of list) {
				var kind = entry.type === 'd' ? 'DIR' : entry.type === '-' ? 'FILE' : '???';
				alogger.writeAlog(5,
					'SFTPTransport:   ' + kind + '  ' + entry.name +
					(entry.size ? '  (' + entry.size + ' bytes)' : ''),
					'cyan'
				);
			}
			// Normalise type to numeric (1=file, 2=dir) for consistency with FTP
			return list.map(e => ({
				name: e.name,
				type: e.type === 'd' ? 2 : e.type === '-' ? 1 : 0,
				size: e.size
			}));
		} catch (err) {
			alogger.writeAlog(3,
				'SFTPTransport: listDir failed for ' + remotePath +
				' on ' + this._host + ' — ' + err.message,
				'redbright'
			);
			throw err;
		}
	}

	async disconnect() {
		if (this.client) {
			alogger.writeAlog(5,
				'SFTPTransport: disconnecting from ' + this._host,
				'cyan'
			);
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
		alogger.writeAlog(5,
			'DirectoryTransport: connected (local filesystem mode, label=' +
			this._label + ')',
			'greenbright'
		);
	}

	async downloadFile(remotePath, localPath) {
		alogger.writeAlog(5,
			'DirectoryTransport: copying ' + remotePath + ' → ' + localPath,
			'cyan'
		);
		try {
			fs.copyFileSync(remotePath, localPath);
			alogger.writeAlog(5,
				'DirectoryTransport: copy complete — ' + remotePath,
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'DirectoryTransport: copy failed for ' + remotePath +
				' — ' + err.message,
				'redbright'
			);
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

		alogger.writeAlog(5,
			'DirectoryTransport: copying ' + localPath + ' → ' + remotePath,
			'cyan'
		);
		try {
			fs.copyFileSync(localPath, remotePath);
			alogger.writeAlog(5,
				'DirectoryTransport: copy complete — ' + remotePath,
				'greenbright'
			);
		} catch (err) {
			alogger.writeAlog(3,
				'DirectoryTransport: copy failed to ' + remotePath +
				' — ' + err.message,
				'redbright'
			);
			throw err;
		}
	}

	async listDir(remotePath) {
		alogger.writeAlog(5,
			'DirectoryTransport: listing ' + remotePath,
			'cyan'
		);
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
				alogger.writeAlog(5,
					'DirectoryTransport:   ' + kind + '  ' + entry.name + size,
					'cyan'
				);
			}
			return entries.map(e => ({
				name: e.name,
				type: e.isDirectory() ? 2 : e.isFile() ? 1 : 0,
				size: e.isFile() ? (fs.statSync(remotePath + '/' + e.name).size || 0) : 0
			}));
		} catch (err) {
			alogger.writeAlog(3,
				'DirectoryTransport: listDir failed for ' + remotePath +
				' — ' + err.message,
				'redbright'
			);
			throw err;
		}
	}

	async disconnect() {
		alogger.writeAlog(5,
			'DirectoryTransport: disconnected (no-op)',
			'cyan'
		);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeTransport(cd) {
	var t = (cd.transport || 'ftp').toLowerCase();
	alogger.writeAlog(5, 'makeTransport: creating ' + t + ' transport', 'cyan');
	if (t === 'ftp')       return new FTPTransport();
	if (t === 'sftp')      return new SFTPTransport();
	if (t === 'directory') return new DirectoryTransport();
	throw new Error('Unknown QWK transport: ' + t);
}

export {
	QWKTransport,
	FTPTransport,
	SFTPTransport,
	DirectoryTransport,
	makeTransport
};
