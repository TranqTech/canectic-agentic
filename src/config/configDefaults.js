/**
 * Configuration definitions — default values, types, categories, and descriptions.
 *
 * This is the single source of truth for all known config keys.  Each entry
 * defines what the key is, its default value, its expected type, and which
 * category it belongs to.  Used by:
 *   - appConfig.js   (merge defaults into the cache)
 *   - configStore.js (seed the DB on first run / upgrade)
 *   - Admin UI       (metadata for labels, grouping, input types)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Read version from package.json once at module load so the config system
// caches it and consumers use appConfig.get('currentversion').
var _pkgVersion = '0.0.0';
try {
	var _cfgFilename = fileURLToPath(import.meta.url);
	var _cfgDirname = dirname(_cfgFilename);
	var _pkg = JSON.parse(readFileSync(join(_cfgDirname, '../../package.json'), 'utf8'));
	_pkgVersion = _pkg.version || _pkgVersion;
} catch (_) {}

var CONFIG_DEFINITIONS = [
	// -----------------------------------------------------------------------
	// System
	// -----------------------------------------------------------------------
	{ key: 'boardname',         defaultValue: 'Canectic BBS',   type: 'string',  category: 'system',      description: 'BBS name displayed in nav, origin lines, mailer handshake' },
	{ key: 'boardlocation',     defaultValue: 'The Ether',      type: 'string',  category: 'system',      description: 'BBS location for system info and QWK headers' },
	{ key: 'sysopname',         defaultValue: 'Sysop',          type: 'string',  category: 'system',      description: 'Sysop real name for drop files and QWK headers' },
	{ key: 'sysopalias',        defaultValue: '',                type: 'string',  category: 'system',      description: 'Sysop alias for drop files (falls back to sysopname)' },
	{ key: 'bbsname',           defaultValue: 'BBS',            type: 'string',  category: 'system',      description: 'Short BBS name for drop files and Synchronet shims' },
	{ key: 'system_name',       defaultValue: 'Canectic BBS',   type: 'string',  category: 'system',      description: 'System name for login handler title' },
	{ key: 'boardphone',        defaultValue: 'N/A',            type: 'string',  category: 'system',      description: 'BBS phone number for QWK control.dat' },
	{ key: 'currentversion',    defaultValue: _pkgVersion,      type: 'string',  category: 'system',      description: 'Software version, shown for reference. Read from package.json at runtime: setting it here does not change what is running, and is corrected back on migration unless deliberately set.' },
	{ key: 'DefaultUser',       defaultValue: 'John Doe',       type: 'string',  category: 'system',      description: 'Default poster name (legacy)' },
	{ key: 'SYSOP_USERNAME',    defaultValue: '',                type: 'string',  category: 'system',      description: 'Sysop username for PM system' },

	// -----------------------------------------------------------------------
	// Network
	// -----------------------------------------------------------------------
	{ key: 'areafix_rescan_default_days', defaultValue: '60',  type: 'number',  category: 'network',     description: 'Days of history a %RESCAN replays when no count is given. /FULL overrides it and replays everything still held.' },
	{ key: 'areafix_rescan_max_days',     defaultValue: '0',   type: 'number',  category: 'network',     description: 'Ceiling on a requested %RESCAN window in days. 0 = no ceiling. Does not limit /FULL.' },
	{ key: 'areafix_rescan_enabled',      defaultValue: 'true', type: 'boolean', category: 'network',     description: 'Allow downlinks to request a rescan by netmail. Disable to make %RESCAN a sysop-only operation.' },
	{ key: 'webport',              defaultValue: '8080',         type: 'number',  category: 'network',     description: 'HTTP server port (requires restart)',                        restart: true },
	{ key: 'terminalport',         defaultValue: '2023',         type: 'number',  category: 'network',     description: 'Terminal server port - auto-detects TCP vs Telnet (requires restart, 0 = disabled)', restart: true },
	{ key: 'tcpport',              defaultValue: '0',            type: 'number',  category: 'network',     description: 'Legacy TCP-only server port (0 = disabled, use terminalport instead)', restart: true },
	{ key: 'telnetport',           defaultValue: '0',            type: 'number',  category: 'network',     description: 'Legacy Telnet-only server port (0 = disabled, use terminalport instead)', restart: true },
	{ key: 'imapport',             defaultValue: '10143',        type: 'number',  category: 'network',     description: 'IMAP server port for PM access (requires restart, 0 = disabled)', restart: true },
	{ key: 'smtpport',             defaultValue: '10587',        type: 'number',  category: 'network',     description: 'SMTP submission port for sending PMs (requires restart, 0 = disabled)', restart: true },
	{ key: 'mail_domain',          defaultValue: '',             type: 'string',  category: 'network',     description: 'Domain for IMAP/SMTP addressing (e.g. mybbs.example.com). Required for mail servers.' },
	{ key: 'sitetld',             defaultValue: '',              type: 'string',  category: 'network',     description: 'Cookie domain (e.g. example.com)' },
	{ key: 'sitedomain',          defaultValue: '',              type: 'string',  category: 'network',     description: 'Full domain for URL generation' },
	{ key: 'corsorigin',          defaultValue: '',              type: 'string',  category: 'network',     description: 'CORS allowed origin' },
	{ key: 'netmail_relay_mode', defaultValue: 'nodelist',       type: 'string',  category: 'network',     description: 'Whether this system carries netmail addressed to other nodes. Nodelist mode is safe to leave on: it cannot reach a network you do not carry, or a node that does not exist.',
	  options: [
	    { value: 'nodelist', label: 'Nodelist only (recommended)', hint: 'Relay only when the sender and recipient are both listed in the same network nodelist. Blocks relaying between two networks you carry.' },
	    { value: 'off',      label: 'Off',                        hint: 'Refuse all netmail addressed to other nodes.' },
	    { value: 'on',       label: 'On (unrestricted)',          hint: 'Relay anything this system can route, including between two networks you carry. Only sensible if you intend to be a general transit point.' }
	  ] },
	{ key: 'allow_netmail_relay', defaultValue: 'false',         type: 'boolean', category: 'network',     description: 'Deprecated and ignored. Replaced by netmail_relay_mode' },
	{ key: 'netmail_ping_enabled', defaultValue: 'true',         type: 'boolean', category: 'network',     description: 'Answer netmail addressed to "Ping" with a Pong showing the route taken' },
	{ key: 'PacketPwd',           defaultValue: '',              type: 'string',  category: 'network',     description: 'Default FTN packet password' },

	// -----------------------------------------------------------------------
	// Display
	// -----------------------------------------------------------------------
	{ key: 'faviconlink',       defaultValue: '/images/favicon.ico', type: 'string', category: 'display',  description: 'Favicon path for web UI' },
	{ key: 'art_stat_timeout_ms', defaultValue: '1500',      type: 'number',  category: 'display',     description: 'How long an art file render waits for a @TC@/@TU@/@ON@ stat lookup before using the last known value. The lookup keeps running and refreshes the cache for the next render.' },
	{ key: 'theme',             defaultValue: 'canectic',       type: 'string',  category: 'display',     description: 'Terminal color theme name' },

	// -----------------------------------------------------------------------
	// Wall
	// -----------------------------------------------------------------------
	{ key: 'wall_display_count',     defaultValue: '15',    type: 'number',  category: 'wall',  description: 'Number of wall messages to display' },
	{ key: 'wall_max_length',        defaultValue: '78',    type: 'number',  category: 'wall',  description: 'Maximum message length in characters' },
	{ key: 'wall_post_security',     defaultValue: '60',    type: 'number',  category: 'wall',  description: 'Minimum security level to post on the wall (0 = anyone, 60 = verified users)' },
	{ key: 'wall_post_required_flags', defaultValue: '',    type: 'string',  category: 'wall',  description: 'Required permission flags to post (comma-separated, user must have ALL)' },
	{ key: 'wall_post_restricted_flags', defaultValue: 'Unverified',  type: 'string',  category: 'wall',  description: 'Restriction flags that block posting (comma-separated, user must have NONE)' },
	{ key: 'wall_max_messages',  defaultValue: '60',    type: 'number',  category: 'wall',  description: 'Maximum wall messages to keep (oldest are purged automatically, 0 = no limit)' },

	// -----------------------------------------------------------------------
	// Security
	// -----------------------------------------------------------------------
	{ key: 'custom_permission_flags',  defaultValue: '', type: 'string', category: 'security', description: 'Additional permission flags (comma-separated). Added to the built-in set: Sysop, Mod, Adult, Admin, Email, Netmail.' },
	{ key: 'custom_restriction_flags', defaultValue: '', type: 'string', category: 'security', description: 'Additional restriction flags (comma-separated). Added to the built-in set: Underage, Unverified, Banned, Email, Netmail, Private Messages.' },
	{ key: 'adminsecurity',     defaultValue: '200',            type: 'number',  category: 'security',    description: 'Minimum security level for admin access' },
	{ key: 'defaultsecurity',   defaultValue: '50',             type: 'number',  category: 'security',    description: 'Security level for new user accounts' },
	{ key: 'default_msg_read_security',  defaultValue: '50',  type: 'number',  category: 'security',    description: 'Default read security for new message groups/areas' },
	{ key: 'default_msg_post_security',  defaultValue: '60',  type: 'number',  category: 'security',    description: 'Default post security for new message groups/areas' },
	{ key: 'default_file_browse_security', defaultValue: '50', type: 'number', category: 'security',    description: 'Default browse security for new file groups/areas' },
	{ key: 'default_file_read_security', defaultValue: '60',  type: 'number',  category: 'security',    description: 'Default download security for new file groups/areas' },
	{ key: 'default_file_post_security', defaultValue: '100', type: 'number',  category: 'security',    description: 'Default upload security for new file groups/areas' },
	{ key: 'session_ttl',       defaultValue: '720',            type: 'number',  category: 'security',    description: 'Web session expiry in minutes (default 720 = 12 hours)' },
	{ key: 'remember_me_days',  defaultValue: '14',             type: 'number',  category: 'security',    description: 'Days to keep session alive when "Remember Me" is checked on login (default 14)' },
	{ key: 'pwmin',             defaultValue: '12',             type: 'number',  category: 'security',    description: 'Minimum password length' },
	{ key: 'trust_proxy',       defaultValue: '',                type: 'string',  category: 'security',    description: 'Express trust proxy setting for reverse proxy support. Values: loopback, IP/CIDR, or number of hops. Empty = disabled.' },
	{ key: 'honeypot_enabled',  defaultValue: 'true',           type: 'boolean', category: 'security',    description: 'Log honeypot login attempts to security.log for fail2ban integration' },
	{ key: 'honeypot_usernames', defaultValue: 'root,admin,admin1,administrator,test,user,oracle,postgres,mysql,ftp,www,nobody,pi,ubuntu,centos,vagrant,ansible,deploy,cisco,scadaadmin,cusadmin,sysadmin,dbadmin', type: 'string', category: 'security', description: 'Comma-separated honeypot usernames. Login attempts with these names are logged to security.log (never real BBS accounts).' },
	{ key: 'minage',            defaultValue: '13',             type: 'number',  category: 'security',    description: 'Minimum registration age' },
	{ key: 'verified_security', defaultValue: '60',             type: 'number',  category: 'security',    description: 'Security level granted on address verification (only applied if higher than current)' },
	{ key: 'unverified_retention_days', defaultValue: '14',  type: 'number',  category: 'security',    description: 'Days to keep unverified accounts before deletion (0 = never delete)' },
	{ key: 'username_change_cooldown', defaultValue: '90',  type: 'number',  category: 'security',    description: 'Days between username changes (0 = no limit)' },
	{ key: 'web_idle_threshold',       defaultValue: '120', type: 'number',  category: 'network',     description: 'Minutes of web inactivity before a new call record is logged on next request' },
	{ key: 'api_call_count_interval_hours', defaultValue: '4', type: 'number',  category: 'network',     description: 'Hours between logoncount bumps for API callers (e.g. QWK readers). A user pulling via API more often than this has each pull logged but only the first in the window increments their call count. Set to 0 to count every API call, or 24 for daily.' },

	// -----------------------------------------------------------------------
	// Performance
	// -----------------------------------------------------------------------
	{ key: 'cache_ttl',         defaultValue: '3600',           type: 'number',  category: 'performance', description: 'Redis cache TTL in seconds' },
	{ key: 'zones_cache_ttl',   defaultValue: '3600',           type: 'number',  category: 'performance', description: 'FTN zone list cache TTL in seconds' },

	// -----------------------------------------------------------------------
	// Maintenance
	// -----------------------------------------------------------------------
	{ key: 'pm_trash_retention_days', defaultValue: '30',       type: 'number',  category: 'maintenance', description: 'Days before hard-deleting trashed PMs' },
	{ key: 'inbound_scan_interval', defaultValue: '300',      type: 'number',  category: 'maintenance', description: 'Inbound directory scan interval in seconds (0 = disabled)' },
	{ key: 'outbound_toss_interval', defaultValue: '120',    type: 'number',  category: 'maintenance', description: 'Outbound toss sweep interval in minutes (0 = disabled). Catches messages not tossed on-demand.' },

	// -----------------------------------------------------------------------
	// Logging
	// -----------------------------------------------------------------------
	{ key: 'loglevel',              defaultValue: '3',           type: 'number',  category: 'logging',     description: 'Log verbosity (0=critical, 5=trace)' },
	{ key: 'logtoconsole',          defaultValue: '',            type: 'boolean', category: 'logging',     description: 'Force console output in production' },
	{ key: 'logeverything',         defaultValue: '',            type: 'boolean', category: 'logging',     description: 'Log all levels in development' },
	{ key: 'logfileindev',          defaultValue: '',            type: 'boolean', category: 'logging',     description: 'Write log files in development mode' },
	{ key: 'defaultlogfile',        defaultValue: 'system.log',  type: 'string',  category: 'logging',     description: 'Default log filename' },
	{ key: 'LOG_BUS_RETENTION_HOURS', defaultValue: '8',         type: 'number',  category: 'logging',     description: 'Hours to retain log bus history in Redis' },

	// -----------------------------------------------------------------------
	// Terminal
	// -----------------------------------------------------------------------
	{ key: 'inactivityTO',          defaultValue: '10',          type: 'number',  category: 'terminal',    description: 'Terminal inactivity timeout in minutes (default 10)' },
	{ key: 'warnbuff',              defaultValue: '30',          type: 'number',  category: 'terminal',    description: 'Warning buffer before timeout in seconds (default 30)' },
	{ key: 'warnmsg',               defaultValue: 'Are you there?', type: 'string', category: 'terminal',  description: 'Inactivity warning message' },
	{ key: 'inactivemsg',           defaultValue: 'You have been inactive too long', type: 'string', category: 'terminal', description: 'Inactivity disconnect message' },
	{ key: 'inputTO',               defaultValue: '20',          type: 'number',  category: 'terminal',    description: 'Input field timeout in seconds (default 20)' },
	{ key: 'termNegotiateDelay',    defaultValue: '500',         type: 'number',  category: 'terminal',    description: 'Terminal negotiation delay (ms)' },
	{ key: 'termNegotiateMsg',      defaultValue: 'Detecting Terminal...\r\n', type: 'string', category: 'terminal', description: 'Terminal negotiation message' },

	// -----------------------------------------------------------------------
	// Doors
	// -----------------------------------------------------------------------
	{ key: 'xtrnTO',                defaultValue: '30000',       type: 'number',  category: 'doors',       description: 'Door launch timeout (ms)' },
	{ key: 'doorInactivityTO',      defaultValue: '5',           type: 'number',  category: 'doors',       description: 'Door inactivity timeout in minutes (default 5)' },
	{ key: 'syncjsdoorTO',          defaultValue: '30000',       type: 'number',  category: 'doors',       description: 'SyncJS door launch timeout (ms)' },
	{ key: 'doorAuthTO',            defaultValue: '15',          type: 'number',  category: 'doors',       description: 'Door auth timeout in seconds (default 15)' },
	{ key: 'doordir',               defaultValue: '',            type: 'string',  category: 'doors',       description: 'Door game base directory' },
	{ key: 'dosemu_drive_c',        defaultValue: '~/.dosemu/drive_c', type: 'string', category: 'doors', description: 'DOSemu virtual drive C path' },

	// -----------------------------------------------------------------------
	// Paths
	// -----------------------------------------------------------------------
	{ key: 'textdir',               defaultValue: 'txtfiles',    type: 'string',  category: 'paths',       description: 'Text/art file directory' },
	{ key: 'ftninbound',            defaultValue: 'ftn/in',      type: 'string',  category: 'paths',       description: 'FTN inbound packet directory' },
	{ key: 'ftnoutbound',           defaultValue: 'ftn/out',     type: 'string',  category: 'paths',       description: 'FTN outbound packet directory' },
	{ key: 'ftntossed',             defaultValue: 'ftn/tossed',  type: 'string',  category: 'paths',       description: 'FTN tossed (processed) packet directory' },
	{ key: 'ftnbad',                defaultValue: 'ftn/bad',     type: 'string',  category: 'paths',       description: 'FTN bad packet directory' },

	// -----------------------------------------------------------------------
	// Mailer
	// -----------------------------------------------------------------------
	{ key: 'MAILER_BINKP_PORT',     defaultValue: '24554',      type: 'number',  category: 'mailer',      description: 'Binkp TCP listener port (requires restart)',                 restart: true },
	{ key: 'MAILER_WS_PORT',        defaultValue: '24555',      type: 'number',  category: 'mailer',      description: 'Mailer WebSocket listener port (requires restart)',           restart: true },
	{ key: 'MAILER_MAX_SESSIONS',   defaultValue: '10',         type: 'number',  category: 'mailer',      description: 'Maximum concurrent mailer sessions' },
	{ key: 'MAILER_CONNECT_TIMEOUT', defaultValue: '30',        type: 'number',  category: 'mailer',      description: 'Mailer connect timeout (seconds)' },
	{ key: 'MAILER_POLL_INTERVAL',  defaultValue: '900',        type: 'number',  category: 'mailer',      description: 'Default mailer poll interval (seconds)' },
	{ key: 'MAILER_SESSION_TIMEOUT', defaultValue: '300',       type: 'number',  category: 'mailer',      description: 'Mailer session timeout (seconds)' },
	{ key: 'MAILER_INBOUND_DIR',    defaultValue: '',           type: 'string',  category: 'mailer',      description: 'Mailer inbound directory (overrides ftninbound)' },
	{ key: 'MAILER_OUTBOUND_DIR',   defaultValue: '',           type: 'string',  category: 'mailer',      description: 'Mailer outbound directory (overrides ftnoutbound)' },
	{ key: 'MAILER_TEMP_DIR',       defaultValue: 'ftn/tmp',    type: 'string',  category: 'mailer',      description: 'Mailer temp directory' },
	{ key: 'MAILER_BSO_SCAN_INTERVAL', defaultValue: '60',      type: 'number',  category: 'mailer',      description: 'BSO outbound directory scan interval (seconds)' },
	{ key: 'MAILER_BSO_SCAN_ENABLED',  defaultValue: 'true',    type: 'boolean', category: 'mailer',      description: 'Enable periodic BSO outbound directory scanning' },
	{ key: 'MAILER_DEFAULT_ZONE',      defaultValue: '1',       type: 'number',  category: 'mailer',      description: 'Default FTN zone for the base outbound directory' },
	{ key: 'mailer_backoff_enabled',   defaultValue: 'true',    type: 'boolean', category: 'mailer',      description: 'Enable exponential backoff for repeated outbound mailer connect failures' },
	{ key: 'mailer_backoff_max_hours', defaultValue: '24',      type: 'number',  category: 'mailer',      description: 'Maximum backoff window in hours (cap for exponential growth)' },

	// -----------------------------------------------------------------------
	// Worker
	// -----------------------------------------------------------------------
	{ key: 'WORKER_CONCURRENCY',    defaultValue: '3',          type: 'number',  category: 'worker',      description: 'Toss queue concurrency (requires restart)',                   restart: true },
	{ key: 'toss_job_timeout',        defaultValue: '30',       type: 'number',  category: 'worker',      description: 'Minutes a toss job may run before it is failed and its slot released (0 = no limit). Without a limit one stuck job holds a concurrency slot for ever.' },
	{ key: 'maintenance_job_timeout', defaultValue: '60',       type: 'number',  category: 'worker',      description: 'Minutes a maintenance job may run before it is failed and its slot released (0 = no limit). Higher than the toss timeout because imports and batch subscribes legitimately run long.' },
	{ key: 'worker_health_enabled',   defaultValue: 'true',     type: 'boolean', category: 'worker',      description: 'Publish a worker heartbeat and have the gateway watch it. Turning this off means a stopped worker goes unreported.' },
	{ key: 'worker_heartbeat_interval', defaultValue: '30',     type: 'number',  category: 'worker',      description: 'Seconds between worker heartbeats' },
	{ key: 'worker_health_check_interval', defaultValue: '60',  type: 'number',  category: 'worker',      description: 'Seconds between gateway checks of the worker heartbeat' },
	{ key: 'worker_health_grace',     defaultValue: '180',      type: 'number',  category: 'worker',      description: 'Seconds a worker may go quiet before it counts as failed. Must comfortably exceed the time the worker takes to restart.' },
	{ key: 'worker_selfcheck_max_failures', defaultValue: '3',  type: 'number',  category: 'worker',      description: 'Consecutive failed self checks before the worker exits so the supervisor restarts it' },
	{ key: 'worker_restart_enabled',  defaultValue: 'true',     type: 'boolean', category: 'worker',      description: 'Let the gateway restart a failed worker automatically. With this off the sysop is still notified, but nothing acts.' },
	{ key: 'worker_restart_command',  defaultValue: 'pm2 restart worker', type: 'string', category: 'worker', description: 'Command used to restart the worker. A bare pm2 is resolved next to the running Node binary first. Change this if the processes are supervised by something other than pm2.' },
	{ key: 'worker_restart_cooldown', defaultValue: '300',      type: 'number',  category: 'worker',      description: 'Seconds to wait between automatic restart attempts' },
	{ key: 'worker_restart_max_attempts', defaultValue: '3',    type: 'number',  category: 'worker',      description: 'Automatic restarts to attempt per incident before giving up and leaving it to the sysop. A restart loop is worse than the outage it chases.' },
	{ key: 'worker_schedule_lag_grace', defaultValue: '15',     type: 'number',  category: 'worker',      description: 'Minutes a repeating job may be overdue before the sysop is warned (0 = never warn). Overdue schedules alongside a healthy worker usually mean the processes disagree about REDIS_BULLMQ_DB.' },

	// -----------------------------------------------------------------------
	// Files
	// -----------------------------------------------------------------------
	{ key: 'file_base_dir',           defaultValue: 'files',          type: 'string',  category: 'files',       description: 'Base directory for file area storage' },
	{ key: 'file_upload_staging_dir', defaultValue: 'files/staging',  type: 'string',  category: 'files',       description: 'Staging directory for file uploads' },
	{ key: 'zmodem_default_crc',      defaultValue: 'auto',           type: 'string',  category: 'files',       description: 'ZMODEM CRC mode used for downloads.',
	  options: [
	    { value: 'auto',       label: 'Auto (recommended)', hint: 'Pick from the terminal type. Modern terminals get CRC-32.' },
	    { value: 'zbin32',     label: 'Force CRC-32',       hint: 'Faster, but older terminals may not support it.' },
	    { value: 'zbin_crc16', label: 'Force CRC-16',       hint: 'Maximum compatibility with legacy terminals.' }
	  ] },
	{ key: 'file_max_upload_size',    defaultValue: '10485760',       type: 'number',  category: 'files',       description: 'Maximum upload file size in bytes (default 10MB)' },
	{ key: 'file_allowed_extensions', defaultValue: '',               type: 'string',  category: 'files',       description: 'Comma-separated allowed file extensions (empty = all)' },
	{ key: 'tic_staging_dir',         defaultValue: 'ftn/tic_staging', type: 'string', category: 'files',       description: 'TIC processing staging directory' },
	{ key: 'tic_inbound_dir',         defaultValue: '',               type: 'string',  category: 'files',       description: 'TIC inbound directory (defaults to ftninbound)' },
	{ key: 'tic_auto_forward',        defaultValue: 'true',           type: 'boolean', category: 'files',       description: 'Auto-forward received TIC files to subscribed peers' },

	// -----------------------------------------------------------------------
	// Email (Internet email transport)
	// -----------------------------------------------------------------------
	{ key: 'email_relay_host',          defaultValue: '',               type: 'string',  category: 'email',       description: 'SMTP relay hostname for outbound internet email (empty = disabled)' },
	{ key: 'email_relay_port',          defaultValue: '587',            type: 'number',  category: 'email',       description: 'SMTP relay port (587 = STARTTLS, 465 = implicit TLS)' },
	{ key: 'email_relay_secure',        defaultValue: 'false',          type: 'boolean', category: 'email',       description: 'Use implicit TLS (true) or STARTTLS (false)' },
	{ key: 'email_relay_user',          defaultValue: '',               type: 'string',  category: 'email',       description: 'SMTP relay auth username' },
	{ key: 'email_relay_password',      defaultValue: '',               type: 'string',  category: 'email',       description: 'SMTP relay auth password' },
	{ key: 'email_from_address',        defaultValue: '',               type: 'string',  category: 'email',       description: 'Envelope From address for outbound email (e.g. bbs@mybbs.com)' },
	{ key: 'email_from_name',           defaultValue: '',               type: 'string',  category: 'email',       description: 'Display name for outbound email (falls back to boardname)' },
	{ key: 'email_max_outbound_batch',  defaultValue: '50',             type: 'number',  category: 'email',       description: 'Maximum emails per outbound toss cycle' },
	{ key: 'email_inbound_port',        defaultValue: '0',              type: 'number',  category: 'email',       description: 'Trusted inbound SMTP port for gateway injection (e.g. 1026, 0 = disabled, requires restart)', restart: true },
	{ key: 'email_trusted_hosts',       defaultValue: '127.0.0.1',     type: 'string',  category: 'email',       description: 'Comma-separated IPs or IPv4 CIDR blocks allowed to inject inbound email without auth (e.g. 127.0.0.1, 10.0.0.0/8)' },

	// -----------------------------------------------------------------------
	// QWK (user offline mail)
	// -----------------------------------------------------------------------
	{ key: 'qwk_enabled',              defaultValue: 'true',           type: 'boolean', category: 'qwk',         description: 'Enable user QWK packet download and REP upload' },
	{ key: 'qwk_bbsid',                defaultValue: '',               type: 'string',  category: 'qwk',         description: 'QWK BBS ID (max 8 chars, uppercase). Falls back to first 8 chars of boardname.' },
	{ key: 'qwk_max_msgs_per_area',    defaultValue: '500',            type: 'number',  category: 'qwk',         description: 'Maximum messages per area in a user QWK packet' },
	{ key: 'qwk_announcements_conf',   defaultValue: '1',              type: 'number',  category: 'qwk',         description: 'Conference number for system announcements in QWK downloads (must be 1-100 reserved range, 0 to disable)' },
	{ key: 'qwk_wall_conf',            defaultValue: '2',              type: 'number',  category: 'qwk',         description: 'Conference number for the wall in QWK downloads (must be 1-100 reserved range, 0 to disable)' },
	{ key: 'qwk_bulletins_conf',       defaultValue: '3',              type: 'number',  category: 'qwk',         description: 'Conference number for bulletins in QWK downloads (must be 1-100 reserved range, 0 to disable)' },
	{ key: 'qwk_group_stride',         defaultValue: '1000',           type: 'number',  category: 'qwk',         description: 'Conference number block size per message group. Each new group is auto-assigned a start at MAX(existing) + stride; areas in the group take consecutive offsets within [start, start+stride-1]. Larger stride leaves more room for future areas; smaller stride packs groups tighter.' },

	// -----------------------------------------------------------------------
	// Chat (sysop-to-web-user and future user-to-user)
	// -----------------------------------------------------------------------
	{ key: 'web_chat_enabled',         defaultValue: 'true',           type: 'boolean', category: 'chat',        description: 'Enable sysop-to-web-user chat via presence WebSocket' },
	{ key: 'web_chat_sound',           defaultValue: 'true',           type: 'boolean', category: 'chat',        description: 'Play notification sound on chat events (web UI)' },

	// -----------------------------------------------------------------------
	// Notifications
	// -----------------------------------------------------------------------
	{ key: 'notifications_enabled',          defaultValue: 'true',  type: 'boolean', category: 'system',      description: 'Enable the notification system' },
	{ key: 'notifications_retention_days',   defaultValue: '30',    type: 'number',  category: 'maintenance', description: 'Days to keep read notifications before purge (0 = never purge)' },

	// -----------------------------------------------------------------------
	// Updates
	//
	// Off by default. An outbound request from a sysop's box should be
	// something they turned on, not something they have to discover and turn
	// off. The check never downloads and never applies.
	// -----------------------------------------------------------------------
	{ key: 'update_check_enabled',  defaultValue: 'false', type: 'boolean', category: 'updates',
	  description: 'Check daily for a newer Canectic release and raise a sysop notification. Read-only: it never downloads and never applies anything.' },
	{ key: 'update_channel',        defaultValue: 'stable', type: 'string',  category: 'updates',
	  description: 'Which release channel this install follows. A system on development is also told when stable is available, since converging onto stable is a move it should be offered.',
	  options: [
	    { value: 'stable',      label: 'Stable',      hint: 'Full releases only. Also the right choice for a board other people call.' },
	    { value: 'development', label: 'Development', hint: 'Builds cut when there is something worth having, possibly weeks apart. Meant to be run on live boards, not merely inspected.' }
	  ] },
	{ key: 'update_check_url',      defaultValue: 'https://canectic.tranqsoft.com/releases/', type: 'string', category: 'updates',
	  description: 'Base URL holding the channel indexes. The check fetches index-<channel>.json from here and nothing else.' },
	{ key: 'update_check_retention_days', defaultValue: '90', type: 'number', category: 'maintenance',
	  description: 'Days of update check history to keep (0 = never purge)' },

	// -----------------------------------------------------------------------
	// Call Flow (web login experience)
	// -----------------------------------------------------------------------
	{ key: 'callflow_enabled',         defaultValue: 'true',           type: 'boolean', category: 'callflow',    description: 'Enable guided call flow on web login (announcements, callers, wall, newscan)' },
	{ key: 'callflow_on_resume',       defaultValue: 'true',           type: 'boolean', category: 'callflow',    description: 'Prompt call flow when web session resumes after idle' },

	// -----------------------------------------------------------------------
	// PM Attachments
	// -----------------------------------------------------------------------
	{ key: 'ftn_keep_tossed_days',     defaultValue: '7',                    type: 'number',  category: 'maintenance', description: 'Days to keep tossed FTN packets (0 = delete immediately, 999 = keep forever)' },
	{ key: 'bad_echo_retention_days',  defaultValue: '30',                   type: 'number',  category: 'maintenance', description: 'Days to keep bad echomail before auto-purge (0 = keep forever)' },
	{ key: 'inbound_log_retention_days', defaultValue: '90',                type: 'number',  category: 'maintenance', description: 'Days to keep inbound file log entries before auto-purge (0 = keep forever)' },
	{ key: 'outbound_log_retention_days', defaultValue: '90',              type: 'number',  category: 'maintenance', description: 'Days to keep outbound file log entries before auto-purge (0 = keep forever)' },
	{ key: 'netmail_relay_log_retention_days', defaultValue: '180', type: 'number', category: 'maintenance', description: 'Days to keep the netmail relay decision log. Longer than the other logs by default because relay disputes surface slowly: a downlink usually notices missing mail weeks later.' },
	{ key: 'mailer_session_retention_days', defaultValue: '30',            type: 'number',  category: 'maintenance', description: 'Days to keep mailer session history before auto-purge (0 = keep forever)' },
	{ key: 'freq_enabled',             defaultValue: 'true',                 type: 'boolean', category: 'mailer',      description: 'Enable FREQ (File Request) responses during binkp sessions' },
	{ key: 'freq_filebox_dir',         defaultValue: 'ftn/filebox',          type: 'string',  category: 'paths',       description: 'Directory for FREQ filebox (files available to any authenticated session)' },
	{ key: 'filebox_base_dir',         defaultValue: 'ftn/filebox',          type: 'string',  category: 'paths',       description: 'Parent directory for per-peer filebox subdirectories (outbox_dir resolves relative to this)' },
	{ key: 'freq_max_files',           defaultValue: '10',                   type: 'number',  category: 'mailer',      description: 'Maximum files to send per FREQ request' },
	{ key: 'pm_attachment_dir',        defaultValue: 'files/pm_attachments', type: 'string',  category: 'paths',    description: 'Storage directory for PM file attachments' },
	{ key: 'pm_max_attachment_size',   defaultValue: '10485760',             type: 'number',  category: 'security', description: 'Maximum PM attachment size in bytes (default 10MB)' },
	{ key: 'pm_max_attachments',       defaultValue: '5',                    type: 'number',  category: 'security', description: 'Maximum number of attachments per PM' },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// Build a flat { key: defaultValue } map
function getDefaults() {
	var defaults = {};
	for (var def of CONFIG_DEFINITIONS) {
		defaults[def.key] = def.defaultValue;
	}
	return defaults;
}

// Lookup a single definition by key
function getDefinition(key) {
	for (var def of CONFIG_DEFINITIONS) {
		if (def.key === key) return def;
	}
	return null;
}

// Return sorted list of distinct categories
/**
 * Is this an acceptable value for a key with a fixed set of options?
 *
 * True for any key that does not declare options, so callers can ask about
 * every key without special casing.
 *
 * Lives here rather than in the admin route because the point is that nothing
 * should be able to store a value the consumers will not honour, and the admin
 * form is only the most likely way in. These read as free text wherever they
 * are consumed and fall back to a default on anything unrecognised, so a bad
 * value does not fail loudly: the setting quietly behaves as something other
 * than what the settings page shows.
 */
function isAllowedValue(key, value) {
	var def = getDefinition(key);
	if (!def || !def.options || def.options.length === 0) return true;
	for (var opt of def.options) {
		if (opt.value === value) return true;
	}
	return false;
}

function getCategories() {
	var seen = {};
	var cats = [];
	for (var def of CONFIG_DEFINITIONS) {
		if (!seen[def.category]) {
			seen[def.category] = true;
			cats.push(def.category);
		}
	}
	return cats;
}

export { CONFIG_DEFINITIONS, getDefaults, getDefinition, getCategories, isAllowedValue };
