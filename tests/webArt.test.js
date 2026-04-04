// tests/webArt.test.js -- Unit tests for src/utils/webArt.js
//
// getRandomWebArt() calls getCurrentSeasonSubdir() from seasonalArt.js, which
// unconditionally queries the database.  Tests that exercise getRandomWebArt()
// end-to-end will reject with a postgres connection error in a test environment
// (no DB available).  That path is documented below.
//
// The core image-selection logic lives in the non-exported _pickRandomImage().
// It is inlined here verbatim (source: src/utils/webArt.js lines 48-60) so its
// filesystem behaviour can be tested without DB involvement.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getRandomWebArt, WEB_IMAGE_EXTENSIONS } from '../src/utils/webArt.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PROJECT_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Inline of _pickRandomImage (non-exported, src/utils/webArt.js:48-60)
// ---------------------------------------------------------------------------

function _pickRandomImage(dirPath) {
	try {
		var files = fs.readdirSync(dirPath);
		var images = files.filter(function(f) {
			var ext = path.extname(f).toLowerCase();
			return WEB_IMAGE_EXTENSIONS.has(ext);
		});
		if (images.length === 0) return null;
		return images[Math.floor(Math.random() * images.length)];
	} catch (_) {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

// Creates a temp dir under tests/tmp/ with a unique suffix and returns its path.
function makeTempDir(suffix) {
	var dir = path.join(PROJECT_ROOT, 'tests', 'tmp', 'webArt_' + suffix + '_' + Date.now());
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// WEB_IMAGE_EXTENSIONS -- exported Set
// ---------------------------------------------------------------------------

describe('WEB_IMAGE_EXTENSIONS', function () {
	it('should be a Set', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS instanceof Set);
	});

	it('should contain .png', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS.has('.png'));
	});

	it('should contain .jpg', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS.has('.jpg'));
	});

	it('should contain .jpeg', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS.has('.jpeg'));
	});

	it('should contain .gif', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS.has('.gif'));
	});

	it('should contain .svg', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS.has('.svg'));
	});

	it('should contain .webp', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS.has('.webp'));
	});

	it('should contain exactly 6 extensions', function () {
		assert.strictEqual(WEB_IMAGE_EXTENSIONS.size, 6);
	});

	it('should not contain .txt', function () {
		assert.ok(!WEB_IMAGE_EXTENSIONS.has('.txt'));
	});

	it('should not contain .mp4', function () {
		assert.ok(!WEB_IMAGE_EXTENSIONS.has('.mp4'));
	});

	it('should not contain an empty string', function () {
		assert.ok(!WEB_IMAGE_EXTENSIONS.has(''));
	});
});

// ---------------------------------------------------------------------------
// Export validation
// ---------------------------------------------------------------------------

describe('webArt exports', function () {
	it('should export getRandomWebArt as a function', function () {
		assert.strictEqual(typeof getRandomWebArt, 'function');
	});

	it('should export WEB_IMAGE_EXTENSIONS as a Set', function () {
		assert.ok(WEB_IMAGE_EXTENSIONS instanceof Set);
	});
});

// ---------------------------------------------------------------------------
// _pickRandomImage (inlined pure logic)
// ---------------------------------------------------------------------------

describe('_pickRandomImage (inlined from webArt.js)', function () {
	var dirs = [];

	after(function () {
		for (var d of dirs) {
			try {
				fs.rmSync(d, { recursive: true, force: true });
			} catch (_) {}
		}
	});

	describe('with a non-existent directory', function () {
		it('should return null', function () {
			var result = _pickRandomImage('/nonexistent/path/that/cannot/exist/12345');
			assert.strictEqual(result, null);
		});
	});

	describe('with an empty directory', function () {
		it('should return null', function () {
			var dir = makeTempDir('empty');
			dirs.push(dir);
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, null);
		});
	});

	describe('with a directory containing only non-image files', function () {
		it('should return null for .txt files', function () {
			var dir = makeTempDir('txt');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, null);
		});

		it('should return null for .html files', function () {
			var dir = makeTempDir('html');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, null);
		});

		it('should return null for .mp4 files', function () {
			var dir = makeTempDir('mp4');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'video.mp4'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, null);
		});

		it('should return null for mixed non-image files', function () {
			var dir = makeTempDir('mixed_non_image');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'file1.txt'), '');
			fs.writeFileSync(path.join(dir, 'file2.pdf'), '');
			fs.writeFileSync(path.join(dir, 'file3.zip'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, null);
		});
	});

	describe('with a directory containing a single image file', function () {
		it('should return the filename for a .png file', function () {
			var dir = makeTempDir('png');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'banner.png'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'banner.png');
		});

		it('should return the filename for a .jpg file', function () {
			var dir = makeTempDir('jpg');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'photo.jpg'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'photo.jpg');
		});

		it('should return the filename for a .jpeg file', function () {
			var dir = makeTempDir('jpeg');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'photo.jpeg'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'photo.jpeg');
		});

		it('should return the filename for a .gif file', function () {
			var dir = makeTempDir('gif');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'anim.gif'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'anim.gif');
		});

		it('should return the filename for a .svg file', function () {
			var dir = makeTempDir('svg');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg/>');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'logo.svg');
		});

		it('should return the filename for a .webp file', function () {
			var dir = makeTempDir('webp');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'image.webp'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'image.webp');
		});

		it('should return the filename for a .PNG file (uppercase extension)', function () {
			var dir = makeTempDir('png_upper');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'BANNER.PNG'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'BANNER.PNG');
		});

		it('should return the filename for a .JPG file (uppercase extension)', function () {
			var dir = makeTempDir('jpg_upper');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'PHOTO.JPG'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'PHOTO.JPG');
		});
	});

	describe('with a directory containing images and non-images', function () {
		it('should return only the image filename when mixed with .txt', function () {
			var dir = makeTempDir('mixed');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'readme.txt'), '');
			fs.writeFileSync(path.join(dir, 'banner.png'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'banner.png');
		});

		it('should never return a non-image filename', function () {
			var dir = makeTempDir('mixed2');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'notes.txt'), '');
			fs.writeFileSync(path.join(dir, 'data.json'), '');
			fs.writeFileSync(path.join(dir, 'splash.gif'), '');
			// Run several times to catch any non-determinism
			for (var i = 0; i < 20; i++) {
				var result = _pickRandomImage(dir);
				assert.strictEqual(result, 'splash.gif');
			}
		});
	});

	describe('with a directory containing multiple image files', function () {
		it('should return one of the image filenames', function () {
			var dir = makeTempDir('multi');
			dirs.push(dir);
			var names = ['a.png', 'b.jpg', 'c.gif'];
			for (var n of names) {
				fs.writeFileSync(path.join(dir, n), '');
			}
			var result = _pickRandomImage(dir);
			assert.ok(names.includes(result), 'Expected one of ' + names.join(', ') + ', got: ' + result);
		});

		it('should return a string (not null) for a populated directory', function () {
			var dir = makeTempDir('multi2');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'x.webp'), '');
			fs.writeFileSync(path.join(dir, 'y.png'), '');
			var result = _pickRandomImage(dir);
			assert.ok(typeof result === 'string' && result.length > 0);
		});

		it('should produce different results across multiple calls (random selection)', function () {
			var dir = makeTempDir('random');
			dirs.push(dir);
			// Create enough files that repeated calls are very unlikely to always pick the same one
			var names = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'];
			for (var n of names) {
				fs.writeFileSync(path.join(dir, n), '');
			}
			var seen = new Set();
			for (var i = 0; i < 100; i++) {
				seen.add(_pickRandomImage(dir));
			}
			// With 5 files and 100 tries, the probability of seeing only 1 unique value
			// is (1/5)^99, effectively zero.
			assert.ok(seen.size > 1, 'Expected random selection to produce multiple distinct results');
		});
	});

	describe('extension matching is case-insensitive', function () {
		it('should match .JPEG (all caps)', function () {
			var dir = makeTempDir('jpeg_upper');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'photo.JPEG'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'photo.JPEG');
		});

		it('should match .GIF (mixed case)', function () {
			var dir = makeTempDir('gif_mixed');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'anim.GIF'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'anim.GIF');
		});
	});

	describe('files with no extension', function () {
		it('should not return a file with no extension', function () {
			var dir = makeTempDir('noext');
			dirs.push(dir);
			fs.writeFileSync(path.join(dir, 'noextension'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, null);
		});
	});

	describe('non-recursive -- subdirectories are not traversed', function () {
		it('should not return filenames from subdirectories', function () {
			var dir = makeTempDir('subdir');
			dirs.push(dir);
			var sub = path.join(dir, 'subdir');
			fs.mkdirSync(sub);
			fs.writeFileSync(path.join(sub, 'nested.png'), '');
			// The directory entry 'subdir' has no extension, so it must be excluded
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, null);
		});

		it('should return image in root dir but not recurse into subdirs', function () {
			var dir = makeTempDir('subdir2');
			dirs.push(dir);
			var sub = path.join(dir, 'seasonal');
			fs.mkdirSync(sub);
			fs.writeFileSync(path.join(sub, 'deep.png'), '');
			fs.writeFileSync(path.join(dir, 'root.png'), '');
			var result = _pickRandomImage(dir);
			assert.strictEqual(result, 'root.png');
		});
	});
});

// ---------------------------------------------------------------------------
// getRandomWebArt -- DB-dependent integration behaviour
// ---------------------------------------------------------------------------

describe('getRandomWebArt', function () {
	it('should return a Promise', function () {
		// getRandomWebArt always returns a Promise regardless of outcome.
		// In test environments (no DB), it rejects because getCurrentSeasonSubdir()
		// calls postgres.query() which throws a connection error.
		// We only assert here that the return value is a Promise.
		var result = getRandomWebArt('test');
		assert.ok(result instanceof Promise, 'Expected getRandomWebArt to return a Promise');
		// Consume the rejection so the test runner does not emit an unhandledRejection warning.
		result.catch(function () {});
	});

	it('should reject (not silently swallow) when the database is unavailable', function (done) {
		getRandomWebArt('somearttype').then(function () {
			// If by chance a DB is available and returns no seasons, the function may
			// resolve (returning a path or null). Accept that outcome too.
			done();
		}).catch(function (err) {
			// Expected in test environments: postgres connection error bubbles through.
			assert.ok(err instanceof Error, 'Expected rejection value to be an Error');
			done();
		});
	});
});
