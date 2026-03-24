# Canectic BBS — FTN Nodelist System Design

## Overview

FTN networks distribute a nodelist — a text file describing every system on the network with their addresses, capabilities, hostnames, and hierarchical roles. Canectic needs nodelist support for three purposes:

1. **Mailer outbound resolution** — looking up hostname/port for systems we need to connect to but do not have a configured peer connection for
2. **Netmail routing** — walking the FTN hierarchy (node -> hub -> host -> region -> zone coordinator) to find a route when no direct connection or routing rule exists
3. **System information display** — showing system names, sysop names, and locations for addresses encountered in messages or mailer sessions

This document covers the database schema, parser, import process, lookup API, integration with existing routing and mailer subsystems, multi-network handling, and admin UI.

For the existing FTN routing cascade, see `NETWORKING_ARCHITECTURE.md`.
For the mailer session architecture, see `MAILER_ARCHITECTURE.md`.
For the process model and job queues, see `PROCESS_ARCHITECTURE.md`.

---

## Design Principles

- **Database-backed, not file-parsed-on-demand.** A full FidoNet nodelist has ~10,000+ entries. Parsing on every lookup would be wasteful. Import into PostgreSQL once, query efficiently.
- **Multi-network from the start.** The BBS may participate in FidoNet, fsxNet, AgoraNet, etc. Each has its own nodelist. The `network_id` column ties entries to a specific `message_networks` record.
- **Historical tracking.** Nodes are never deleted — they get `active = false` and a `removed_at` timestamp when they disappear from a nodelist. `first_seen` records when a system first appeared. Enables stats like "new systems this week", "longest-running nodes", "recently gone dark".
- **Upsert import, not bulk replace.** New nodes are inserted, existing nodes are updated, missing nodes are deactivated. Preserves historical data across weekly imports.
- **Read-heavy, write-rare.** Nodelists are updated weekly (typically Fridays). The import runs once per week. Lookups happen on every outbound session and every unrouted netmail. Optimize for reads.
- **No new process.** Imports run as BullMQ maintenance jobs on the existing Worker process. No new queue needed.
- **Fits existing patterns.** Uses `postgres.insertObject()`, `postgres.query()`, parameterized queries, `var` declarations, ES module imports, and the existing model/route/view structure.

---

## 1. Database Schema

### Table: `ftn_nodelist`

One row per node entry in a nodelist. Composite unique constraint on `(network_id, zone, net, node, point)`.

```sql
CREATE TABLE IF NOT EXISTS ftn_nodelist (
    id              SERIAL PRIMARY KEY,
    network_id      INTEGER NOT NULL REFERENCES message_networks(id),

    -- Address components (parsed from nodelist context)
    zone            INTEGER NOT NULL,
    net             INTEGER NOT NULL,
    node            INTEGER NOT NULL,
    point           INTEGER NOT NULL DEFAULT 0,

    -- Hierarchical role
    keyword         VARCHAR(10) NOT NULL DEFAULT '',
    -- '' = regular node, 'Zone', 'Region', 'Host', 'Hub', 'Down', 'Hold', 'Pvt'

    -- Hub assignment (for regular nodes under a Hub keyword)
    hub_node        INTEGER,
    -- The node number of the hub this node routes through within its net.
    -- NULL for nodes listed before any Hub keyword in their net, and for
    -- coordinators themselves.

    -- System info
    system_name     VARCHAR(255) NOT NULL DEFAULT '',
    location        VARCHAR(255) NOT NULL DEFAULT '',
    sysop_name      VARCHAR(255) NOT NULL DEFAULT '',
    phone           VARCHAR(60)  NOT NULL DEFAULT '',
    baud            INTEGER      NOT NULL DEFAULT 9600,

    -- Connectivity (parsed from flags)
    hostname        VARCHAR(255),     -- from INA: flag
    binkp_port      INTEGER,          -- from IBN or IBN:port flag (default 24554)
    telnet_port     INTEGER,          -- from ITN or ITN:port flag
    is_cm           BOOLEAN NOT NULL DEFAULT false,  -- Continuous Mail flag
    is_ip           BOOLEAN NOT NULL DEFAULT false,  -- IP-capable flag
    is_ibn          BOOLEAN NOT NULL DEFAULT false,  -- Binkp-capable flag

    -- Raw flags (preserved for display and future parsing)
    flags           TEXT NOT NULL DEFAULT '',

    -- Import metadata
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ,
    nodelist_date   VARCHAR(20),       -- e.g. 'Friday March 13, 2026' or Julian day
    nodelist_number INTEGER,           -- Julian day number from filename

    -- Historical tracking
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when this node first appeared in any import
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when it was last present in a nodelist
    removed_at      TIMESTAMPTZ,                         -- when it disappeared (null if still active)
    active          BOOLEAN NOT NULL DEFAULT true,       -- false = no longer in current nodelist

    UNIQUE (network_id, zone, net, node, point)
);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_ftn_nodelist_network_zone_net
    ON ftn_nodelist (network_id, zone, net);

CREATE INDEX IF NOT EXISTS idx_ftn_nodelist_network_zone_net_node
    ON ftn_nodelist (network_id, zone, net, node);

CREATE INDEX IF NOT EXISTS idx_ftn_nodelist_keyword
    ON ftn_nodelist (network_id, keyword)
    WHERE keyword IN ('Zone', 'Region', 'Host', 'Hub');
```

### Column rationale

**Address components** are stored as separate integers rather than a single string. This enables efficient range queries (find all nodes in net X), coordinator lookups (find the Host for net X = `WHERE keyword='Host' AND net=X`), and avoids string parsing at query time.

**`hub_node`** tracks which hub a regular node is under within its net. During import, whenever a `Hub,N` line is encountered, subsequent regular nodes in the same net are assigned `hub_node = N`. This is critical for the coordinator walk: if we need to route to 1:134/5, we first check if 1:134/5 has a hub, then try the hub before walking up to the host.

**`hostname` / `binkp_port` / `telnet_port`** are pre-parsed from the flags during import so lookups do not need to re-parse the flag string. The raw `flags` column is preserved for admin display and any future flag parsing needs.

**`is_cm` / `is_ip` / `is_ibn`** are denormalized booleans for fast filtering of dialable nodes.

**`nodelist_number`** stores the Julian day from the filename (`NODELIST.074` -> 74) to identify which edition is imported.

### Schema file

Add `ftn_nodelist` to `/home/kostie/canectic/db/schema/tables/tablenames.conf`.

---

## 2. Nodelist Parser Module

### File: `src/utils/nodelistParser.js`

A stateless parser that reads a nodelist text file and returns an array of parsed entry objects. Does not touch the database.

### Exported functions

```
parseNodelistFile(filePath)   -> Promise<{ entries: Array, errors: Array }>
parseNodelistText(text)       -> { entries: Array, errors: Array }
parseFlagString(flagsCsv)     -> { hostname, binkpPort, telnetPort, isCM, isIP, isIBN }
```

### Parsing logic

The parser maintains a context as it reads line by line:

- `currentZone` — set when a `Zone,N` line is encountered
- `currentRegion` — set when a `Region,N` line is encountered (reset on new Zone)
- `currentNet` — set when a `Host,N` line is encountered (reset on new Zone/Region)
- `currentHub` — set when a `Hub,N` line is encountered (reset on new Host)

For each non-comment, non-blank line:

1. Split on commas (fields 1-7 are positional; fields 8+ are capability flags)
2. Determine keyword from field 0 (empty string for regular nodes)
3. Determine the full address from context + number field
4. Parse capability flags for INA, IBN, ITN, CM, IP
5. Replace underscores with spaces in system_name, location, sysop_name
6. Emit an entry object

Comment lines start with `;`. Blank lines are skipped.

### Flag parsing rules

Flags appear as comma-separated values after the baud field (field index 7+). Key flags:

| Flag | Meaning | Parsing |
|------|---------|---------|
| `CM` | Continuous Mail | Set `is_cm = true` |
| `IP` | IP-capable | Set `is_ip = true` |
| `INA:host` | Internet address | Set `hostname = host` |
| `IBN` | Binkp capable, default port 24554 | Set `is_ibn = true`, `binkp_port = 24554` |
| `IBN:port` | Binkp capable, specific port | Set `is_ibn = true`, `binkp_port = port` |
| `ITN` | Telnet capable, default port 23 | Set `telnet_port = 23` |
| `ITN:port` | Telnet capable, specific port | Set `telnet_port = port` |

If no `INA:` flag is present but the phone field looks like a hostname (contains dots, no dashes in typical phone positions), some implementations treat it as a hostname. We will NOT do this — only `INA:` is authoritative for hostname resolution. The phone field is stored as-is.

### Edge cases

- Lines with keyword `Down`, `Hold`, or `Pvt` are imported with their keyword but will be excluded from routing queries (they are not dialable).
- Point lists (POINTLIST files) are not handled in Phase 1. Point entries within a standard nodelist (rare) would be parsed if present.
- Malformed lines increment the errors array but do not abort parsing.

---

## 3. Import Process

### Import paths (all converge on the same import logic)

1. **CLI tool** — `node src/tools/maintenance.js --import-nodelist --file /path/to/NODELIST.074 --network fidonet`
   Enqueues a `maintenance` job with `{ task: 'import-nodelist', file: '/path/...', networkDomain: 'fidonet' }`.

2. **Admin UI upload** — `POST /admin/nodelists/import` (multipart form, file + network selector)
   Saves uploaded file to a temp directory, enqueues the same maintenance job.

3. **Admin UI directory scan** — `POST /admin/nodelists/scan`
   Scans a configured directory (e.g., `ftn/nodelist/`) for the newest `NODELIST.*` per network, enqueues import jobs for any that are newer than the currently imported `nodelist_number`.

All imports are processed by the Worker via the existing `maintenance` BullMQ queue.

### Import worker logic

Located in `src/maintenance/nodelistImport.js`:

```
importNodelist(filePath, networkId, options)
```

1. Parse the file via `parseNodelistFile(filePath)` → array of node objects
2. If errors exceed a threshold (e.g., >5% of lines), abort with error
3. **Mark all existing nodes for this network as candidates for deactivation** (track which addresses we see)
4. For each parsed node:
   - **UPSERT**: `INSERT ... ON CONFLICT (network_id, zone, net, node, point) DO UPDATE SET` — updates system_name, location, sysop, hostname, flags, etc. Sets `last_seen = NOW()`, `active = true`, `removed_at = NULL`, `updated_at = NOW()`. Preserves `first_seen` (never overwritten).
   - Track the address as "seen in this import"
5. **Deactivate missing nodes**: `UPDATE ftn_nodelist SET active = false, removed_at = NOW() WHERE network_id = $1 AND active = true AND last_seen < $importTimestamp` — any node not touched by step 4 was absent from the new nodelist
6. Log summary: new nodes, updated nodes, deactivated nodes, time taken
7. Return `{ status: true, newNodes: N, updatedNodes: N, deactivatedNodes: N, errors: [...] }`

### Why upsert with historical tracking, not bulk replace

Nodelists are cumulative — each new edition is a complete snapshot. An upsert strategy preserves historical data:
- **`first_seen`** — when a system first appeared on the network (never overwritten)
- **`last_seen`** — refreshed on every import where the node is present
- **`removed_at`** — set when a node disappears, preserved on subsequent imports (only set once, when `active` transitions from true to false)
- **`active`** — quick filter for routing/lookup queries (only active nodes are considered)

This enables interesting stats: new systems per week, longest-running nodes, recently removed systems, churn tracking. The lookup API filters `WHERE active = true` so removed nodes don't affect routing.

### Batch upsert optimization

Rather than individual INSERT ... ON CONFLICT statements for 10K rows, batch the upserts in groups of 500 using multi-row INSERT statements. Each batch uses a single round-trip. The full import stays under a few seconds for a complete FidoNet nodelist.

---

## 4. Lookup / Query API

### File: `src/models/ftnNodelist.js`

Model providing query functions for the imported nodelist data.

### Core lookup functions (all filter `active = true`)

```javascript
// Exact node lookup (active only)
async function getNode(networkId, zone, net, node, point)
// SELECT ... WHERE network_id=$1 AND zone=$2 AND net=$3 AND node=$4 AND point=$5 AND active=true

// Find the coordinator for a net (Host keyword)
async function getNetHost(networkId, zone, net)
// SELECT ... WHERE network_id=$1 AND zone=$2 AND net=$3 AND keyword='Host' AND active=true

// Find the hub for a node (if assigned)
async function getNodeHub(networkId, zone, net, hubNode)
// SELECT ... WHERE network_id=$1 AND zone=$2 AND net=$3 AND node=$4 AND keyword='Hub' AND active=true

// Find the region coordinator
async function getRegionCoord(networkId, zone, region)
// SELECT ... WHERE network_id=$1 AND zone=$2 AND net=$3 AND keyword='Region' AND active=true

// Find the zone coordinator
async function getZoneCoord(networkId, zone)
// SELECT ... WHERE network_id=$1 AND zone=$2 AND keyword='Zone' AND active=true

// --- Historical queries ---

// Recently added nodes
async function getRecentlyAdded(networkId, sinceDays)
// SELECT ... WHERE network_id=$1 AND first_seen > NOW() - interval '$2 days' AND active=true ORDER BY first_seen DESC

// Recently removed nodes
async function getRecentlyRemoved(networkId, sinceDays)
// SELECT ... WHERE network_id=$1 AND removed_at > NOW() - interval '$2 days' AND active=false ORDER BY removed_at DESC

// Longest-running nodes
async function getLongestRunning(networkId, limit)
// SELECT ... WHERE network_id=$1 AND active=true ORDER BY first_seen ASC LIMIT $2

// Network stats
async function getNetworkStats(networkId)
// Returns: { totalActive, totalInactive, addedThisWeek, removedThisWeek, oldestNode }

// Check if a node is dialable (has hostname + binkp, is CM, not Down/Hold/Pvt)
async function isDialable(networkId, zone, net, node)
// Returns: { dialable: boolean, hostname, port, method }

// System info lookup (for display)
async function getSystemInfo(networkId, zone, net, node)
// Returns: { systemName, sysopName, location, flags }

// Import metadata
async function getImportStatus(networkId)
// Returns: { imported_at, nodelist_number, entry_count }
```

### Dialability rules

A node is dialable for binkp if ALL of:
- `keyword` is NOT `Down`, `Hold`, or `Pvt`
- `is_ibn = true` (has IBN flag)
- `hostname IS NOT NULL` (has INA: flag)

A node is preferred for immediate connection if additionally:
- `is_cm = true` (always available)

Non-CM nodes may only be available during specific hours (Zone Mail Hour). For Phase 1, we treat all IBN+INA nodes as dialable and note the CM status in the route result for the caller to decide.

### Address-to-network resolution

When `ftnRouter` needs to look up a destination, it needs to know which `network_id` to query. This is resolved from the destination address context:

- For outbound echomail/netmail, the tosser already knows the `network_id` from the area's network mapping or the netmail's destination address + domain.
- For mailer-initiated lookups, the system address's `network_id` is used.
- As a fallback, query all FTN networks and match by zone ranges (each FTN network typically operates in specific zones).

---

## 5. Integration with ftnRouter.js

The routing cascade in `ftnRouter.resolveRoute()` currently has stubs for steps 3 and 4. Here is how they will be implemented:

### Step 3: Nodelist direct lookup

After the routing rule check fails, query the nodelist for the exact destination:

```
1. Determine network_id(s) for the destination address
   - Check all active FTN connections to find which networks cover this zone
   - Or accept an optional networkId parameter from the caller

2. Call ftnNodelist.getNode(networkId, zone, net, node, 0)

3. If found AND dialable (has hostname + IBN, not Down/Hold/Pvt):
   Return routeResult {
     nextHop:        destinationAddress,
     connectionUUID: null,           // no peer_connection — ephemeral
     connectionId:   null,
     method:         'nodelist_direct',
     flavour:        'Normal',
     ruleMatched:    null,
     nodelistData: {                 // new field for mailer use
       hostname:    entry.hostname,
       binkpPort:   entry.binkp_port,
       systemName:  entry.system_name,
       isCM:        entry.is_cm
     }
   }
```

The `nodelistData` field is a new addition to the routeResult shape. It provides the mailer with the connection parameters it needs when there is no peer_connection record to read `remote_host`/`remote_port` from.

### Step 4: Coordinator walk

If the direct nodelist lookup fails (destination not in nodelist, or not dialable), walk up the hierarchy:

```
Walk order:
  a. Hub — if the destination node has hub_node set, look up that hub
  b. Host — net coordinator (keyword='Host', net=destination_net)
  c. Region — region coordinator (keyword='Region')
  d. Zone — zone coordinator (keyword='Zone')

At each level:
  1. Check if we have a peer_connection for that coordinator's address
     (direct connection check, same as step 1)
  2. If no connection, check if the coordinator is dialable in the nodelist
     (same as step 3 logic)
  3. If dialable, return routeResult with method='coordinator',
     nextHop = coordinator's address, nodelistData from nodelist entry
  4. If not dialable, continue to next level
```

The walk needs to determine the region for the destination's net. This requires knowing which region a net belongs to. In the nodelist, the region is established by the `Region,N` keyword that precedes the `Host` entries. During import, we could store a `region` column on each entry, or we can query:

```sql
-- Find the region that contains net N in zone Z
-- Region coordinators appear as keyword='Region' with their net = region number
-- The nets listed after a Region belong to that region until the next Region/Zone
```

This is tricky to query after import because the region<->net mapping is positional in the file, not explicit. **Solution:** Add a `region` column to `ftn_nodelist` and populate it during import (the parser already tracks `currentRegion`). This makes the region coordinator lookup trivial: `WHERE keyword='Region' AND net=entry.region AND zone=entry.zone`.

### Updated schema addition

```sql
    region          INTEGER,          -- region number this entry belongs to
```

Populated during import from the parser's `currentRegion` context.

### resolveRoute signature change

The existing `resolveRoute(destinationAddress)` takes only a string. For nodelist lookups, it needs to know which network to search. Two options:

**Option A: Infer network from connections.** The function already loads all active FTN connections. Each connection has a `network_id`. If the destination zone appears in any connection's address zone, use that network. This works for the common case (single FTN network per zone) but breaks if multiple FTN networks share zones.

**Option B: Accept optional networkId parameter.** `resolveRoute(destinationAddress, networkId)`. The caller can pass the network context when known. Falls back to Option A inference when not provided.

**Recommendation: Option B.** The tosser and netmail sender both know the network context. The parameter is optional for backward compatibility.

---

## 6. Integration with Mailer Outbound Resolution

Currently, `MailerManager._connectToPeer(conn)` reads host/port from `connection_data.remote_host` / `connection_data.remote_port`. This works for configured peer connections but not for nodelist-resolved routes.

### Changes needed in MailerManager

When the mailer needs to connect for a `nodelist_direct` or `coordinator` route, the routeResult has `connectionUUID: null` and carries `nodelistData` instead. The mailer needs a new code path:

```
1. If routeResult.connectionUUID exists:
   Use existing _connectToPeer(conn) path — host/port from connection_data

2. If routeResult.nodelistData exists:
   Connect to nodelistData.hostname:nodelistData.binkpPort
   No session password (nodelist connections are typically unsecured or use
   CRAM-MD5 with empty password)
   Session controller runs in 'caller' mode without a connectionUUID
```

### Session password for nodelist connections

When connecting to a system found only in the nodelist (no peer_connection record), there is no session password. The binkp handshake should present `-` (empty password) or attempt CRAM-MD5 with an empty secret. Most modern binkp implementations accept unsecured sessions for the initial handshake.

### Inbound matching for nodelist-known systems

Currently, `SessionController._matchPeer()` only matches against configured peer_connections. A system found in the nodelist but without a peer_connection record will fail inbound authentication. This is acceptable for Phase 1 — inbound connections should come from configured peers. A future enhancement could auto-create temporary peer records for nodelist-known systems.

---

## 7. Multi-Network Nodelist Handling

### Network-scoped nodelists

Each FTN network has its own nodelist. The `network_id` column in `ftn_nodelist` scopes all entries to a specific `message_networks` record. This means:

- FidoNet's NODELIST.074 imports with `network_id` pointing to the FidoNet network
- fsxNet's NODELIST.074 imports with `network_id` pointing to the fsxNet network
- Imports are independent — reimporting one network does not affect others
- Lookups always include `network_id` in the WHERE clause

### Network configuration

Add a `nodelist_config` field to the `message_networks.config` JSONB (which already exists) for FTN networks:

```json
{
  "nodelist_dir": "ftn/nodelist/fidonet",
  "nodelist_prefix": "NODELIST",
  "auto_import": true
}
```

- `nodelist_dir` — directory to scan for nodelist files for this network
- `nodelist_prefix` — filename prefix (some networks use different names, e.g., `FSXNET`)
- `auto_import` — whether the scheduled maintenance job should auto-import new nodelists

### Zone-to-network mapping

When `ftnRouter` needs to look up a destination without explicit network context, it needs to know which network "owns" a given zone. This can be resolved by:

1. Querying `system_addresses` for active FTN addresses — each has a zone, and belongs to a network
2. As a fallback, querying `ftn_nodelist` for `keyword='Zone'` entries grouped by network

For Phase 1, the explicit `networkId` parameter on `resolveRoute()` handles this cleanly.

---

## 8. Admin UI

### Nodelist management page: `/admin/nodelists`

Route: `src/routes/admin.js` (add section) or `src/routes/adminNodelists.js` (new file, mounted at `/admin/nodelists`).
View: `src/views/admin/nodelists.pug`

### Page layout

Follows the existing admin pattern (DataTables, modals, card layout).

**Summary cards** (one per FTN network with nodelist data):
- Network name and domain
- Nodelist edition (Julian day number)
- Import date
- Entry count
- "Re-import" and "Upload new" buttons

**Import modal:**
- Network selector (dropdown of active FTN networks)
- File upload input (accepts `.???` nodelist files)
- Submit button enqueues maintenance job
- Progress indicator (optional, via Redis pub/sub)

**Browse/search section:**
- Network selector filter
- Search by address (zone:net/node), system name, or sysop name
- DataTable with columns: Address, System Name, Sysop, Location, Keyword/Role, Hostname, Flags
- Row click shows detail modal with all fields

**Detail modal:**
- Full node information
- Connectivity status (dialable yes/no, hostname, ports)
- Role in hierarchy (zone/region/net/hub/regular)
- Link to create a peer connection from this nodelist entry (pre-fills address, hostname, port)

### "Create Connection from Nodelist" flow

When the admin finds a system in the nodelist browser and wants to set up a peer connection, a button pre-fills the new-peer-connection form with:
- Address from nodelist entry
- Remote host from `hostname`
- Remote port from `binkp_port`
- System name as suggested peer name

This is a convenience feature for Phase 2.

---

## 9. Implementation Phases

### Phase 1: Core Import and Lookup (Priority: HIGH)

**Goal:** Import nodelists into the database and make them queryable by the router and mailer.

1. Create `ftn_nodelist` table (add to schema, bootstrap SQL in startup or migration)
2. Write `src/utils/nodelistParser.js` — parser module
3. Write `src/maintenance/nodelistImport.js` — import worker
4. Wire import task into `maintenance` queue handler in Worker
5. Add `--import-nodelist` flag to `src/tools/maintenance.js` CLI
6. Write `src/models/ftnNodelist.js` — lookup model with core query functions
7. Write tests for parser (nodelist format edge cases) and lookup functions

**Deliverables:** Can import a nodelist via CLI and query it programmatically.

### Phase 2: Router Integration (Priority: HIGH)

**Goal:** Complete the ftnRouter cascade with nodelist steps 3 and 4.

1. Implement Step 3 (nodelist direct) in `ftnRouter.resolveRoute()`
2. Implement Step 4 (coordinator walk) in `ftnRouter.resolveRoute()`
3. Add optional `networkId` parameter to `resolveRoute()`
4. Add `nodelistData` field to routeResult shape
5. Update `ftnTosser.js` outbound to pass `networkId` when calling `resolveRoute()`
6. Update netmail outbound to pass `networkId`
7. Test routing with real nodelist data

**Deliverables:** Outbound netmail can route through the FTN hierarchy via nodelist data.

### Phase 3: Mailer Integration (Priority: MEDIUM)

**Goal:** Mailer can connect to systems resolved from the nodelist.

1. Add nodelist-resolved connection path in `MailerManager`
2. Handle `nodelistData` in routeResult for outbound connections
3. Implement unsecured/empty-password session handling
4. Test outbound mailer session to a nodelist-only system

**Deliverables:** Mailer can dial systems not in peer_connections, using nodelist data.

### Phase 4: Admin UI (Priority: MEDIUM)

**Goal:** Admin can manage nodelists through the web interface.

1. Create admin route and view for nodelist management
2. File upload and import trigger
3. Browse/search DataTable
4. Import status display per network
5. "Create connection from nodelist" convenience button (pre-fills peer form)

**Deliverables:** Full admin UI for nodelist lifecycle management.

### Phase 5: Auto-Import and Directory Scan (Priority: LOW)

**Goal:** Nodelists are automatically imported when new editions arrive.

1. Add `nodelist_config` to `message_networks.config` JSONB for FTN networks
2. Implement directory scan logic — find newest nodelist file by Julian day
3. Add scheduled maintenance job (weekly, via BullMQ repeatable) to scan and import
4. Admin UI toggle for auto-import per network

**Deliverables:** Hands-off nodelist updates for active FTN networks.

### Phase 6: Nodelist Diff Support (Priority: LOW)

**Goal:** Apply nodelist diffs instead of requiring full nodelist files.

1. Parse diff format (ADD/DELETE/CHANGE operations keyed by line CRC)
2. Apply diffs to existing imported data
3. Track which diffs have been applied (by day number)

**Deliverables:** Support incremental nodelist updates. This is a nice-to-have — most sysops have access to full weekly nodelists.

---

## Documentation Updates Required

When implementation begins:

- **`NETWORKING_ARCHITECTURE.md`** — Update the FTN Routing section to document completed steps 3 and 4. Add `nodelistData` to routeResult shape documentation. Add ftn_nodelist to the database schema section.
- **`MAILER_ARCHITECTURE.md`** — Add section on nodelist-resolved outbound connections and the no-peer-connection session path.
- **`PROCESS_ARCHITECTURE.md`** — Add `import-nodelist` to the maintenance queue task list.
- **`db/schema/tables/tablenames.conf`** — Add `ftn_nodelist`.

---

## Appendix: Nodelist Format Quick Reference

```
;
; Zone 1 nodelist for Friday March 13, 2026 -- Day number 072
;
Zone,1,North_America,Calgary_AB,Kostie_Muirhead,1-403-555-1234,9600,CM,INA:bbs.example.com,IBN
Region,10,Western_Canada,Calgary_AB,Kostie_Muirhead,-Unpublished-,9600,CM
Host,134,My_Net,Calgary_AB,Kostie_Muirhead,-Unpublished-,9600,CM,INA:hub.example.com,IBN
,1,My_BBS,Calgary_AB,Kostie_Muirhead,-Unpublished-,9600,CM,INA:mybbs.example.com,IBN:24554
Hub,100,Hub_System,Calgary_AB,Kostie_Muirhead,-Unpublished-,9600,CM,INA:hub.example.com,IBN
,101,Under_Hub,SomeCity,Some_Sysop,-Unpublished-,9600,CM,INA:under.example.com,IBN
Down,2,Down_System,Calgary_AB,Kostie_Muirhead,-Unpublished-,9600
Hold,3,Hold_System,Calgary_AB,Kostie_Muirhead,-Unpublished-,9600
Pvt,4,Pvt_System,Calgary_AB,Kostie_Muirhead,-Unpublished-,9600
```

**Address derivation from the above:**
- `Zone,1` -> 1:0/0 (zone coordinator), sets currentZone=1
- `Region,10` -> 1:10/0 (region coordinator), sets currentRegion=10
- `Host,134` -> 1:134/0 (net host), sets currentNet=134, currentHub=null
- `,1` -> 1:134/1 (regular node), hub_node=null
- `Hub,100` -> 1:134/100 (hub), sets currentHub=100
- `,101` -> 1:134/101 (regular node), hub_node=100
- `Down,2` -> 1:134/2 (down node), hub_node=100
- `Hold,3` -> 1:134/3 (hold node), hub_node=100
- `Pvt,4` -> 1:134/4 (private node), hub_node=100

**Fields (comma-separated):**
1. Keyword (or empty)
2. Number
3. System name (underscores = spaces)
4. Location (underscores = spaces)
5. Sysop name (underscores = spaces)
6. Phone number or `-Unpublished-`
7. Baud rate
8+. Capability flags (comma-separated)
