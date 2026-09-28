# Hub / Network Coordinator Design

Design for FTN network hub and coordinator functionality. Enables Canectic to serve as a Hub, Network Coordinator (NC), Region Coordinator (RC), or Zone Coordinator (ZC) for FTN-style networks.

**Status (checked against the code 2026-09-27):** Largely implemented. The nested segment model, managed nodes, stub generation and distribution, scheduled stub generation, on-demand nodelist compilation and the admin UI (`/admin/coordinator/:networkId`) exist. Not implemented: parsing a received external stub into a node list (it is shown as raw text only), a UI for `coordinator_roles`, scheduled compilation, a true netmail file-attach, and everything under Future Considerations. Code: `src/models/coordinatorSegments.js`, `src/models/managedNodes.js`, `src/models/nodelistFlags.js`, `src/maintenance/stubDistribution.js`, `src/maintenance/nodelistCompiler.js`, routes in `src/routes/admin.js`.

## Motivation

Sysops who coordinate network segments need tools to manage their nodes, produce nodelist stubs, compile nodelists from downstream stubs, and distribute the results. Currently this requires external tools. Building it into Canectic provides a unified workflow: manage nodes, generate stubs, distribute via the existing mailer/TIC infrastructure.

Primary use case: Network Coordinator for FidoNet Net 134.

---

## Current State (Implemented)

Nested segment model is implemented. Segments form a tree (parent/child), support internal/external sources, and per-network role configuration.

What exists:
- `coordinator_segments` table with `parent_segment_id`, `source`, `stub_file_area`, `depth`
- `managed_nodes` table -- nodes with segment_id
- Per-network `coordinator_roles` config (ordered array in network JSONB, defaults to `['ZC', 'RC', 'NC', 'Hub']`). Read by `getRolesForNetwork()`; nothing in the admin UI sets it, so every network uses the default unless the JSONB is edited directly
- Internal segments: managed nodes edited by sysop, stub generation, distribution
- External segments: read-only, content from received stub files in configured file area
- Tree-recursive nodelist compilation (internal = generate from nodes, external = read stub file), run on demand by the Compile button (`POST /admin/coordinator/:networkId/compile`, maintenance job `compile-nodelist`); it has no schedule
- Stub distribution via filebox, BSO flow files, or manual download (see Distribution)
- Scheduled stub generation via cron patterns (schedule `generate-stub:<segmentId>`, job `generate-stub`)
- Nodelist flag definitions in `nodelist_flag_definitions` (`src/models/nodelistFlags.js`, seeded from `config/default/nodelist-flags.json`, admin `/admin/nodelist-flags`), which drive the node editor's flag checkboxes; flags marked `auto_managed` are shown disabled, not editable
- Admin UI: tree view with indentation, source badges, context-aware Add Child with role defaults
- Node editor: role-aware keyword filtering, auto-populated zone/net from segment, hub routing dropdown, flag checkboxes with progressive disclosure

---

## REDESIGN: Nested Segment Model

### Problem

A sysop often holds multiple coordinator roles simultaneously:
- NC for Net 134 (manages individual nodes)
- Hub 120 within Net 134 (subset of nodes routing through them)
- RC for Region 12 (manages nets, receives stubs from NCs)

The flat model can't represent:
- Parent/child relationships between segments
- Which entries are internally managed vs received from external sources
- The hierarchical compilation order (Zone > Region > Net > Hub > Node)

### Nested Segment Hierarchy

```
Network: FidoNet
  └── Zone 1 (ZC role) ← manages regions
       ├── Region 12 (RC role) ← manages nets
       │    ├── Net 134 (NC role) ← manages nodes [INTERNAL]
       │    │    ├── Hub 120 (Hub role) ← manages hub downlinks [INTERNAL]
       │    │    │    ├── Node 121 [INTERNAL]
       │    │    │    └── Node 122 [INTERNAL]
       │    │    ├── Node 101 [INTERNAL]
       │    │    └── Node 102 [INTERNAL]
       │    ├── Net 135 [EXTERNAL - received stub from NC]
       │    └── Net 140 [EXTERNAL - received stub from NC]
       ├── Region 13 [EXTERNAL - received stub from RC]
       └── Region 18 [EXTERNAL - received stub from RC]
```

### Schema Changes

**`coordinator_segments` -- add hierarchy and source tracking:**

| Column | Type | Description |
|--------|------|-------------|
| `parent_segment_id` | INTEGER | FK to parent segment (null = top-level for this network) |
| `source` | VARCHAR(16) | `internal` (we manage it) or `external` (received stub) |
| `stub_file_area` | VARCHAR(255) | File area where this external segment's stubs arrive |
| `depth` | INTEGER | 0 = top-level, 1 = child, etc. (denormalized for query convenience) |

Existing columns remain. `role` determines what kind of entries this segment contains:
- **ZC**: children are Region segments
- **RC**: children are Net (Host) segments  
- **NC**: children are Hub segments (optional), and individual systems below those
- **Hub**: the systems routing through this hub

**`managed_nodes` -- unchanged.** Nodes still belong to a segment via `segment_id`. The hierarchy is in the segments, not the nodes.

### Internal vs External Segments

- **Internal**: sysop directly manages the nodes/entries. CRUD enabled. Stub is generated from managed_nodes.
- **External**: represents a downstream coordinator's segment. Read-only in terms of node editing. Content comes from received stub files. Sysop can see the nodes but doesn't edit them directly.

When compiling, internal segments generate from managed_nodes; external segments pull from their latest received stub file.

### Compilation Walk

```
compileNodelist(topSegmentId):
  1. Emit header comments
  2. For this segment:
     a. If INTERNAL: generate from managed_nodes
     b. If EXTERNAL: read latest stub from stub_file_area
  3. For each child segment (ordered by role priority, then net/region number):
     a. Recurse: compileNodelist(childSegmentId)
  4. Return accumulated lines
```

This naturally produces the correct FTN ordering: Zone line, then Regions, then Nets within each region, then Hubs and nodes within each net.

### Admin UI Redesign

**Coordinator overview (`/admin/coordinator/:networkId`):**

Tree view instead of flat card list. Each segment shows:
- Role badge, address (zone:net or zone:region), name
- Source badge (Internal/External)
- Node/child count
- Expand to see children
- Action buttons: Add Child, Edit, Nodes, Preview, Send

**Adding a child segment:**
- Context-aware: if parent is RC, new child defaults to NC role with Host keyword
- If parent is NC, new child defaults to Hub role
- If parent is ZC, new child defaults to RC role
- Source selector: Internal (I manage this) or External (I receive stubs for this)

**External segment management:**
- Configure which file area receives stubs for this segment (falls back to the network's `stub_intake_area`)
- View the latest received stub content (read-only)
- Import: parse a received stub file and display the nodes it contains (not implemented; the stub is shown as raw text)

**Node editing (internal segments only):**
- Auto-populate zone/net/region from the segment context
- Keyword limited to what makes sense for the segment role
- Hub routing dropdown lists existing Hub children of the parent NC segment
- Flag checkboxes for common flags + text field for custom
- Progressive disclosure: address > system info > connectivity > flags

### Migration Path

The existing flat data can migrate to nested:
1. Each existing segment becomes a top-level internal segment
2. Existing managed_nodes retain their segment_id
3. No data loss -- just adding parent_segment_id (nullable) and source columns

---

## Distribution (Implemented)

### Stub distribution (to upstream)

When a stub changes, send it to the upstream coordinator:

The segment's `distribution_method` is one of `manual`, `filebox`, `tic` or `netmail_attach` (`src/maintenance/stubDistribution.js`):

| Method | How |
|--------|-----|
| `filebox` | Copy into the upstream connection's `outbox_dir` (sent on next session) |
| `tic` | Despite the name, no TIC is written: the stub is staged in the zone-aware outbound dir with a `.flo` entry, then a BSO scan is enqueued |
| `netmail_attach` | Not a real file-attach yet: falls back to the same `.flo` staging as `tic`, addressed to `upstream_address` |
| `manual` | Generate for download only |

### Scheduled generation

Cron pattern on each segment (`schedule`, default `manual`, which registers nothing). Registered at gateway startup as `generate-stub:<segmentId>` schedulers, which are in the managed set and so pruned when a segment is removed or set back to manual. "Send" button (`POST /admin/coordinator/segment/:segmentId/generate`) for on-demand generation.

---

## Network Config Fields (on message_networks.config JSONB)

| Field | Description |
|-------|-------------|
| `nodelist_area_shortcode` | File area for nodelist auto-import |
| `echolist_area` | File area for echolist files |
| `filebone_area` | File area for filebone files |
| `infopack_area` | File area for network infopack ZIPs |
| `stub_intake_area` | File area where downstream stubs arrive (for compilation); fallback for an external segment with no `stub_file_area` |
| `coordinator_roles` | Ordered role list for the segment tree (no UI; default `['ZC', 'RC', 'NC', 'Hub']`) |

---

## UX Improvements (mostly implemented)

Implemented in `src/views/admin/coordinator/nodes.pug`: keyword choices limited by segment role, hub routing dropdown, flag checkboxes driven by `nodelist_flag_definitions`, phone default `-Unpublished-`, baud default 300 (schema default on `managed_nodes`), and a tabbed identity/system/connectivity/flags editor. Not checked item by item against the list below.

### Hierarchy-aware node editing

The node editor adapts based on the segment's role:

- **NC role**: auto-fills zone/net from segment, only asks for node number. Keyword choices limited to Hub, normal, Down, Hold, Pvt. Hub routing dropdown lists existing Hub nodes in the segment.
- **RC role**: primary entries are `Host` lines (net coordinators). Adding a Host entry represents adding a net to the region. Individual nodes under each net are secondary.
- **ZC role**: primary entries are `Region` lines. Each region contains Host/net entries.
- **Hub role**: auto-fills zone/net/hub_node from segment. Only manages nodes that route through this hub.

### Modal improvements

- Auto-populate zone/net/region from segment (read-only unless overridden)
- Keyword selector with descriptions ("Normal Node", "Hub (routes other nodes through this system)", "Down (temporarily offline)")
- Hub routing as a dropdown of existing Hub nodes in the segment (not a raw number)
- Common flags as checkboxes (CM, IBN, ITN, IP, MO) with a text field for additional custom flags
- Show/hide binkp/telnet port fields based on whether hostname is filled
- Auto-check IBN flag when hostname is provided
- Phone defaults to `-Unpublished-` (collapsed behind "show" link)
- Baud defaults to 300 (collapsed behind "advanced" toggle)
- Step-by-step: address first, then system info, then connectivity, then flags

---

## Future Considerations

- **Nodediff generation**: produce diffs between nodelist versions for bandwidth-efficient distribution
- **Application processing**: nodes apply to join via netmail or web form, coordinator approves
- **Echolist coordination**: similar stub/compile pattern for BACKBONE.NA maintenance
- **Statistics**: node uptime tracking, connection success rates from mailer session history
- **Integration with bad_echo_tags**: suggest which areas nodes in your net are missing
