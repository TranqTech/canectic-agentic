// qnet-directory.js
// Synchronet JavaScript module for directory-based QWKnet call-outs.
// Synchronet is the NODE; the remote system (e.g. Canectic BBS) is the HUB.
// Copies REP/QWK packets to/from a shared filesystem directory instead
// of using FTP or HTTP.
//
// Usage in SCFG -> Networks -> QWK -> Hubs -> <HUB> -> Call-out Command Line:
//
//   ?qnet-directory <hub-id> <exchange-dir>
//
// Example:
//   ?qnet-directory UNDREDUX /home/kostie/door-server/qnet/UNDRMINE
//
// <hub-id> is the QWK ID of the hub (Canectic). Passed automatically via %s.
// <exchange-dir> is the hub's exchange directory, containing:
//   in/   — hub's inbound. We DROP our .rep here for the hub to import.
//   out/  — hub's outbound. We PICK UP .qwk packets the hub left for us.
//
// Flow (same as qnet-ftp, but filesystem instead of FTP):
//   1. If we have a .rep to send, copy it to <exchange-dir>/in/
//   2. If the hub has a .qwk for us, copy it from <exchange-dir>/out/
//
// Install: Copy this file to your Synchronet exec/ directory.

const REVISION = "1.0";

// -----------------------------------------------------------------------
// Logging — writes to both console and <exchange-dir>/qnet.log
// -----------------------------------------------------------------------
var _logFile = null;

function qlog(msg) {
    var ts = strftime("%Y-%m-%d %H:%M:%S");
    var line = ts + "  " + msg;
    print(msg);
    if (_logFile) {
        _logFile.writeln(line);
    }
}

function qalert(msg) {
    alert(msg);
    var ts = strftime("%Y-%m-%d %H:%M:%S");
    if (_logFile) {
        _logFile.writeln(ts + "  ! " + msg);
    }
}

// Safe file copy using Synchronet's File object (file_copy may not exist)
function copyFile(src, dst) {
    var srcFile = new File(src);
    if (!srcFile.open("rb")) {
        return false;
    }
    var data = srcFile.read();
    srcFile.close();
    if (!data) {
        return false;
    }
    var dstFile = new File(dst);
    if (!dstFile.open("wb")) {
        return false;
    }
    dstFile.write(data);
    dstFile.close();
    return true;
}

log(LOG_INFO, "QNET-DIRECTORY " + REVISION + " invoked with options: " + argv.join(' '));

if (argc < 2) {
    alert("usage: ?qnet-directory <hub-id> <exchange-dir>");
    alert("  hub-id:        QWK ID of the hub system");
    alert("  exchange-dir:  path to the hub's exchange directory");
    exit(1);
}

var hubid = argv[0];
var exchangeDir = argv[1];

// Normalise: strip trailing slashes
while (exchangeDir.length > 1 &&
       (exchangeDir.slice(-1) === '/' || exchangeDir.slice(-1) === '\\')) {
    exchangeDir = exchangeDir.slice(0, -1);
}

// Open log file (append mode)
var logPath = exchangeDir + "/qnet.log";
_logFile = new File(logPath);
if (!_logFile.open("a")) {
    log(LOG_ERR, "Could not open log file: " + logPath);
    _logFile = null;
}

qlog("QNET-DIRECTORY " + REVISION + " — hub: " + hubid);

// Hub's exchange directory layout:
//   in/  = hub's inbound  → we DROP our .rep here
//   out/ = hub's outbound → we PICK UP .qwk from here
var hubInDir  = exchangeDir + "/in";
var hubOutDir = exchangeDir + "/out";

// Synchronet's local paths
var rep = system.data_dir + hubid + ".rep";
var qwk = hubid + ".qwk";
var qwk_fname = system.data_dir + qwk;

log(LOG_DEBUG, "Hub ID:         " + hubid);
log(LOG_DEBUG, "Exchange dir:   " + exchangeDir);
log(LOG_DEBUG, "Hub in dir:     " + hubInDir  + "  (we drop .rep here)");
log(LOG_DEBUG, "Hub out dir:    " + hubOutDir + "  (we pick up .qwk here)");
log(LOG_DEBUG, "Local REP:      " + rep);
log(LOG_DEBUG, "Local QWK:      " + qwk_fname);

// -----------------------------------------------------------------------
// Phase 1: Send our .rep to the hub
// -----------------------------------------------------------------------
// If Synchronet has generated a .rep for this hub, copy it into the
// hub's inbound directory for the hub to import.

rep = file_getcase(rep);
if (rep) {
    qlog("Sending REP: " + rep + format(" (%1.1fKB)", file_size(rep) / 1024.0));
    var destRep = hubInDir + "/" + hubid + ".rep";
    if (copyFile(rep, destRep)) {
        qlog("REP copied to " + destRep);
        if (!file_remove(rep)) {
            qalert("Error removing sent REP: " + rep);
        }
    } else {
        qalert("Failed to copy REP to " + destRep);
        if (_logFile) _logFile.close();
        exit(1);
    }
}

// -----------------------------------------------------------------------
// Phase 2: Receive .qwk from the hub
// -----------------------------------------------------------------------
// If the hub has left a .qwk for us, copy it to system.data_dir
// so Synchronet can import the new messages.

if (file_exists(qwk_fname) && file_size(qwk_fname) > 0) {
    qalert(qwk_fname + " already exists — skipping QWK pickup");
} else {
    var pickupQwk = file_getcase(hubOutDir + "/" + hubid + ".qwk");
    if (pickupQwk) {
        qlog("Receiving QWK: " + pickupQwk +
              format(" (%1.1fKB)", file_size(pickupQwk) / 1024.0));
        if (copyFile(pickupQwk, qwk_fname)) {
            if (file_size(qwk_fname) < 1) {
                qalert("Invalid QWK packet size: " + file_size(qwk_fname));
                file_remove(qwk_fname);
            } else {
                qlog("QWK received: " + qwk_fname +
                      format(" (%1.1fKB)", file_size(qwk_fname) / 1024.0));
                if (!file_remove(pickupQwk)) {
                    qalert("Error removing picked-up QWK: " + pickupQwk);
                }
            }
        } else {
            qalert("Failed to copy QWK from " + pickupQwk);
        }
    } else {
        qlog("No QWK packet from hub");
    }
}

qlog("Done.");
if (_logFile) _logFile.close();
