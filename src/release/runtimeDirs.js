// runtimeDirs.js -- the directories an installation needs that no release
// ships.
//
// A release artifact contains code and shipped data. It does not contain the
// FTN spool, the log directory, the upload staging area or the art tree,
// because those are empty and an empty directory is not a file. Something has
// to create them, and until now that something was a block of mkdir calls in
// install.sh that an update never ran.
//
// That gap is real rather than theoretical: a release that starts writing to a
// directory the previous one did not have works perfectly on a fresh install
// and fails on every upgraded one, at the moment the feature is first used
// rather than at update time. So this list is applied on BOTH paths, and it is
// idempotent by construction.
//
// Pure: a list and the rules for expanding it. Nothing here touches a disk.

// Art lives under a format directory and then a purpose directory. Both axes
// are enumerated rather than created on demand so a sysop dropping a file in
// has somewhere obvious to drop it.
var ART_FORMATS = ['ans', 'asc', 'utf8', 'sixel', 'rip', 'webart'];
var ART_TYPES = [
	'screens', 'headers', 'logon', 'login', 'logoff', 'goodbye',
	'register', 'welcome', 'misc', 'random'
];

// Everything else, spelled out. A directory that is merely implied by a config
// default is one nobody can find.
var FIXED_DIRS = [
	'logs',
	'logs/production',
	'ftn',
	'ftn/in',
	'ftn/out',
	'ftn/tossed',
	'ftn/bad',
	'ftn/tmp',
	'ftn/filebox',
	'ftn/freq',
	'qwk',
	'files',
	'files/staging',
	'xtrn',
	'tmp',
	'export'
];

/** Every directory an installation should have, sorted, without duplicates. */
function runtimeDirs() {
	var out = FIXED_DIRS.slice();
	for (var fmt of ART_FORMATS) {
		out.push('txtfiles/' + fmt);
		for (var type of ART_TYPES) out.push('txtfiles/' + fmt + '/' + type);
	}
	return Array.from(new Set(out)).sort();
}

export {
	ART_FORMATS,
	ART_TYPES,
	FIXED_DIRS,
	runtimeDirs
};
