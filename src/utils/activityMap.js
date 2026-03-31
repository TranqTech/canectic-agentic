// src/utils/activityMap.js
// Central mapping of activity identifiers to human-readable display labels.
//
// Used by:
//   - Who's Online handler (terminal node status -> display)
//   - Web presence setActivity() (web route -> display)
//   - Any future activity display (admin nodespy, web who's online, etc.)
//
// Keys are the internal identifiers used by nodeManager.updateNode() status,
// menu command names, and web activity codes. Some entries have a formatter
// function for dynamic detail (e.g. door name, menu name).

// Static activity labels (no detail needed)
var ACTIVITY_LABELS = {
	// Call flow stages
	connecting:      'Connecting',
	negotiate:       'Connecting',
	logon:           'Logging In',
	login:           'Logging In',
	door_auth:       'Authenticating',
	webdoor_auth:    'Authenticating',
	door_launch:     'Launching Door',
	last_callers:    'Viewing Last Callers',
	whos_online:     "Viewing Who's Online",
	check_online:    "Viewing Who's Online",
	check_email:     'Checking Mail',
	check_batch:     'Checking Downloads',
	announcements:   'Reading Announcements',
	verify_mail:     'Verifying Address',
	disconnecting:   'Logging Off',

	// Menu commands (when invoked from a menu)
	msgAreaChange:   'Changing Message Area',
	msgGroupChange:  'Changing Message Group',
	listMessages:    'Listing Messages',
	readMessages:    'Reading Messages',
	postMessage:     'Posting a Message',
	newScan:         'New Message Scan',
	newScanGroup:    'New Message Scan',
	userList:        'Viewing User List',
	lastCallers:     'Viewing Last Callers',
	whosOnline:      "Viewing Who's Online",
	email:           'Private Messages',
	checkEmail:      'Checking Mail',
	verifyMail:      'Verifying Address',
	passwordReset:   'Changing Password',
	doorBrowser:     'Browsing Doors',
	testDownload:    'Test Download',
	fileAreaChange:  'Changing File Area',
	fileGroupChange: 'Changing File Group',
	fileBrowser:     'Browsing Files',
	fileList:        'Browsing Files',
	downloadBatch:   'Downloading Files',
	fileUpload:      'Uploading a File',
	fileSearch:      'Searching Files',

	// Web activities (set by web routes via setActivity)
	web_browsing:    'Browsing Web',
	web_messages:    'Reading Messages',
	web_files:       'Browsing Files',
	web_doors:       'Browsing Doors',
	web_pm:          'Reading Mail',
	web_profile:     'Editing Profile',
	web_admin:       'Admin Panel',
};

// Dynamic formatters for activities that include detail.
// Each returns a display string given the detail and optional detail_display.
var ACTIVITY_FORMATTERS = {
	menu: function(detail) {
		if (detail) return 'Browsing ' + detail + ' Menu';
		return 'Browsing Menus';
	},
	door: function(detail, detailDisplay) {
		var name = detailDisplay || detail;
		if (name) return 'Playing ' + name;
		return 'Playing a Door';
	},
	runXtrn: function(detail, detailDisplay) {
		var name = detailDisplay || detail;
		if (name) return 'Playing ' + name;
		return 'Playing a Door';
	},
	loadMenu: function(detail) {
		if (detail) return 'Loading ' + detail + ' Menu';
		return 'Loading Menu';
	},
};

// Resolve an activity identifier + optional detail into a display string.
function formatActivity(status, detail, detailDisplay) {
	if (!status) return 'Unknown';

	// Check dynamic formatters first
	var formatter = ACTIVITY_FORMATTERS[status];
	if (formatter) return formatter(detail, detailDisplay);

	// Static label lookup
	var label = ACTIVITY_LABELS[status];
	if (label) return label;

	// Fallback: capitalize the status
	return status.charAt(0).toUpperCase() + status.slice(1);
}

// Get the static label for a web activity key (for use with setActivity).
function getWebActivityLabel(key) {
	return ACTIVITY_LABELS[key] || ACTIVITY_LABELS['web_' + key] || null;
}

export {
	ACTIVITY_LABELS,
	ACTIVITY_FORMATTERS,
	formatActivity,
	getWebActivityLabel
};
