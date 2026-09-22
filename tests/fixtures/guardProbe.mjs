// A process with the updater guard installed, made to fail in one of three
// ways. Used by tests/updaterGuard.test.js.
//   node guardProbe.mjs <target> <runId> <peer|bug|rejection>
import { installUpdaterGuard } from '../../src/maintenance/updaterGuard.js';

var target = process.argv[2], runId = process.argv[3], mode = process.argv[4];
installUpdaterGuard({ target: target, runId: runId, log: function (m) { console.log(m); } });

if (mode === 'peer') {
	setTimeout(function () {
		var e = new Error('read ECONNRESET');
		e.code = 'ECONNRESET';
		throw e;
	}, 10);
	setTimeout(function () { console.log('survived'); process.exit(0); }, 200);
} else if (mode === 'bug') {
	setTimeout(function () { var x = null; x.boom(); }, 10);
	setTimeout(function () { console.log('still alive'); process.exit(4); }, 1500);
} else if (mode === 'rejection') {
	Promise.reject(new Error('nobody awaited this'));
	setTimeout(function () { console.log('still alive'); process.exit(4); }, 1500);
}
