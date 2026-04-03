// webArt.js -- Web art file resolver.
//
// Scans txtfiles/webart/{arttype}/ for image files and picks one at random.
// Supports seasonal overrides: if a season is active, checks the seasonal
// subdirectory first before falling back to the default pool.
//
// Returns a path relative to the textdir (for serving via Express static)
// or null if no files found.

import * as fs from 'fs';
import * as path from 'path';
import appConfig from '../config/appConfig.js';
import { getCurrentSeasonSubdir } from '../models/seasonalArt.js';

var WEB_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

// Get a random web art image path for the given art type.
// Returns the path relative to textdir (e.g. "webart/welcome/splash.png")
// or null if no images found.
//
// Resolution order:
// 1. If a season is active: txtfiles/webart/{arttype}/{season}/
// 2. Fall back: txtfiles/webart/{arttype}/
async function getRandomWebArt(artType) {
	var textdir = appConfig.get('textdir', 'txtfiles');
	var seasonSubdir = await getCurrentSeasonSubdir();

	// Try seasonal directory first
	if (seasonSubdir) {
		var seasonalPath = path.join(textdir, 'webart', artType, seasonSubdir);
		var seasonalFile = _pickRandomImage(seasonalPath);
		if (seasonalFile) {
			return path.join('webart', artType, seasonSubdir, seasonalFile);
		}
	}

	// Fall back to default directory
	var defaultPath = path.join(textdir, 'webart', artType);
	var defaultFile = _pickRandomImage(defaultPath);
	if (defaultFile) {
		return path.join('webart', artType, defaultFile);
	}

	return null;
}

// List all web art images in a directory (non-recursive).
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

export { getRandomWebArt, WEB_IMAGE_EXTENSIONS };
