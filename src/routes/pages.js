// pages.js -- Serves the sysop's web pages at /page/<slug> (#91 phase 4).
//
// A page nobody may read is answered the way the rest of the site answers:
// a visitor is sent to log in and back (the page may be for users; the same
// as /users/verify does), a logged-in user
// who may not read it is told so, and an unpublished or missing page is the
// ordinary 404, so an unpublished draft cannot be told from nothing at all.

import express from 'express';
import * as sessionStore from '../middleware/db/sessionstore.js';
import * as webPages from '../models/webPages.js';
import { getDefaultTheme, resolveWebColour } from '../models/themes.js';

var router = express.Router();

async function getCurrentUser(req) {
	if (!req.cookies || !req.cookies.sessionid) return null;
	var session = await sessionStore.sessionGet(req.cookies.sessionid);
	return session && session.id ? session : null;
}

router.get('/:slug', async (req, res, next) => {
	var page = await webPages.getPageBySlug(req.params.slug);
	if (!page || !page.active) return next();

	var currentuser = await getCurrentUser(req);
	res.locals.currentuser = currentuser;
	if (!webPages.pageVisibleTo(page, currentuser)) {
		// A visitors-only page is not for a logged-in user; anything else a
		// visitor cannot read may be theirs once logged in
		if (!currentuser && page.audience !== 'public') {
			return res.redirect('/users/login?redirect=' + encodeURIComponent(req.originalUrl));
		}
		return res.status(403).render('status/unauthorized', { title: 'Not Available', currentuser: currentuser });
	}

	var theme = await getDefaultTheme();
	res.render('public/page', {
		title: page.title,
		activelink: '',
		currentuser: currentuser,
		page: page,
		themeTextColour: resolveWebColour(theme, 'announcements')
	});
});

export { router };
