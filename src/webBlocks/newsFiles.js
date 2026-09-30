// newsFiles.js -- Web block: the active news and score files (door scores,
// BBS news), rendered from their ANSI/text source.

import fs from 'fs';
import * as newsFilesModel from '../models/newsFiles.js';
import { formatBodyHtml } from '../utils/terminalText.js';

export default {
	name: 'newsfiles',
	label: 'News',
	view: 'callflow/newsfiles',
	requiresUser: false,

	async available(ctx) {
		var active = await ctx.once('newsFiles', function () { return newsFilesModel.getActiveNewsFiles(); });
		return active.length > 0 ? { count: active.length } : null;
	},

	async load(ctx) {
		var active = await ctx.once('newsFiles', function () { return newsFilesModel.getActiveNewsFiles(); });
		var items = [];

		for (var nf of active) {
			try {
				var rawBuf = fs.readFileSync(nf.file_path);
				// Strip EOF marker (0x1A) if present
				var eofIdx = rawBuf.indexOf(0x1A);
				if (eofIdx !== -1) rawBuf = rawBuf.subarray(0, eofIdx);
				if (rawBuf.length === 0) continue;

				var html = await formatBodyHtml(rawBuf.toString('binary'));
				items.push({
					title: nf.title,
					description: nf.description || '',
					html: html,
					center: !!nf.center,
					sourceWidth: nf.source_width || 80
				});
			} catch (err) {
				// Missing or unreadable: say so in place rather than hide it,
				// so the sysop sees the stale entry
				items.push({
					title: nf.title,
					description: nf.description || '',
					html: '<p class="text-muted">File not found: ' + nf.file_path + '</p>',
					center: false,
					sourceWidth: 80
				});
			}
		}

		return { items: items };
	}
};
