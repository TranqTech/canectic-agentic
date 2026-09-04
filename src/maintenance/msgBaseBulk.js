// msgBaseBulk.js - Run a mapped set of message base imports in one pass.
//
// Sits above the per-format importers rather than beside them: jamImport and
// smbImport both import msgBaseImport, so the bulk runner lives in its own
// module to keep that dependency acyclic.
//
// Imports run sequentially. Each one is already DB-heavy (dupe check, HTML
// render, threading and insert per message), so running several at once would
// contend on the same pool without finishing any sooner.

import * as alogger from '../utils/alogger.js';

// Per-format entry points, resolved lazily so a bulk run does not drag both
// parsers into memory when only one format is involved.
async function importerFor(format) {
	if (format === 'jam') {
		var jam = await import('./jamImport.js');
		return function (m, opts) {
			return jam.importJAM(m.headerPath, m.dataPath, m.indexPath || null, m.areaShortcode, opts);
		};
	}
	if (format === 'smb') {
		var smb = await import('./smbImport.js');
		return function (m, opts) {
			return smb.importSMB(m.headerPath, m.dataPath, m.indexPath || null, m.areaShortcode, opts);
		};
	}
	return null;
}

// --- Import a list of mapped message bases ---
//
//   mappings - [{ format, name, headerPath, dataPath, indexPath, areaShortcode }]
//   options  - { seal, dryRun }
//
// Returns { total, succeeded, failed, imported, duplicates, skipped, bases[] }
// where each bases[] entry carries that base's own result summary.
//
// A base that throws is recorded and the run continues. Losing the rest of a
// migration because one base is corrupt would be the worst possible failure
// mode here.

async function importMessageBases(mappings, options) {
	var opts = options || {};
	var list = (mappings || []).filter(function (m) {
		return m && m.areaShortcode && m.headerPath && m.dataPath;
	});

	var summary = {
		total: list.length,
		succeeded: 0,
		failed: 0,
		imported: 0,
		duplicates: 0,
		skipped: 0,
		sealed: 0,
		bases: [],
	};

	if (list.length === 0) {
		alogger.writeAlog(3, '[BulkImport] Nothing to import', 'yellow');
		return summary;
	}

	alogger.writeAlog(2, '[BulkImport] Starting ' + list.length + ' message base(s)', 'cyan');

	for (var i = 0; i < list.length; i++) {
		var mapping = list[i];
		var position = '(' + (i + 1) + '/' + list.length + ') ';

		var entry = {
			name: mapping.name,
			format: mapping.format,
			areaShortcode: mapping.areaShortcode,
			status: false,
			imported: 0,
			duplicates: 0,
			skipped: 0,
			total: 0,
			sealed: null,
			errors: [],
		};

		var runImport = await importerFor(mapping.format);
		if (!runImport) {
			entry.errors.push('Unknown format: ' + mapping.format);
			summary.failed++;
			summary.bases.push(entry);
			alogger.writeAlog(3, '[BulkImport] ' + position + mapping.name + ': unknown format', 'redbright');
			continue;
		}

		alogger.writeAlog(3, '[BulkImport] ' + position + mapping.name +
			' -> ' + mapping.areaShortcode, 'cyan');

		try {
			var result = await runImport(mapping, {
				seal: opts.seal !== false,
				label: 'BulkImport ' + mapping.name,
			});

			entry.status     = result.status;
			entry.imported   = result.imported;
			entry.duplicates = result.duplicates;
			entry.skipped    = result.skipped;
			entry.total      = result.total;
			entry.sealed     = result.sealed;
			entry.errors     = result.errors || [];

			if (result.status) {
				summary.succeeded++;
				summary.imported   += result.imported;
				summary.duplicates += result.duplicates;
				summary.skipped    += result.skipped;
				if (result.sealed) summary.sealed += result.sealed;
			} else {
				summary.failed++;
			}
		} catch (err) {
			entry.errors.push(err.message || String(err));
			summary.failed++;
			alogger.writeAlog(3, '[BulkImport] ' + position + mapping.name +
				' threw: ' + (err.message || err), 'redbright');
		}

		summary.bases.push(entry);
	}

	alogger.writeAlog(2, '[BulkImport] Finished: ' + summary.succeeded + ' ok, ' +
		summary.failed + ' failed, ' + summary.imported + ' message(s) imported, ' +
		summary.duplicates + ' dupe(s), ' + summary.skipped + ' skipped', 'greenbright');

	return summary;
}

export { importMessageBases };
