// optionalTools.js -- the external programs Canectic runs, and what is lost
// without each one.
//
// None of these are needed to boot a board, which is exactly the problem: every
// one of them is discovered missing at the moment a sysop first tries to use
// the feature it belongs to, which is usually in front of a caller. A DOS door
// that exits instantly and a QWK download that produces an empty packet look
// like Canectic bugs and are a missing package.
//
// The list was written after noticing that `socat` appeared in no install
// instruction anywhere, despite being required by DosemuPty, which the door
// documentation calls the recommended mode for interactive DOS doors. dosemu2
// was documented, but as `sudo apt install dosemu2`, which fails on a stock
// Ubuntu because it only exists in a PPA.
//
// Declared once, here, so three things agree: the installer reports what is
// missing, INSTALL.md lists it, and a test fails if a tool is added here and
// not written down. Documentation that is only prose drifts from the code that
// needs it; that is the whole reason this file is a list rather than a
// paragraph.

/**
 * @typedef {object} OptionalTool
 * @property {string} command  what is looked for on PATH
 * @property {string} pkg      the Debian/Ubuntu package providing it
 * @property {string} enables  the feature it is for
 * @property {string} without  what happens when it is absent
 * @property {string} [ppa]    where it comes from, when not stock apt
 */

/** @type {OptionalTool[]} */
var OPTIONAL_TOOLS = [
	{
		command: 'dosemu',
		pkg: 'dosemu2',
		ppa: 'ppa:dosemu2/ppa',
		enables: 'DOS door games',
		without: 'doors with a Dosemu or DosemuPty launch type fail when a caller runs them'
	},
	{
		command: 'socat',
		pkg: 'socat',
		enables: 'DOS doors that talk to the caller over a serial port',
		without: 'the DosemuPty launch type cannot allocate a port pair, which is the ' +
			'recommended mode for interactive DOS doors'
	},
	{
		command: 'zip',
		pkg: 'zip',
		enables: 'outbound QWK and REP packets',
		without: 'a user asking for a QWK packet gets nothing'
	},
	{
		command: 'unzip',
		pkg: 'unzip',
		enables: 'reading inbound archives',
		without: 'nodelist, echolist and filebone imports cannot open a ZIP, and ' +
			'FILE_ID.DIZ is never extracted from an upload'
	},
	{
		command: 'gpg',
		pkg: 'gnupg',
		enables: 'checking the signature on a release',
		without: 'a release is verified by checksum only, and its signature is not checked'
	},
	{
		command: 'pg_dump',
		pkg: 'postgresql-client',
		enables: 'the database backup an update takes before migrating',
		without: 'an update cannot back the database up, which is the thing that makes a ' +
			'failed migration recoverable'
	},
	{
		command: 'sz',
		pkg: 'lrzsz',
		enables: 'the legacy ZMODEM fallback',
		without: 'nothing, unless a terminal needs the fallback: the native engines are ' +
			'used by default'
	}
];

/**
 * Which of them are not here.
 *
 * `exists` is injected rather than looked up directly so this is testable
 * without depending on what happens to be installed on the machine running the
 * tests, which is the sort of thing that passes on a dev box and fails in a
 * container.
 *
 * @param {(command:string)=>boolean} exists
 * @returns {OptionalTool[]}
 */
function missingTools(exists) {
	return OPTIONAL_TOOLS.filter(function (t) { return !exists(t.command); });
}

/** The apt line that would install one, PPA included when it needs one. */
function installHint(tool) {
	if (!tool) return '';
	var apt = 'sudo apt install ' + tool.pkg;
	if (!tool.ppa) return apt;
	return 'sudo add-apt-repository ' + tool.ppa + ' && sudo apt update && ' + apt;
}

/** One line per missing tool, for the installer to print. */
function describeMissing(tools) {
	return (tools || []).map(function (t) {
		return t.command + ' is not installed, so ' + t.enables + ' will not work: ' +
			t.without + '. Install it with: ' + installHint(t);
	});
}

export {
	OPTIONAL_TOOLS,
	missingTools,
	installHint,
	describeMissing
};
