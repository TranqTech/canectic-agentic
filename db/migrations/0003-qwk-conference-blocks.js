// 0003-qwk-conference-blocks: give every message group a QWK conference block.
//
// QWK conference numbers used to derive from a flat id+100. They are now
// allocated in per-group blocks so areas in a group cluster together in a mail
// reader's conference list, which means every group needs a qwk_conf_start and
// every area needs a number inside its group's block.
//
// This was an upgrade step in the changelog: "after pulling this release and
// before restarting, run node src/tools/qwkConfRenumber.js once". It is a
// migration now because leaving it undone is not a cosmetic problem. A group
// with no qwk_conf_start cannot have a new area created in it at all:
// nextConfNumberInGroup throws, and the sysop sees a failed area creation
// pointing at a tool they were supposed to have run.
//
// Automatic, but only in default mode. Default preserves every conference block
// already assigned and fills only the gaps, so a reader holding a conference
// list for an existing group stays correct. --force discards and repacks
// everything, which renumbers areas that were already right and invalidates
// every conference list anyone holds; that stays a deliberate choice made at
// the command line.

export const description = 'Assign QWK conference numbers in per-group blocks';

export async function isNeeded(ctx) {
	// A group with no block is the state this repairs. Checked with a count
	// rather than by inspecting numbers, because an install whose groups all
	// have blocks is either already correct or has drifted in a way that wants
	// a deliberate --force rather than an automatic pass.
	var renumber = await import('../../src/maintenance/qwkConfRenumber.js');
	return await renumber.needsRenumber();
}

export async function run(ctx) {
	var renumber = await import('../../src/maintenance/qwkConfRenumber.js');

	// Throws when a group holds more areas than the stride allows. That is a
	// real decision for the sysop (raise qwk_group_stride or split the group)
	// and it should stop the update rather than half renumber the base.
	var result = await renumber.renumberConferences({ force: false });

	ctx.log('  ' + result.plan.groups.length + ' group(s), ' +
		result.changed.length + ' area(s) renumbered');

	if (result.changed.length > 0) {
		ctx.log('  QWK packets already downloaded carry the old conference numbers.');
		ctx.log('  Users should re-download rather than reply against a stale list.');
	}
}
