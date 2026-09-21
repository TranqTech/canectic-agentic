/**
 * The Express error handler, as a factory so it can be tested without
 * starting the web server.
 *
 * It used to render the error page and log nothing. An exception in any route
 * therefore showed the sysop an error page and left the logs clean, so a save
 * that "did not take" could not be told apart from a save that was never
 * submitted. Server errors (5xx) are now logged with the method, the path and
 * the stack. Client errors (4xx) are not: every 404 from a scanner would
 * otherwise bury the ones that matter.
 *
 * The path is logged without its query string, since a GET form carries its
 * fields there.
 *
 * @param {object} options
 * @param {function} options.log - writeAlog-shaped: (level, message, colour)
 * @param {string} options.nodeEnv - the stack is shown on the page only in development
 * @returns {function} Express error middleware
 */
export function createErrorHandler(options) {
	var log     = options.log;
	var nodeEnv = options.nodeEnv || 'development';

	return function errorHandler(err, req, res, next) {
		var status = (err && (err.status || err.statusCode)) || 500;

		if (status >= 500) {
			var path = String(req.originalUrl || req.url || '').split('?')[0];
			var detail = (err && err.stack) ? err.stack : String(err && err.message || err);
			log(1, 'Web ' + status + ': ' + req.method + ' ' + path + ': ' + detail, 'redbright');
		}

		// Headers already on the wire means the page cannot be replaced; hand
		// it to Express's default handler, which closes the connection.
		if (res.headersSent) return next(err);

		res.locals.message = err && err.message;
		res.locals.error = nodeEnv === 'development' ? err : {};
		res.status(status);
		res.render('error');
	};
}
