# Canectic Network (CTN) — Forward-Looking Design Notes

This document captures design ideas for a Canectic-native networking layer, a tentative "CTN" (Canectic Transport Network) spec. CTN is not implemented; this file exists to preserve design decisions that came out of FTN compatibility discussions so the ideas aren't lost when we circle back.

## Intent

Canectic today speaks FTN (FidoNet), QWK, and NNTP, and those implementations are held to strict compatibility with the historical specs (FTS-0001, FTS-0004, FTS-0009, FSC-0039, etc.). This is the right call for interop with the surviving networks — FidoNet, fsxNet, Micronet, tqwNet, Agoranet, and their peers — because the rest of the ecosystem expects it.

CTN is the name I'm tentatively using for a **Canectic-native networking layer** that would be:

- **Mostly backwards compatible with FTN at the wire level** — same packet framing, same address format, same routing concepts, same kludge syntax. A CTN-emitting system should still be intelligible to an FTN-only receiver in most common cases.
- **Deliberately modern in the corners where the 80s spec limits modern capability** — cases where the historical wording made sense in 1989 but no longer serves an active system in 2026. This includes things like MSGID encoding, area naming, message body encoding, large-file handling in netmail, and TLS negotiation at the mailer layer.
- **Opt-in at the peer level** — a CTN-capable link is negotiated between two consenting Canectic systems. Peers who haven't opted in continue to see strict FTN-compliant output.

CTN is not a break from FTN. It's a carefully negotiated extension set that Canectic and other consenting implementations can use when both sides agree, falling back to strict FTN when either side doesn't support the extension. This is the same pattern HTTP used for HTTP/2 negotiation, or SMTP uses for STARTTLS — you stay wire-compatible with the previous generation and upgrade when both parties agree.

## Status

**Nothing in this document is implemented.** It exists to capture design thinking that surfaced during other work so we can come back to it later without re-deriving it. Expect everything here to change.

## Preserved ideas

### MSGID encoding: base36 with time-dominant layout

This came out of a discussion about fixing the FTS-0009 MSGID serial implementation in Canectic's core. FTS-0009 specifies the serial as "any eight character hexadecimal string" — exactly 32 bits. Canectic's current hex implementation lays that out as `(16 bits day | 16 bits counter)` with the counter backed by a `msgid_day_watermark` Postgres table (atomic UPSERT per allocation; Postgres handles cross-process coordination natively). The 32-bit budget is tight and leaves no room for a sub-day time resolution component or a process-ID tiebreaker — the counter is the only disambiguation mechanism within a day.

If CTN ever wants to relax the hex constraint (all modern FTN tossers in practice treat the serial as an opaque non-whitespace token after the address — none I tested actually validate strict hex), base36 is the natural extension. It uses `0-9a-z`, is case-insensitive, is a strict superset of hex, is accepted by every modern FTN tosser I've looked at, and has native Node.js support via `BigInt.toString(36)` and `parseInt(s, 36)` — no custom encoder.

8 base36 characters hold 36^8 = 2,821,109,907,456 distinct values — about 41.36 bits worth, or 9 more bits than hex's 32. Those 9 bits are exactly what we need to add sub-day time resolution (second-of-day) and a process-ID tiebreaker alongside the existing day-bucket field, making CTN MSGID generation fully process-local without needing any cross-process coordination layer at all (no Redis, no shared Postgres table). The hex FTS-compat scheme has to rely on atomic Postgres upserts for coordination because the 32-bit budget doesn't leave room for a process-ID field; CTN sidesteps that entirely with its larger address space.

#### B36-B layout (preferred for CTN)

```
Total: 41 bits packed into 8 base36 characters

bits 40-38  (3)  process ID        gateway=0, mail=1, mailer=2, worker=3, + 4 spare
bits 37-22 (16)  days since Canectic epoch      179 years from 1980-12-08 UTC
bits 21- 5 (17)  seconds within day             0 to 86399 (full wall-clock second)
bits  4- 0  (5)  per-process per-second counter 32 burst tiebreaker
```

**Properties:**

| Property | Value |
|---|---|
| Horizon | 179 years (1980-12-08 → 2160-06-07), shared with the hex FTN scheme so day numbers match between CTN and FTN-compat MSGIDs |
| Time resolution | 1 second within day |
| Burst capacity | 32 MSGIDs per process per wall-clock second |
| Cross-process safety | Structural (3-bit process ID, no shared state) |
| Runtime state | 2 process-local scalars (`_lastSec`, `_secCounter`) |
| Cross-process coordination | None (structural via process ID bits; compare to hex FTS-compat which uses atomic Postgres upserts) |
| Disk I/O | None |
| Restart race window | ≤1 second (counter resets per second anyway) |
| Wire compatibility | Non-FTS-0009-compliant (not hex), but universally accepted by modern FTN tossers as opaque strings |

**Implementation sketch:**

```js
// 1980-12-08 UTC. Shared with the hex FTN scheme so day numbers are
// interchangeable between the two MSGID formats. Deliberately pre-FTN
// (1984) so future import tools can synthesize MSGIDs for historical
// message bases with their natural chronological position.
var CANECTIC_EPOCH_MS = Date.UTC(1980, 11, 8);
var PROCESS_ID = parseInt(process.env.CANECTIC_PROCESS_ID || '0', 10) & 0x7;

var _lastSec = -1;
var _secCounter = 0;

function _nextMsgIdSerial() {
    var nowMs = Date.now() - CANECTIC_EPOCH_MS;
    var days = Math.floor(nowMs / 86400000) & 0xFFFF;
    var secOfDay = Math.floor((nowMs % 86400000) / 1000) & 0x1FFFF;

    // Monotonic counter within one wall-clock second per process.
    // Resets every second so no long-lived state to manage.
    var thisSecKey = days * 86400 + secOfDay;
    if (thisSecKey !== _lastSec) {
        _lastSec = thisSecKey;
        _secCounter = 0;
    } else {
        _secCounter = (_secCounter + 1) & 0x1F;  // 5 bits, 32 burst
    }

    var value = (BigInt(PROCESS_ID) << 38n) |
                (BigInt(days) << 22n) |
                (BigInt(secOfDay) << 5n) |
                BigInt(_secCounter);

    // Pad to exactly 8 base36 characters
    var s = value.toString(36);
    return s.padStart(8, '0');
}
```

**Why this layout instead of alternatives:**

- **Days + sec-of-day over straight Unix ms**: 41 bits of ms only gives 69 years of horizon with no room for process ID or counter. The days+sec split gives the same horizon while freeing up bits for structural cross-process safety.
- **3 bits of process ID instead of 2**: leaves room for future Canectic processes beyond the current 4 (gateway/mail/mailer/worker). If we ever split the web UI into its own process, or add a dedicated coordinator/chat process, we don't have to re-layout the MSGID format.
- **5-bit counter (32 burst) instead of 6-bit (64 burst)**: in exchange for that extra process-ID bit. 32/sec/proc is still ~2.76 million MSGIDs per process per day — far beyond any realistic BBS traffic pattern.

### Other CTN ideas to capture later

Placeholders for future expansion:

- **Area naming**: FTN's areatag is 40 characters, uppercase, limited charset. CTN could allow longer mixed-case UTF-8 area names while still emitting a mapping to an FTN-compliant areatag for downstream peers.
- **Body encoding**: FTN is CP437 with a `CHRS:` kludge for alternative charsets. CTN could mandate UTF-8 as the default body encoding with CP437 downgrade at the gateway to FTN-only peers.
- **TLS at the mailer layer**: binkp has a TLS extension (binkp/1.1 STA) but it's unevenly supported. CTN could mandate TLS negotiation at the mailer handshake and fall back cleanly to plain binkp for peers that don't advertise support.
- **Large attachment handling**: FTN's file-attach flag is crude. CTN could define a content-addressed attachment store (SHA-256 keys) with deduplication across messages and areas.
- **Message-level ACKs**: FTN has no per-message delivery confirmation. CTN could add an opt-in ACK protocol for messages that want end-to-end delivery proof.
- **Modern timestamps**: FTN stores timestamps as `DD Mon YY  HH:MM:SS` with a separate `TZUTC` kludge. CTN could store ISO-8601 strings directly in a new kludge while keeping the legacy format for FTN peers.

None of these are urgent. They're notes for when CTN becomes a real thing.

## Philosophy

CTN should be the answer to the question: "If you were designing a message network today, knowing what we know about modern internet infrastructure and the lessons of 40 years of FidoNet, what would you do differently?" — while also being the answer to "How do you deploy that without burning the bridge to the existing FTN world?"

The bridge is important. FTN networks are small but they're alive and they have active participants who deserve to continue participating. Canectic speaks their language today and should continue to do so indefinitely. CTN is an additive layer, not a replacement.

If CTN ever ships, it ships as an opt-in extension set between consenting Canectic (and potentially other modern-implementation) peers, announced during binkp handshake, and silently falling back to strict FTN when either side doesn't speak it.
