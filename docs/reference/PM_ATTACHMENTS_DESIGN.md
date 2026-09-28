# PM Attachment Design

**Status: implemented** (`src/models/pmAttachments.js`, with the pipeline pieces below). This is the original design; where the implementation differs it is noted inline. `PM_ARCHITECTURE.md` "Attachments" describes what runs, including FTN file-attach and QWK personal packets, which this design did not cover.

File attachments for private messages. Stored on disk, linked via `pm_attachments` table, served through IMAP MIME multipart, web download links, and SMTP relay.

## Schema

### pm_attachments table

```sql
CREATE TABLE IF NOT EXISTS pm_attachments (
    id SERIAL PRIMARY KEY,
    message_uuid VARCHAR(64) NOT NULL,
    message_table VARCHAR(16) NOT NULL,  -- 'inbox' or 'outbox'
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(128) DEFAULT 'application/octet-stream',
    file_size BIGINT DEFAULT 0,
    storage_path VARCHAR(512) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

Linked by `message_uuid` rather than foreign key ID so attachments work across inbox/outbox/undeliverable without complex FK chains. Index on `(message_uuid, message_table)`, plus one on `message_uuid` alone. Implemented as written, created by `pmAttachments.ensureTable()` rather than `db/schema` (and `message_table` defaults to `'inbox'`).

### pm_inbox / pm_outbox

Add `has_attachments BOOLEAN DEFAULT false` to both tables for fast filtering without joining. (Done: in `db/schema/tablecolumns/pm_inbox.conf` / `pm_outbox.conf`, and also added by `ensureTable()`.)

## Storage

Attachments stored at: `{pm_attachment_dir}/{YYYY-MM}/{uuid}/{filename}`

- `pm_attachment_dir` config key (default: `files/pm_attachments`)
- Monthly subdirectory prevents flat directory bloat
- UUID subdirectory per message groups its attachments
- Original filename preserved (sanitised: strip path separators, limit length). As built, `_sanitizeFilename` replaces `/ \ :` and NUL with `_` and caps at 200 characters; a name already in the directory gets `_1`, `_2` and so on

## Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pm_attachment_dir` | string | `files/pm_attachments` | Storage directory for PM attachments (category `paths`; the two limits are under `security`) |
| `pm_max_attachment_size` | number | `10485760` | Max attachment size in bytes (default 10MB) |
| `pm_max_attachments` | number | `5` | Max attachments per message |

## Pipeline

### Inbound SMTP

`smtpServer.js` `_parseMessage()` currently extracts text/plain and text/html, discarding other parts.

Changes:
1. When parsing multipart, collect non-text parts with Content-Disposition: attachment (or non-text Content-Types)
2. For each attachment: decode content (base64/quoted-printable), extract filename from Content-Disposition or Content-Type name parameter
3. Pass attachment array to the delivery function: `[{ filename, mimeType, data: Buffer }]`
4. In `deliverMessage()`, if attachments present: write files to storage, create `pm_attachments` rows, set `has_attachments = true`

### Inbound IMAP (APPEND)

Not supported for attachments. As built, `_cmdAppend` accepts and discards the appended message entirely (SMTP submission has already stored it), so nothing is extracted from an APPEND.

### Outbound SMTP Relay

`emailTosser.js` builds nodemailer `mailOptions` with text + html. 

Changes:
1. Query `pm_attachments` for the outbox message UUID
2. For each attachment, add to `mailOptions.attachments[]`: `{ filename, path: storagePath, contentType: mimeType }`
3. Nodemailer handles MIME encoding automatically

### IMAP FETCH

`imapServer.js` returns hardcoded `BODYSTRUCTURE ("TEXT" "PLAIN" ...)`.

Changes:
1. **BODYSTRUCTURE**: When `has_attachments`, return `multipart/mixed` structure:
   ```
   (("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "8BIT" <size> <lines>)
    ("APPLICATION" "OCTET-STREAM" ("NAME" "file.pdf") NIL NIL "BASE64" <size>)
    "MIXED")
   ```
2. **BODY[]**: `renderRfc2822()` in imapAdapter builds full multipart/mixed message with boundary, text part + base64-encoded attachment parts
3. **BODY[1]**: Return text body only
4. **BODY[2]** etc: Return individual attachment parts (base64 encoded)

### RFC 2822 Rendering (imapAdapter.js)

Current `renderRfc2822()` returns text/plain or multipart/alternative (text + html).

Changes when attachments exist:
```
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="----=_Part_abc123"

------=_Part_abc123
Content-Type: multipart/alternative; boundary="----=_Alt_def456"

------=_Alt_def456
Content-Type: text/plain; charset=utf-8

<body text>
------=_Alt_def456
Content-Type: text/html; charset=utf-8

<body html>
------=_Alt_def456--
------=_Part_abc123
Content-Type: application/pdf; name="file.pdf"
Content-Disposition: attachment; filename="file.pdf"
Content-Transfer-Encoding: base64

<base64 data>
------=_Part_abc123--
```

### Web Compose

`pm.js` routes currently use `bodyParser.urlencoded`. 

Changes:
1. Add multer middleware for file uploads on compose/reply routes (as built: `pmUpload.array('attachments', 5)` on `/pm/compose/local`, `/pm/compose/network` and `/pm/reply/:uuid`)
2. Accept `files[]` input alongside body text (the field is named `attachments`)
3. Validate: size < `pm_max_attachment_size`, count <= `pm_max_attachments`
4. Store files, create attachment rows, set `has_attachments` on the message
5. For LOCAL delivery: attachments stored once, referenced by both outbox and inbox message UUIDs (as built: `copyAttachmentsToInbox()` adds inbox rows pointing at the same `storage_path`)
6. For network delivery: attachments queued with the outbox message

### Web View

PM detail view (`/pm/inbox/:uuid`) shows message body. As built, the inbox page's reader pane also lists attachments from the `attachments` array in `/pm/inbox/:uuid/json` and `/pm/sent/:uuid/json`.

Changes:
1. Query `pm_attachments` for the message UUID
2. Display attachment list with filename, size, download link
3. Download route: `/pm/attachment/:id`: validates user owns the message, streams the file (as built, it also refuses rows whose message is purged)

### Terminal

Terminal PM reader shows text body. No file download capability.

Change: When `has_attachments`, append a line to the displayed body:
```
[Attachments: file.pdf (24 KB), image.png (156 KB)]
```

As built, the line is fixed text without names or sizes: `[Attachments available -- use web or IMAP to download]`.

Users can access attachments via IMAP client or web.

## Cleanup

When PMs are hard-deleted (trash purge), delete associated attachment files from disk and `pm_attachments` rows. As built there is no `purgeTrash()`: the retention sweep (`purgeDeleted`, job `purge-pm-trash`) only tags rows `purged`, and `executePurgedCleanup()` (job `pm-purged-cleanup`) calls `pmAttachments.deleteAttachments(uuid)`, which unlinks a file only when no other row references its `storage_path`. See `PM_ARCHITECTURE.md` "Soft Delete, Trash, and Two-Stage Hard Delete".

## Implementation Order

1. Schema: `pm_attachments` table, `has_attachments` column on inbox/outbox
2. Config keys: `pm_attachment_dir`, `pm_max_attachment_size`, `pm_max_attachments`
3. Attachment model: CRUD, file storage/retrieval, cleanup
4. SMTP inbound: MIME attachment extraction in `_parseMessage()`
5. PM delivery: attachment storage in `deliverMessage()`
6. Web compose: multer upload, attachment creation
7. Web view: attachment list, download route
8. IMAP BODYSTRUCTURE + FETCH: multipart MIME rendering
9. Outbound email: nodemailer attachments
10. Terminal: attachment indicator in body text
11. Trash cleanup: delete files on purge
