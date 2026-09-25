// Message area shortcodes become table names: mb_<shortcode>_msgs and
// mb_<shortcode>_threads, interpolated into SQL unquoted. So a shortcode is
// only valid if it makes a legal bare Postgres identifier.
//
// Two ways to get it wrong, both of which used to reach the database:
//  - any character outside [A-Za-z0-9_] (a '-' is the usual one) makes the
//    CREATE TABLE a syntax error, and the area was rolled back with nothing
//    shown to the sysop.
//  - Postgres truncates identifiers to 63 bytes without failing, and the two
//    tables differ only at the END of the name, so past the limit both names
//    truncate to the same identifier.  "mb_" + "_threads" is 11 characters,
//    which leaves 52.

var AREA_SHORTCODE_MAX = 52;

var AREA_SHORTCODE_RE = /^[A-Za-z0-9_]+$/;

// Null when the shortcode is usable, otherwise a message for the sysop.
function areaShortcodeProblem(shortcode) {
	var shorty = String(shortcode || '').trim();
	if (shorty.length === 0) {
		return 'Must have a shortcode!';
	}
	if (!AREA_SHORTCODE_RE.test(shorty)) {
		return 'Shortcode "' + shorty + '" may only contain letters, digits and underscores ' +
			'(it names the area\'s database tables); try "' + shortcodeFromAreatag(shorty) + '".';
	}
	if (shorty.length > AREA_SHORTCODE_MAX) {
		return 'Shortcode "' + shorty + '" is ' + shorty.length + ' characters; the limit is ' +
			AREA_SHORTCODE_MAX + '.';
	}
	return null;
}

// The shortcode an areatag becomes when the sysop does not choose one.
// Lossy by design: FSX.GEN and FSX-GEN both become FSX_GEN, so callers that
// create areas in bulk must still check for collisions.
function shortcodeFromAreatag(areatag) {
	return String(areatag || '').toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, AREA_SHORTCODE_MAX);
}

export { AREA_SHORTCODE_MAX, areaShortcodeProblem, shortcodeFromAreatag };
