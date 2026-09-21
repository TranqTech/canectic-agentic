// Stand-in for applyUpdate.js in tests/processEscape.test.js: escapes the
// process tree the same way, then records where it ended up.
import * as fs from 'fs';
import { hasEscaped, escapeProcessTree } from '../../src/maintenance/processEscape.js';

var out = process.argv[2];
if (!hasEscaped()) {
	fs.writeFileSync(out + '.first', String(process.pid));
	escapeProcessTree();
	process.exit(0);
}
// Give the first process time to exit, so our parent is whoever adopted us.
setTimeout(function () {
	console.log('copy writing to the inherited stdout');
	fs.writeFileSync(out + '.copy', JSON.stringify({ pid: process.pid, ppid: process.ppid }));
	process.exit(0);
}, 300);
