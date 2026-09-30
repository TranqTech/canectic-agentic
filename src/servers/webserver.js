import createError from 'http-errors'
import express from 'express'
import path from 'path'
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser'
import logger from 'morgan'
import * as dotenv from 'dotenv';
import * as alogger from '../utils/alogger.js';

import {router as indexRouter} from '../routes/index.js';
import {router as adminRouter} from '../routes/admin.js';
import {router as usersRouter} from '../routes/users.js';
import { router as pmRouter } from '../routes/pm.js';
import { router as adminLogRouter, registerLogWebSocket } from "../routes/adminLogs.js";
import { router as filesRouter } from '../routes/files.js';
import { router as doorserverRouter } from '../routes/doorserver.js';
import { router as callflowRouter } from '../routes/callflow.js';
import * as webNav from '../models/webNav.js';
import * as webPages from '../models/webPages.js';
import { router as pagesRouter } from '../routes/pages.js';
import { router as apiV1Router } from '../routes/api.js';
import { pgpool } from '../middleware/db/postgres.js';
import * as redis from '../middleware/db/redis.js';
import { activityMiddleware } from '../middleware/webActivity.js';
import { createErrorHandler } from '../middleware/errorHandler.js';
import { maintenanceMiddleware } from '../middleware/maintenanceWeb.js';
import appConfig from '../config/appConfig.js';
import { formatTimestamp, timestampMs, formatFriendly } from '../utils/dateFormat.js';

const node_env = process.env.NODE_ENV || "development"
var webserver = express();

// Trust proxy configuration — needed behind reverse proxies (nginx, Caddy)
// so req.ip returns the real client IP from X-Forwarded-For headers.
// Values: false (default), 'loopback', specific IP/CIDR, or number of hops.
var trustProxy = appConfig.get('trust_proxy', '');
if (trustProxy) {
	webserver.set('trust proxy', trustProxy);
}

// view engine setup
webserver.set('views', path.join(path.dirname("./"), 'src', 'views'));
webserver.set('view engine', 'pug');

//logs all http requests
//webserver.use(logger('dev'));

webserver.use(express.json());
webserver.use(express.urlencoded({ extended: false }));
webserver.use(cookieParser());
webserver.use(express.static( path.join(path.dirname("./"), 'public'), { dotfiles: 'allow' }));

// Serve web art images from txtfiles/webart/ at /webart/
webserver.use('/webart', express.static(path.join(process.cwd(), appConfig.get('textdir', 'txtfiles'), 'webart')));

// --- CSRF protection: Origin/Referer check on state-changing requests ---
webserver.use(function(req, res, next) {
	if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
		return next();
	}

	// Allow health check and other safe internal endpoints
	if (req.path === '/health') return next();

	// /api/* routes use bearer token auth and are exempt from cookie-CSRF.
	// Tokens are not sent automatically by browsers, so there's no XSRF
	// attack surface to defend against at this layer.
	if (req.path.startsWith('/api/')) return next();

	var origin = req.headers['origin'];
	var referer = req.headers['referer'];

	// Determine the expected host from the Host header
	var host = req.headers['host'];
	if (!host) {
		alogger.writeAlog(4, 'CSRF: rejected request with no Host header to ' + req.path, 'yellow');
		return res.status(403).json({ error: 'Forbidden — missing Host header' });
	}

	// Check Origin header first (most reliable)
	if (origin) {
		try {
			var originHost = new URL(origin).host;
			if (originHost === host) return next();
		} catch (_) {}
		alogger.writeAlog(4, 'CSRF: origin mismatch — origin=' + origin + ' host=' + host + ' path=' + req.path, 'yellow');
		return res.status(403).json({ error: 'Forbidden — origin mismatch' });
	}

	// Fall back to Referer header
	if (referer) {
		try {
			var refererHost = new URL(referer).host;
			if (refererHost === host) return next();
		} catch (_) {}
		alogger.writeAlog(4, 'CSRF: referer mismatch — referer=' + referer + ' host=' + host + ' path=' + req.path, 'yellow');
		return res.status(403).json({ error: 'Forbidden — referer mismatch' });
	}

	// No Origin or Referer — reject (safe default)
	alogger.writeAlog(4, 'CSRF: no Origin or Referer header on ' + req.method + ' ' + req.path, 'yellow');
	return res.status(403).json({ error: 'Forbidden — missing origin verification' });
});

// --- View helpers every page can use ---
// The table timestamp formatter, for the `ts` mixin the layouts include. Set
// here rather than per router so an admin page and a user page cannot end up
// formatting dates two ways.
webserver.use(async function(req, res, next) {
	res.locals.formatTimestamp = formatTimestamp;
	res.locals.timestampMs = timestampMs;
	// Friendly dates for user-facing views, in server time (#59): +when
	res.locals.formatFriendly = formatFriendly;
	// The sysop's navigation links (#91). The rows are loaded here, cached;
	// the navbar builds what this visitor sees, since only the route knows
	// currentuser and activelink by the time the page renders.
	try {
		res.locals.webNavItems = await webNav.getItemsForRender();
	} catch (_) {
		res.locals.webNavItems = webNav.DEFAULT_ITEMS;
	}
	// Links to sysop pages need the pages' own rules (#91 phase 4)
	try {
		res.locals.webNavPages = await webPages.getPagesForRender();
	} catch (_) {
		res.locals.webNavPages = new Map();
	}
	res.locals.buildWebNav = webNav.buildNav;
	res.locals.navPath = req.path;
	next();
});

// --- Maintenance mode ---
// After the static files, so the maintenance page still gets its CSS, and
// before activity tracking, so a refused request is not logged as a call.
webserver.use(maintenanceMiddleware());

// --- Web activity tracking (call logging on idle resume) ---
webserver.use(activityMiddleware);

// API routes use bearer-token auth and JSON responses. Mount before the
// catch-all / route so /api/v1 is checked first.
webserver.use('/api/v1', apiV1Router);

webserver.use('/', indexRouter);
webserver.use('/admin', adminRouter);
webserver.use('/adminlogs', adminLogRouter);
webserver.use('/users', usersRouter);
webserver.use('/pm', pmRouter);
webserver.use('/files', filesRouter);
webserver.use('/doorserver', doorserverRouter);
webserver.use('/callflow', callflowRouter);
webserver.use('/page', pagesRouter);

// Health check endpoint — DB and Redis connectivity
webserver.get('/health', async function(req, res) {
	var status = { status: 'ok', postgres: 'ok', redis: 'ok' };
	var httpCode = 200;

	try {
		await pgpool.query('SELECT 1');
	} catch (err) {
		status.postgres = 'error';
		status.postgresError = err.message;
		status.status = 'degraded';
		httpCode = 503;
	}

	try {
		var rc = await redis.getClient();
		await rc.ping();
	} catch (err) {
		status.redis = 'error';
		status.redisError = err.message;
		status.status = 'degraded';
		httpCode = 503;
	}

	res.status(httpCode).json(status);
});

// catch 404 and forward to error handler
webserver.use(function(req, res, next) {
  next(createError(404));
});

// error handler: logs server errors, see errorHandler.js
webserver.use(createErrorHandler({ log: alogger.writeAlog, nodeEnv: node_env }));

//module.exports = webserver;
export{webserver}
