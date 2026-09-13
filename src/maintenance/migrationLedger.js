// migrationLedger.js -- ordered, recorded, one-shot data migrations.
//
// The declarative schema in db/schema is good at what it does: it is idempotent,
// version free, and converges on the right shape no matter what state it finds.
// That is exactly why it cannot express a one-shot. "Renumber every QWK
// conference once" is not a shape, it is an event, and asking a converging
// system to perform an event has produced four different answers to the same
// question in this codebase:
//
//   migrateMenuLayout      sniffs the schema (is display_entries still boolean?)
//   fixLegacyMsgIds        a marker row in settings
//   qwkConfRenumber        nothing at all; run by hand, no guard
//   allow_netmail_relay    unanswerable, because configStore seeds defaults so a
//                          deliberate false cannot be told from an untouched key
//
// Each was reasonable locally. Together they are a missing mechanism.
//
// This is that mechanism: a directory of ordered migrations, and a table
// recording what has run. Once a migration is recorded it is never considered
// again.
//
// One row per attempt, not one per migration, and deliberately no UNIQUE on
// migration_id. A migration that failed and was then fixed and re-run leaves
// both rows, which is the history worth having. Same reasoning as
// mailer_sessions and netmail_relay_log: the attempt that went wrong is the one
// you want to read about later.
//
// Migrations run from src/tools/dbmigrations.js, which is a CLI invoked during
// an update. They do NOT run at gateway startup. A migration that fails fails an
// update, and cannot stop the BBS from booting.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as postgres from '../middleware/db/postgres.js';

// An outcome is a claim about why this migration will not be considered again.
var OUTCOME_APPLIED     = 'applied';      // it ran and succeeded
var OUTCOME_SKIPPED     = 'skipped';      // isNeeded() said this system does not need it
var OUTCOME_PREINSTALLED = 'preinstalled'; // fresh database, born current, never ran
var OUTCOME_FAILED      = 'failed';       // it ran and threw; stays pending

var TERMINAL_OUTCOMES = [OUTCOME_APPLIED, OUTCOME_SKIPPED, OUTCOME_PREINSTALLED];

var PHASE_PRE  = 'pre';
var PHASE_POST = 'post';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

// A migration file is NNNN-slug.js. The number orders it; the slug is for
// people.
//
// Rejecting a malformed name rather than sorting it somewhere arbitrary is the
// point: ordering is the whole contract of this directory, and a file that
// cannot be ordered must stop the run rather than quietly land first or last.
var ID_PATTERN = /^(\d{4})-([a-z0-9][a-z0-9-]*)$/;

function parseMigrationId(filename) {
	var base = String(filename || '').replace(/\.js$/, '');
	var m = ID_PATTERN.exec(base);
	if (!m) return null;
	return { id: base, sequence: parseInt(m[1], 10), slug: m[2] };
}

// Order strictly by the numeric prefix. Lexicographic ordering of the whole id
// happens to agree while the prefixes are the same width, and would stop
// agreeing at 10000, so compare the number.
function sortMigrations(migrations) {
	return (migrations || []).slice().sort(function (a, b) {
		if (a.sequence !== b.sequence) return a.sequence - b.sequence;
		return String(a.id).localeCompare(String(b.id));
	});
}

// What this phase should consider: declared, in order, in this phase, with
// anything already settled removed.
//
// `settled` is the set of migration ids that reached a terminal outcome. A
// failed migration is deliberately not settled, so a later run picks it up
// again.
function pendingFor(migrations, settled, phase) {
	var done = settled instanceof Set ? settled : new Set(settled || []);
	return sortMigrations(migrations).filter(function (m) {
		if (m.phase !== phase) return false;
		return !done.has(m.id);
	});
}

// Is this module shaped like a migration?
//
// Checked before anything runs, for every file, so a typo in one migration is
// reported up front rather than after three others have already altered the
// database.
function validateMigration(mod, filename) {
	var errors = [];
	var parsed = parseMigrationId(filename);
	if (!parsed) {
		errors.push(filename + ': name must be NNNN-slug.js');
		return errors;
	}
	if (!mod || typeof mod !== 'object') {
		errors.push(parsed.id + ': module did not export anything');
		return errors;
	}
	if (mod.id && mod.id !== parsed.id) {
		errors.push(parsed.id + ': exported id "' + mod.id + '" does not match its filename');
	}
	if (!mod.description || typeof mod.description !== 'string') {
		errors.push(parsed.id + ': needs a description, which is what a sysop reads');
	}
	if (mod.phase !== undefined && mod.phase !== PHASE_PRE && mod.phase !== PHASE_POST) {
		errors.push(parsed.id + ': phase must be "pre" or "post", got "' + mod.phase + '"');
	}
	var automatic = mod.automatic !== false;
	if (automatic && typeof mod.run !== 'function') {
		errors.push(parsed.id + ': an automatic migration needs a run() function');
	}
	if (!automatic && !mod.instructions) {
		errors.push(parsed.id + ': a manual migration needs instructions telling the sysop what to run');
	}
	if (mod.isNeeded !== undefined && typeof mod.isNeeded !== 'function') {
		errors.push(parsed.id + ': isNeeded must be a function when present');
	}
	return errors;
}

// Normalise a loaded module into the shape the runner uses, so defaults live in
// one place rather than at each use.
function normaliseMigration(mod, filename) {
	var parsed = parseMigrationId(filename);
	return {
		id:           parsed.id,
		sequence:     parsed.sequence,
		slug:         parsed.slug,
		file:         filename,
		description:  mod.description,
		phase:        mod.phase || PHASE_POST,
		automatic:    mod.automatic !== false,
		instructions: mod.instructions || null,
		isNeeded:     mod.isNeeded || null,
		run:          mod.run || null
	};
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadMigrations(dir) {
	var files;
	try {
		files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); });
	} catch (_) {
		// No directory is not an error. A checkout with no migrations yet has
		// nothing to do, which is the same answer as a checkout with none
		// pending.
		return { migrations: [], errors: [] };
	}

	var migrations = [];
	var errors = [];

	for (var file of files.sort()) {
		var mod;
		try {
			mod = await import(pathToFileURL(path.join(dir, file)).href);
		} catch (err) {
			errors.push(file + ': could not be loaded: ' + (err && err.message ? err.message : err));
			continue;
		}
		var fileErrors = validateMigration(mod, file);
		if (fileErrors.length > 0) {
			errors = errors.concat(fileErrors);
			continue;
		}
		migrations.push(normaliseMigration(mod, file));
	}

	var seen = new Set();
	for (var m of migrations) {
		if (seen.has(m.sequence)) {
			errors.push('duplicate sequence number ' + m.sequence + ' at ' + m.file +
				'. Two branches probably added a migration with the same number; renumber one.');
		}
		seen.add(m.sequence);
	}

	return { migrations: sortMigrations(migrations), errors: errors };
}

// ---------------------------------------------------------------------------
// The ledger itself
// ---------------------------------------------------------------------------

// Migration ids that have reached a terminal outcome and will not be considered
// again. A failed row is not terminal.
async function settledIds() {
	try {
		var rows = await postgres.query(
			'SELECT DISTINCT migration_id FROM schema_migrations WHERE outcome = ANY($1)',
			[TERMINAL_OUTCOMES]
		);
		return new Set((rows || []).map(function (r) { return r.migration_id; }));
	} catch (_) {
		// The table not existing yet means nothing has been recorded, which is
		// the same answer.
		return new Set();
	}
}

// Migration ids this database actually APPLIED.
//
// Deliberately narrower than settledIds(). The update move rule asks whether a
// target release understands the state this database is in, and only `applied`
// means a migration transformed data here. `skipped` means the migration
// decided this system did not need it, and `preinstalled` means the database
// was born current and never needed it either; in neither case is there a
// transformation for a target to understand, so neither should block a move.
//
// Getting that wrong in the conservative direction would refuse upgrades to
// every fresh install, since a fresh database records every migration as
// preinstalled.
async function appliedIds() {
	try {
		var rows = await postgres.query(
			'SELECT DISTINCT migration_id FROM schema_migrations WHERE outcome = $1',
			[OUTCOME_APPLIED]
		);
		return (rows || []).map(function (r) { return r.migration_id; }).sort();
	} catch (_) {
		// No table means nothing has been recorded, which is the same answer.
		return [];
	}
}

async function record(migration, outcome, opts) {
	var o = opts || {};
	var res = await postgres.insertObject({
		migration_id:     migration.id,
		description:      migration.description,
		phase:            migration.phase,
		outcome:          outcome,
		applied_at:       new Date(),
		duration_ms:      o.durationMs === undefined ? null : o.durationMs,
		canectic_version: o.version || null,
		note:             o.note || null
	}, 'schema_migrations');

	// insertObject reports a failed write in its return value rather than
	// throwing. Ignoring it would make a ledger that silently stopped recording
	// indistinguishable from one with nothing to record, and a ledger nobody can
	// trust is worse than no ledger: the next run would re-apply everything.
	if (!res || res.status !== true) {
		throw new Error('could not record migration ' + migration.id + ' in the ledger: ' +
			((res && res.errormessages) || []).join('; '));
	}
	return true;
}

/**
 * Mark every declared migration as never-needed on a fresh database.
 *
 * A database created by this release is born current: there is no legacy data
 * for a migration to repair. Running them would at best waste time and at worst
 * corrupt a correct schema.
 *
 * Only called when dbmigrations has established the database had no Canectic
 * tables before this run. Getting that test wrong in the other direction is the
 * dangerous one: marking an existing install as preinstalled would skip every
 * repair it actually needed, silently.
 */
async function recordFreshInstall(migrations, opts) {
	var o = opts || {};
	var recorded = 0;
	for (var m of sortMigrations(migrations)) {
		if (o.dryRun) { recorded++; continue; }
		await record(m, OUTCOME_PREINSTALLED, {
			version: o.version,
			note: 'fresh database, born current'
		});
		recorded++;
	}
	return recorded;
}

/**
 * Run one phase.
 *
 * Stops at the first failure rather than carrying on. A later migration may
 * depend on an earlier one having run, so continuing past a failure is how a
 * half-migrated database happens.
 *
 * @returns {object} { applied, skipped, manual, failed, stopped, results }
 */
async function runPhase(migrations, phase, opts) {
	var o = opts || {};
	var settled = await settledIds();
	var pending = pendingFor(migrations, settled, phase);

	var out = { applied: 0, skipped: 0, manual: [], failed: null, stopped: false, results: [] };

	for (var m of pending) {
		// A manual migration is never run here. It is reported so the sysop is
		// told, and recorded by whichever tool actually performs it. This is the
		// same distinction the release metadata draws with steps[].automatic.
		if (!m.automatic) {
			var needed = true;
			if (m.isNeeded) {
				try { needed = await m.isNeeded({ postgres: postgres }); }
				catch (_) { needed = true; }
			}
			if (needed) {
				out.manual.push(m);
				out.results.push({ id: m.id, outcome: 'manual' });
			} else if (!o.dryRun) {
				await record(m, OUTCOME_SKIPPED, { version: o.version, note: 'not needed on this system' });
				out.skipped++;
				out.results.push({ id: m.id, outcome: OUTCOME_SKIPPED });
			}
			continue;
		}

		if (m.isNeeded) {
			var required;
			try {
				required = await m.isNeeded({ postgres: postgres });
			} catch (err) {
				out.failed = { id: m.id, error: 'isNeeded() threw: ' + (err && err.message ? err.message : err) };
				out.stopped = true;
				return out;
			}
			if (!required) {
				if (!o.dryRun) {
					await record(m, OUTCOME_SKIPPED, { version: o.version, note: 'not needed on this system' });
				}
				out.skipped++;
				out.results.push({ id: m.id, outcome: OUTCOME_SKIPPED });
				continue;
			}
		}

		if (o.dryRun) {
			out.results.push({ id: m.id, outcome: 'would-apply' });
			out.applied++;
			continue;
		}

		var started = Date.now();
		try {
			await m.run({ postgres: postgres, log: o.log || function () {} });
		} catch (err) {
			var msg = err && err.message ? err.message : String(err);
			try {
				await record(m, OUTCOME_FAILED, {
					version: o.version, durationMs: Date.now() - started, note: msg
				});
			} catch (_) {
				// Recording the failure failed too. The thrown error below is
				// what matters; losing the row is not worth masking it.
			}
			out.failed = { id: m.id, error: msg };
			out.stopped = true;
			return out;
		}

		await record(m, OUTCOME_APPLIED, { version: o.version, durationMs: Date.now() - started });
		out.applied++;
		out.results.push({ id: m.id, outcome: OUTCOME_APPLIED });
	}

	return out;
}

/**
 * Record that a manual migration has been performed.
 *
 * Called by the tool that actually does the work, for example
 * maintenance.js --fix-msgids, replacing the one-off marker row each such tool
 * would otherwise invent for itself.
 */
async function recordManualCompletion(migrationId, opts) {
	var o = opts || {};
	return await record(
		{ id: migrationId, description: o.description || null, phase: o.phase || PHASE_POST },
		OUTCOME_APPLIED,
		{ version: o.version, note: o.note || 'completed manually' }
	);
}

/** Has this migration reached a terminal outcome? */
async function isSettled(migrationId) {
	var settled = await settledIds();
	return settled.has(migrationId);
}

export {
	PHASE_PRE,
	PHASE_POST,
	OUTCOME_APPLIED,
	OUTCOME_SKIPPED,
	OUTCOME_PREINSTALLED,
	OUTCOME_FAILED,
	TERMINAL_OUTCOMES,
	parseMigrationId,
	sortMigrations,
	pendingFor,
	validateMigration,
	normaliseMigration,
	loadMigrations,
	settledIds,
	appliedIds,
	recordFreshInstall,
	runPhase,
	recordManualCompletion,
	isSettled
};
