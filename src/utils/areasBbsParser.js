// areasBbsParser.js -- Parse areas.bbs files.
//
// Standard format: one area per line, first token is the areatag (echomail tag),
// remainder is the description. Lines starting with ; or # are comments.
// Blank lines are skipped. Some variants have additional flags after the
// description -- we ignore those.
//
// Returns an array of { areatag, description }.

function parseAreasBbs(text) {
	if (!text) return [];

	var lines = text.split(/\r?\n/);
	var areas = [];

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i].trim();
		if (!line) continue;
		if (line.charAt(0) === ';' || line.charAt(0) === '#') continue;

		// First token is the areatag, rest is description
		var spaceIdx = line.indexOf(' ');
		var tabIdx = line.indexOf('\t');
		var sepIdx = -1;

		if (spaceIdx === -1 && tabIdx === -1) {
			// Areatag only, no description
			areas.push({ areatag: line, description: '' });
			continue;
		}

		if (spaceIdx === -1) sepIdx = tabIdx;
		else if (tabIdx === -1) sepIdx = spaceIdx;
		else sepIdx = Math.min(spaceIdx, tabIdx);

		var areatag = line.substring(0, sepIdx).trim();
		var description = line.substring(sepIdx).trim();

		if (!areatag) continue;

		areas.push({
			areatag: areatag,
			description: description
		});
	}

	return areas;
}

// Generate areas.bbs text from an array of { areatag, description }.
// Optionally prepend a header comment with the BBS name and date.
function generateAreasBbs(areas, headerComment) {
	var lines = [];

	if (headerComment) {
		lines.push('; ' + headerComment);
		lines.push('; Generated ' + new Date().toISOString().split('T')[0]);
		lines.push(';');
	}

	for (var i = 0; i < areas.length; i++) {
		var tag = areas[i].areatag || '';
		var desc = areas[i].description || '';
		if (!tag) continue;
		if (desc) {
			lines.push(tag + ' ' + desc);
		} else {
			lines.push(tag);
		}
	}

	return lines.join('\r\n') + '\r\n';
}

export { parseAreasBbs, generateAreasBbs };
