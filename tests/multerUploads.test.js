// multerUploads.test.js: the multipart upload behaviour every upload route
// relies on (files, PM attachments, QWK REP, admin imports), all of which use
// multer({ dest, limits }). Nothing else in the suite sends a multipart body,
// so a multer update was otherwise unexercised until a user uploaded a file.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import multer from 'multer';

describe('multer uploads (dest + limits, as the upload routes use it)', function () {
	var server, base, dest, lastError;

	before(function (done) {
		dest = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-multer-'));
		var upload = multer({ dest: dest, limits: { fileSize: 1024 } });
		var app = express();
		app.post('/single', upload.single('upload'), function (req, res) {
			res.json({ file: req.file, body: req.body });
		});
		app.post('/fields', upload.fields([{ name: 'a', maxCount: 1 }, { name: 'b', maxCount: 1 }]), function (req, res) {
			res.json({ a: req.files.a[0].originalname, b: req.files.b[0].originalname });
		});
		app.use(function (err, req, res, next) {
			lastError = err;
			res.status(413).json({ code: err.code });
		});
		server = app.listen(0, '127.0.0.1', function () {
			base = 'http://127.0.0.1:' + server.address().port;
			done();
		});
	});

	after(function (done) {
		fs.rmSync(dest, { recursive: true, force: true });
		server.close(done);
	});

	it('stores a file under dest and passes the text fields', async function () {
		var form = new FormData();
		form.append('description', 'a test file');
		form.append('upload', new Blob(['hello world']), 'HELLO.TXT');
		var res = await fetch(base + '/single', { method: 'POST', body: form });
		assert.strictEqual(res.status, 200);
		var j = await res.json();
		assert.strictEqual(j.body.description, 'a test file');
		assert.strictEqual(j.file.originalname, 'HELLO.TXT');
		assert.strictEqual(j.file.size, 11);
		assert.strictEqual(path.dirname(j.file.path), dest);
		assert.strictEqual(fs.readFileSync(j.file.path, 'utf8'), 'hello world');
	});

	it('accepts several named fields', async function () {
		var form = new FormData();
		form.append('a', new Blob(['1']), 'A.SHD');
		form.append('b', new Blob(['2']), 'B.SDT');
		var res = await fetch(base + '/fields', { method: 'POST', body: form });
		assert.deepStrictEqual(await res.json(), { a: 'A.SHD', b: 'B.SDT' });
	});

	it('refuses a file over the size limit with LIMIT_FILE_SIZE and keeps nothing', async function () {
		var before = fs.readdirSync(dest).length;
		var form = new FormData();
		form.append('upload', new Blob([Buffer.alloc(4096, 65)]), 'BIG.ZIP');
		var res = await fetch(base + '/single', { method: 'POST', body: form });
		assert.strictEqual(res.status, 413);
		assert.strictEqual((await res.json()).code, 'LIMIT_FILE_SIZE');
		assert.ok(lastError instanceof multer.MulterError);
		// multer removes the partial file after the error is reported
		await new Promise(function (r) { setTimeout(r, 100); });
		assert.strictEqual(fs.readdirSync(dest).length, before);
	});
});
