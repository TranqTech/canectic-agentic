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
	{ key: 'currentversion',    defaultValue: _pkgVersion,      type: 'string',  category: 'system',      description: 'Software version (auto-read from package.json, overridable)' },
	{ key: 'DefaultUser',       defaultValue: 'John Doe',       type: 'string',  category: 'system',      description: 'Default poster name (legacy)' },
	{ key: 'SYSOP_USERNAME',    defaultValue: '',                type: 'string',  category: 'system',      description: 'Sysop username for PM system' },

	// -----------------------------------------------------------------------
	// Network
	// -----------------------------------------------------------------------
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
	{ key: 'allow_netmail_relay', defaultValue: 'false',         type: 'boolean', category: 'network',     description: 'Allow FTN netmail relay through this system' },
	{ key: 'PacketPwd',           defaultValue: '',              type: 'string',  category: 'network',     description: 'Default FTN packet password' },

	// -----------------------------------------------------------------------
	// Display
	// -----------------------------------------------------------------------
	{ key: 'faviconlink',       defaultValue: '/images/favicon.ico', type: 'string', category: 'display',  description: 'Favicon path for web UI' },
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
	{ key: 'session_ttl',       defaultValue: '720',            type: 'number',  category: 'security',    description: 'Web session expiry in minutes (default 720 = 12 hours)' },
	{ key: 'remember_me_days',  defaultValue: '14',             type: 'number',  category: 'security',    description: 'Days to keep session alive when "Remember Me" is checked on login (default 14)' },
	{ key: 'pwmin',             defaultValue: '12',             type: 'number',  category: 'security',    description: 'Minimum password length' },
	{ key: 'minage',            defaultValue: '13',             type: 'number',  category: 'security',    description: 'Minimum registration age' },
	{ key: 'verified_security', defaultValue: '60',             type: 'number',  category: 'security',    description: 'Security level granted on address verification (only applied if higher than current)' },
	{ key: 'unverified_retention_days', defaultValue: '14',  type: 'number',  category: 'security',    description: 'Days to keep unverified accounts before deletion (0 = never delete)' },
	{ key: 'username_change_cooldown', defaultValue: '90',  type: 'number',  category: 'security',    description: 'Days between username changes (0 = no limit)' },
	{ key: 'web_idle_threshold',       defaultValue: '120', type: 'number',  category: 'network',     description: 'Minutes of web inactivity before a new call record is logged on next request' },

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

	// -----------------------------------------------------------------------
	// Worker
	// -----------------------------------------------------------------------
	{ key: 'WORKER_CONCURRENCY',    defaultValue: '3',          type: 'number',  category: 'worker',      description: 'Toss queue concurrency (requires restart)',                   restart: true },

	// -----------------------------------------------------------------------
	// Files
	// -----------------------------------------------------------------------
	{ key: 'file_base_dir',           defaultValue: 'files',          type: 'string',  category: 'files',       description: 'Base directory for file area storage' },
	{ key: 'file_upload_staging_dir', defaultValue: 'files/staging',  type: 'string',  category: 'files',       description: 'Staging directory for file uploads' },
	{ key: 'zmodem_default_crc',      defaultValue: 'auto',           type: 'string',  category: 'files',       description: 'ZMODEM CRC mode: auto (detect from terminal), zbin32 (force CRC-32), zbin_crc16 (force CRC-16)' },
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
	{ key: 'email_trusted_hosts',       defaultValue: '127.0.0.1',     type: 'string',  category: 'email',       description: 'Comma-separated IPs allowed to inject inbound email without auth' },

	// -----------------------------------------------------------------------
	// QWK (user offline mail)
	// -----------------------------------------------------------------------
	{ key: 'qwk_enabled',              defaultValue: 'true',           type: 'boolean', category: 'qwk',         description: 'Enable user QWK packet download and REP upload' },
	{ key: 'qwk_bbsid',                defaultValue: '',               type: 'string',  category: 'qwk',         description: 'QWK BBS ID (max 8 chars, uppercase). Falls back to first 8 chars of boardname.' },
	{ key: 'qwk_max_msgs_per_area',    defaultValue: '500',            type: 'number',  category: 'qwk',         description: 'Maximum messages per area in a user QWK packet' },

	// -----------------------------------------------------------------------
	// Chat (sysop-to-web-user and future user-to-user)
	// -----------------------------------------------------------------------
	{ key: 'web_chat_enabled',         defaultValue: 'true',           type: 'boolean', category: 'chat',        description: 'Enable sysop-to-web-user chat via presence WebSocket' },
	{ key: 'web_chat_sound',           defaultValue: 'true',           type: 'boolean', category: 'chat',        description: 'Play notification sound on chat events (web UI)' },

	// -----------------------------------------------------------------------
	// Call Flow (web login experience)
	// -----------------------------------------------------------------------
	{ key: 'callflow_enabled',         defaultValue: 'true',           type: 'boolean', category: 'callflow',    description: 'Enable guided call flow on web login (announcements, callers, wall, newscan)' },
	{ key: 'callflow_on_resume',       defaultValue: 'true',           type: 'boolean', category: 'callflow',    description: 'Prompt call flow when web session resumes after idle' },

	// -----------------------------------------------------------------------
	// PM Attachments
	// -----------------------------------------------------------------------
	{ key: 'ftn_keep_tossed_days',     defaultValue: '7',                    type: 'number',  category: 'maintenance', description: 'Days to keep tossed FTN packets (0 = delete immediately, 999 = keep forever)' },
	{ key: 'freq_enabled',             defaultValue: 'true',                 type: 'boolean', category: 'mailer',      description: 'Enable FREQ (File Request) responses during binkp sessions' },
	{ key: 'freq_filebox_dir',         defaultValue: 'ftn/filebox',          type: 'string',  category: 'paths',       description: 'Directory for FREQ filebox (files available to any authenticated session)' },
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

export { CONFIG_DEFINITIONS, getDefaults, getDefinition, getCategories };
