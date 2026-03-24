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

module.exports = {
	apps: [
		{
			name: 'gateway',
			script: './bin/gateway.js',
			node_args: '--experimental-vm-modules',
			env: {
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
			node_args: '--experimental-vm-modules',
			env: {
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
			node_args: '--experimental-vm-modules',
			env: {
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
			node_args: '--experimental-vm-modules',
			env: {
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
