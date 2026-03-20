// INTEGRATION GUIDE — configvars.js
// ===================================
//
// The configvars module provides substitute() and substituteArray() for
// expanding %X tokens in admin-configured strings at runtime.
//
// Wire it into doorrunner.js at the launch methods where commands and
// directories are constructed. Minimal diff shown below.
//
//
// --- doorrunner.js ---
//
// 1. Add the import at the top:
//
//    import { substitute, substituteArray } from '../utils/configvars.js';
//
//
// 2. In the constructor, expand the command and directory strings:
//
//    // After: this.doorCmd = doorConfig.cmd || "";
//    // Replace with:
//    this.doorCmd = substitute(doorConfig.cmd || "", call, doorConfig);
//
//    // After: this.dropfileDir = doorConfig.dropfileDir || null;
//    // Replace with:
//    this.dropfileDir = doorConfig.dropfileDir
//        ? substitute(doorConfig.dropfileDir, call, doorConfig)
//        : null;
//
//
// 3. If you want variables in door args (e.g. passing node number):
//
//    // Not currently used by DoorRunner but used by SyncJSDoorRunner:
//    this.doorArgs = substituteArray(doorConfig.doorArgs, call, doorConfig);
//
//
// --- Example door configs that now work ---
//
//    cmd:         "lord.sh %N %U"
//                 → "lord.sh 3 SysopJoe"
//
//    dropfileDir: "%!/lord/node%*"
//                 → "/home/bbs/doors/lord/node003"
//
//    cmd:         'dosemu -I"serial { pseudo com 5 device %F}" -E %X -t'
//                 → 'dosemu -I"serial { pseudo com 5 device /doors/LOD}" -E "c:\bat\test.bat" -t'
//
//    doorDir:     "%!/lord"
//                 → "/home/bbs/doors/lord"
//
//    door_args:   ["-n", "%N", "-u", "%U"]
//                 → ["-n", "3", "-u", "SysopJoe"]
//
//
// --- Adding new variables ---
//
// Add an entry to VARIABLE_DEFS in configvars.js:
//   { token: '%M', description: 'Minutes remaining', resolve: (c) => Math.floor((c?.timeleft || 0) / 60) }
//
// That's it — the substitution engine picks it up automatically,
// and getVariableList() will include it in the admin reference panel.
