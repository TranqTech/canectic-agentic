/**
 * PM2 Ecosystem File — Canectic BBS
 *
 * Manages the four process model:
 *   gateway  — user connections, web UI, terminal sessions, job producer
 *   mail     — IMAP + SMTP servers for PM access from mail clients
 *   mailer   — FTN mailer sessions, file transfer
 *   worker   — tossers, maintenance, batch processing
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs              # start all
 *   pm2 start ecosystem.config.cjs --only gateway
 *   pm2 restart worker
 *   pm2 logs worker
 *   pm2 monit
 *
 * For embedded mode (single process), set PROCESS_MODE=embedded
 * and start only the gateway:
 *   PROCESS_MODE=embedded pm2 start ecosystem.config.cjs --only gateway
 *
 * Note: .cjs extension because pm2 requires CommonJS for config files,
 * even when the project uses ESM.
 */

// Load .env so TZ (and anything else we want to propagate to child
// processes) is available at config-eval time. Without this, PM2's
// log_date_format falls back to UTC on servers where the OS timezone
// isn't set (e.g. minimal container images or shells that strip TZ).
try { require('dotenv').config(); } catch (_) {}

// Resolve the effective timezone once so every child process inherits
// the same value. Precedence:
//   1. TZ in process.env (from .env or the invoking shell)
//   2. The host's resolved timezone via Intl (reads /etc/localtime)
// If both are missing we leave TZ unset and Node will default to UTC.
// Set TZ in your .env (e.g. TZ=America/Edmonton) to guarantee local
// timestamps in PM2 logs.
var resolvedTZ = process.env.TZ;
if (!resolvedTZ) {
	try {
		var ianaTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (ianaTZ && ianaTZ !== 'UTC') resolvedTZ = ianaTZ;
	} catch (_) {}
}
var baseEnv = resolvedTZ ? { TZ: resolvedTZ } : {};

// Resolve the Node binary the child processes run under. PM2's default is a
// bare 'node' looked up on PATH, which is resolved at spawn time from whatever
// environment the daemon happens to have inherited. On a box running nvm that
// is not stable: `pm2 resurrect` replays the PATH saved in the dump, so the
// children can silently come back on a different Node than the one running
// pm2. Pinning to process.execPath means the children always run under the
// same interpreter as the daemon itself.
//   1. CANECTIC_NODE in the environment (explicit override, e.g. to validate
//      the suite against a newer Node without changing the default)
//   2. process.execPath, the Node currently running pm2
var resolvedInterpreter = process.env.CANECTIC_NODE || process.execPath;

module.exports = {
	apps: [
		{
			name: 'gateway',
			script: './bin/gateway.js',
			interpreter: resolvedInterpreter,
			node_args: '--experimental-vm-modules',
			env: {
				...baseEnv,
				NODE_ENV: 'production',
				PROCESS_MODE: 'separate',
			},
			// Gateway is critical — restart aggressively
			max_restarts: 20,
			min_uptime: '5s',
			restart_delay: 1000,
			// Logging
			error_file: './logs/production/gateway-error.log',
			out_file: './logs/production/gateway-out.log',
			merge_logs: true,
			log_date_format: 'YYYY-MM-DD HH:mm:ss',
		},
		{
			name: 'mail',
			script: './bin/mail.js',
			interpreter: resolvedInterpreter,
			node_args: '--experimental-vm-modules',
			env: {
				...baseEnv,
				NODE_ENV: 'production',
			},
			// Mail servers are stateless per-connection — safe to restart
			max_restarts: 15,
			min_uptime: '5s',
			restart_delay: 2000,
			// Logging
			error_file: './logs/production/mail-error.log',
			out_file: './logs/production/mail-out.log',
			merge_logs: true,
			log_date_format: 'YYYY-MM-DD HH:mm:ss',
		},
		{
			name: 'mailer',
			script: './bin/mailer.js',
			interpreter: resolvedInterpreter,
			node_args: '--experimental-vm-modules',
			env: {
				...baseEnv,
				NODE_ENV: 'production',
				MAILER_ENABLED: 'true',
			},
			// Mailer can take a few seconds to cleanly close sessions
			kill_timeout: 10000,
			max_restarts: 10,
			min_uptime: '5s',
			restart_delay: 3000,
			// Logging
			error_file: './logs/production/mailer-error.log',
			out_file: './logs/production/mailer-out.log',
			merge_logs: true,
			log_date_format: 'YYYY-MM-DD HH:mm:ss',
		},
		{
			name: 'worker',
			script: './bin/worker.js',
			interpreter: resolvedInterpreter,
			node_args: '--experimental-vm-modules',
			env: {
				...baseEnv,
				NODE_ENV: 'production',
				WORKER_CONCURRENCY: '3',
			},
			// Worker can be restarted freely — BullMQ retries failed jobs
			max_restarts: 15,
			min_uptime: '3s',
			restart_delay: 2000,
			// Logging
			error_file: './logs/production/worker-error.log',
			out_file: './logs/production/worker-out.log',
			merge_logs: true,
			log_date_format: 'YYYY-MM-DD HH:mm:ss',
		},
	],
};
