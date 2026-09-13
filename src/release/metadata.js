// metadata.js -- what a release says about itself, in a form a machine reads.
//
// Principle 2 of UPDATE_SYSTEM_DESIGN: prose in a changelog is for humans and
// cannot be executed. The v0.9.6 changelog carries eight upgrade actions and
// update.sh runs two; the other six are the sysop's job to read, match against
// their install, and perform, and several are silent when missed. `steps` and
// `notices` are those, declared.
//
// The distinction between the two is what a sysop can do about it. A step has
// something to run and a condition saying whether this install needs it. A
// notice has nothing to run: it is a behaviour that changed underneath them,
// which is the kind that hurts most when missed because nothing fails.
//
// Validation is a list of problems rather than a throw. A release is cut in one
// pass and a maintainer wants every complaint at once, not the first one.

import {
	parseVersion, channelOf, baseStable, formatVersion, isDevelopment
} from '../utils/version.js';

var METADATA_VERSION = 1;

// The codenames, which the phase letters were chosen to line up with.
var CODENAME_ALPHA = 'Handshake';
var CODENAME_BETA  = 'Carrier';
var CODENAME_FINAL = 'First Call';

var NOTICE_LEVELS = ['info', 'warning', 'critical'];

var MIGRATION_ID_PATTERN = /^\d{4}-[a-z0-9][a-z0-9-]*$/;
var SHA256_PATTERN = /^[0-9a-f]{64}$/;
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function codenameFor(version) {
	var p = parseVersion(version);
	if (!p) return null;
	if (p.phase === 'a') return CODENAME_ALPHA;
	if (p.phase === 'b') return CODENAME_BETA;
	return CODENAME_FINAL;
}

/** canectic-0.9.6a.tar.gz, or canectic-0.9.6a.20260913.delta.tar.gz */
function artifactName(version, opts) {
	var v = formatVersion(version);
	if (!v) return null;
	return 'canectic-' + v + ((opts && opts.delta) ? '.delta' : '') + '.tar.gz';
}

function metadataName(version) {
	var v = formatVersion(version);
	return v ? 'canectic-' + v + '.json' : null;
}

/** The standalone copy of the manifest, so the next delta can find its base
 *  without unpacking a tarball. */
function manifestName(version) {
	var v = formatVersion(version);
	return v ? 'canectic-' + v + '.manifest.json' : null;
}

function pad(n, width) {
	var s = String(n);
	while (s.length < width) s = '0' + s;
	return s;
}

/** The 8 digit stamp a development build carries. Local date, not UTC: the
 *  build date a maintainer means is the one on their wall. */
function buildStamp(date) {
	var d = date || new Date();
	return String(d.getFullYear()) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
}

/**
 * The version a development build cut today from stable `base` should carry.
 *
 * The base is the LAST STABLE RELEASED, never the next one, so cutting a stable
 * re-bases every development build that follows it without anything having to
 * be bumped.
 */
function developmentVersionFor(base, date, counter) {
	var p = parseVersion(base);
	if (!p) return null;
	if (p.date !== null) return null; // a development build is not a base
	var v = formatVersion({ major: p.major, minor: p.minor, patch: p.patch, phase: p.phase });
	v += '.' + buildStamp(date);
	if (counter && counter > 1) v += '.' + counter;
	return v;
}

/**
 * Assemble release metadata, deriving everything derivable.
 *
 * channel, codename and base are all functions of the version, so they are
 * computed here rather than accepted. Three independent statements of one fact
 * is how a packaging bug gets published; validateMetadata still checks them,
 * for the case where the metadata was written by something else.
 */
function buildMetadata(opts) {
	var version = formatVersion(opts.version);
	var dev = isDevelopment(version);

	return {
		metadata_version: METADATA_VERSION,
		version: version,
		channel: channelOf(version),
		codename: codenameFor(version),
		released: opts.released || new Date().toISOString().substring(0, 10),
		artifact: opts.artifact || artifactName(version, { delta: dev }),
		sha256: opts.sha256 || null,
		delta: dev,
		base: dev ? baseStable(version) : null,
		base_artifact: dev ? artifactName(baseStable(version), { delta: false }) : null,
		min_upgrade_from: opts.min_upgrade_from || null,
		node_min: opts.node_min || null,
		migrations: (opts.migrations || []).slice(),
		steps: normaliseSteps(opts.steps),
		notices: normaliseNotices(opts.notices),
		files: opts.files || null,
		bytes: opts.bytes || null,
		full_files: opts.full_files || null,
		full_bytes: opts.full_bytes || null,
		notes: opts.notes || null
	};
}

function normaliseSteps(steps) {
	return (steps || []).map(function (s) {
		return {
			id: s.id,
			description: s.description,
			automatic: s.automatic === true,
			applies_when: s.applies_when || null,
			command: s.command || null
		};
	});
}

function normaliseNotices(notices) {
	return (notices || []).map(function (n) {
		return { level: n.level || 'info', text: n.text };
	});
}

/**
 * Everything wrong with a piece of release metadata.
 *
 * The three-way agreement check is the one worth having: the version string,
 * the `base` field and (at build time) the tag the artifact was made from all
 * state the delta base independently. Any disagreement is a packaging bug, and
 * catching it here costs a warning instead of a sysop who cannot update.
 *
 * @returns {string[]} problems, empty when the metadata is sound
 */
function validateMetadata(meta) {
	var problems = [];
	if (!meta || typeof meta !== 'object') return ['metadata is not an object'];

	var parsed = parseVersion(meta.version);
	if (!parsed) {
		problems.push('version "' + meta.version + '" is not a Canectic version');
		return problems; // everything below is derived from it
	}
	if (parsed.legacy) problems.push('version "' + meta.version + '" uses the retired form');

	var expectedChannel = channelOf(parsed);
	if (meta.channel !== expectedChannel) {
		problems.push('channel is "' + meta.channel + '" but version ' + meta.version + ' is ' + expectedChannel);
	}

	var dev = parsed.date !== null;
	var expectedBase = dev ? baseStable(parsed) : null;
	if ((meta.base || null) !== expectedBase) {
		problems.push('base is "' + meta.base + '" but version ' + meta.version + ' deltas against ' + expectedBase);
	}
	if (meta.delta !== dev) {
		problems.push('delta is ' + meta.delta + ' but ' + meta.version + ' is a ' + expectedChannel + ' release');
	}

	if (!meta.artifact) problems.push('no artifact filename');
	if (!meta.sha256 || !SHA256_PATTERN.test(String(meta.sha256))) {
		problems.push('artifact sha256 is missing or malformed');
	}
	if (!meta.released || !DATE_PATTERN.test(String(meta.released))) {
		problems.push('released date is missing or not YYYY-MM-DD');
	}
	if (meta.min_upgrade_from && !parseVersion(meta.min_upgrade_from)) {
		problems.push('min_upgrade_from "' + meta.min_upgrade_from + '" is not a version');
	}

	if (!Array.isArray(meta.migrations)) {
		problems.push('migrations is not an array');
	} else {
		for (var id of meta.migrations) {
			if (!MIGRATION_ID_PATTERN.test(String(id))) problems.push('migration id "' + id + '" is malformed');
		}
	}

	if (!Array.isArray(meta.steps)) {
		problems.push('steps is not an array');
	} else {
		var seen = new Set();
		for (var s of meta.steps) {
			if (!s || !s.id) { problems.push('a step has no id'); continue; }
			if (seen.has(s.id)) problems.push('duplicate step id "' + s.id + '"');
			seen.add(s.id);
			if (!s.description) problems.push('step "' + s.id + '" has no description');
			if (typeof s.automatic !== 'boolean') problems.push('step "' + s.id + '" does not say whether it is automatic');
			if (s.automatic === false && !s.command) {
				problems.push('step "' + s.id + '" is manual but carries no command for the sysop to run');
			}
		}
	}

	if (!Array.isArray(meta.notices)) {
		problems.push('notices is not an array');
	} else {
		for (var n of meta.notices) {
			if (!n || !n.text) { problems.push('a notice has no text'); continue; }
			if (NOTICE_LEVELS.indexOf(n.level) === -1) {
				problems.push('notice level "' + n.level + '" is not one of ' + NOTICE_LEVELS.join(', '));
			}
		}
	}

	return problems;
}

function serialiseMetadata(meta) {
	return JSON.stringify(meta, null, 2) + '\n';
}

function parseMetadata(text) {
	var parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error('release metadata is not valid JSON: ' + e.message);
	}
	var problems = validateMetadata(parsed);
	if (problems.length) throw new Error('release metadata is invalid: ' + problems.join('; '));
	return parsed;
}

/**
 * The pending declarations a maintainer accumulates during a cycle.
 *
 * Kept beside the changelog rather than parsed out of it. Parsing prose to
 * decide what to execute on someone's live board is the kind of cleverness that
 * works until a bullet is reworded.
 */
function normalisePending(pending) {
	var p = pending || {};
	return {
		steps: normaliseSteps(p.steps),
		notices: normaliseNotices(p.notices),
		min_upgrade_from: p.min_upgrade_from || null,
		node_min: p.node_min || null
	};
}

/**
 * Pending, cleared for the next cycle.
 *
 * steps and notices are per cycle and go. min_upgrade_from and node_min are
 * standing facts about what the software can upgrade from and run on, so they
 * carry forward: resetting them would leave every release after the first
 * declaring no floor at all, which is a silent loss rather than a visible one.
 */
function emptyPending(previous) {
	var p = previous || {};
	return {
		steps: [],
		notices: [],
		min_upgrade_from: p.min_upgrade_from || null,
		node_min: p.node_min || null
	};
}

export {
	METADATA_VERSION,
	CODENAME_ALPHA,
	CODENAME_BETA,
	CODENAME_FINAL,
	NOTICE_LEVELS,
	codenameFor,
	artifactName,
	metadataName,
	manifestName,
	buildStamp,
	developmentVersionFor,
	buildMetadata,
	validateMetadata,
	serialiseMetadata,
	parseMetadata,
	normaliseSteps,
	normaliseNotices,
	normalisePending,
	emptyPending
};
