// doorserver.js -- a user's own BBS registrations with this board's door
// server (#86). Mounted at /doorserver.
//
// Only logged-in users at or above doorserver_register_security, with the
// door server switched on, may register; there is no public form. A
// registration is tied to the user's account, which makes them its contact,
// and waits for the sysop unless doorserver_auto_approve is on. The secret is
// shown once, in the flash, when the system is made or given a new one.

import express from 'express';
import * as sessionStore from '../middleware/db/sessionstore.js';
import * as flash from '../middleware/db/flash.js';
import * as doorserver from '../models/doorserver.js';
import * as alogger from '../utils/alogger.js';
import appConfig from '../config/appConfig.js';

var router = express.Router();
var urlencodedParser = express.urlencoded({ extended: false });

async function currentUser(req) {
	return (await sessionStore.sessionGet(req.cookies && req.cookies.sessionid)) || null;
}

// The system, if this user registered it.
async function ownedSystem(user, uuid) {
	var sys = await doorserver.getByUuid(uuid);
	if (!sys || !user || parseInt(sys.owner_user_id) !== parseInt(user.id)) return null;
	return sys;
}

router.get('/', async (req, res) => {
	var user = await currentUser(req);
	if (!user) return res.redirect('/users/login');
	res.locals.currentuser = user;
	res.locals.flash = await flash.get(req);
	res.render('doorserver/index', {
		title: 'Door Server',
		currentuser: user,
		systems: await doorserver.getForOwner(parseInt(user.id)),
		mayRegister: doorserver.mayRegister(user),
		enabled: appConfig.getBoolean('doorserver_enabled', false),
		autoApprove: appConfig.getBoolean('doorserver_auto_approve', false),
		registerSecurity: appConfig.getNumber('doorserver_register_security', 100),
		boardAddress: (req.protocol === 'https' ? 'wss://' : 'ws://') + req.get('host') + '/ws/doorserver'
	});
});

router.post('/register', urlencodedParser, async (req, res) => {
	var user = await currentUser(req);
	if (!user) return res.redirect('/users/login');
	if (!doorserver.mayRegister(user)) {
		await flash.setOne(req, 'danger', 'Your account cannot register a BBS with this door server.');
		return res.redirect('/doorserver');
	}
	var r = await doorserver.createSystem(req.body, { ownerUserId: parseInt(user.id), actor: user.username });
	if (!r.status) {
		await flash.setOne(req, 'danger', r.errors.join('. '));
		return res.redirect('/doorserver');
	}
	await flash.setOne(req, 'success', 'Registered ' + r.system.system_id + (r.system.status === 'approved' ? '.' : ', waiting for the sysop to approve it.') +
		' Your secret, shown only this once: ' + r.secret);
	try {
		var notif = await import('../models/notifications.js');
		await notif.createSysop('doorserver_registration', 'Door server registration: ' + r.system.bbs_name,
			user.username + ' registered ' + r.system.bbs_name + ' (' + r.system.system_id + ')' +
			(r.system.status === 'approved' ? ', approved automatically.' : '; it is waiting for your approval.'),
			{ link: '/admin/doorserver', icon: 'hdd-network', severity: r.system.status === 'approved' ? 'info' : 'warning' });
	} catch (err) {
		alogger.writeAlog(3, '[DoorServer] registration notice failed: ' + err.message, 'yellow');
	}
	res.redirect('/doorserver');
});

router.post('/:uuid/update', urlencodedParser, async (req, res) => {
	var user = await currentUser(req);
	if (!user) return res.redirect('/users/login');
	var sys = await ownedSystem(user, req.params.uuid);
	if (!sys) return res.redirect('/doorserver');
	var r = await doorserver.updateDetails(sys.uuid, req.body, {});
	await flash.setOne(req, r.status ? 'success' : 'danger', r.status ? 'Saved.' : r.errors.join('. '));
	res.redirect('/doorserver');
});

router.post('/:uuid/secret', urlencodedParser, async (req, res) => {
	var user = await currentUser(req);
	if (!user) return res.redirect('/users/login');
	var sys = await ownedSystem(user, req.params.uuid);
	if (!sys) return res.redirect('/doorserver');
	var secret = await doorserver.regenerateSecret(sys.uuid);
	await flash.setOne(req, secret ? 'success' : 'danger', secret
		? 'New secret for ' + sys.system_id + ' (the old one no longer works), shown only this once: ' + secret
		: 'Could not make a new secret.');
	res.redirect('/doorserver');
});

export { router };
