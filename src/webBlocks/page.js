// page.js -- Web block: one of the sysop's Web Pages as a call flow stage,
// the web counterpart of the terminal's Display Screen. Repeatable, one page
// each. Shown only to someone allowed to read that page, and labelled with
// its title.

import { catalogEntry } from './catalog.js';
import { getPagesForRender, getPageById, pageVisibleTo } from '../models/webPages.js';
import { getDefaultTheme, resolveWebColour } from '../models/themes.js';

export default Object.assign({}, catalogEntry('page'), {
	view: 'callflow/page',

	async available(ctx, opts) {
		if (!opts.page) return null;
		var pages = await ctx.once('webPages', function () { return getPagesForRender(); });
		var p = pages.get(opts.page);
		if (!p || !pageVisibleTo(p, ctx.user)) return null;
		return { label: p.title };
	},

	// Checked again here, since a stage's address can be fetched directly:
	// a page this visitor may not read is not sent
	async load(ctx, opts) {
		var p = opts.page ? await getPageById(opts.page) : null;
		if (!p || !pageVisibleTo(p, ctx.user)) return { page: null };
		var theme = await getDefaultTheme();
		return { page: p, themeTextColour: resolveWebColour(theme, 'announcements') };
	}
});
