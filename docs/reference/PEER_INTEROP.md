# Peer Interoperability Notes

What other FTN software actually does, as opposed to what the standards say. Findings here come from reading the peer's own documentation or binary, not from forum answers, because the answers found that way have been wrong more than once.

Record what was checked and when. A finding against a 2024 build is worth something; the same finding against a 1999 manual may not still hold.

---

## BBBS (Kim Heino)

Checked September 2026 against the v4.00 manual (`bbbs_lii.tar.gz`, dated 1999) and the current binary (`bbbs-20240423-linux-64`, April 2024), both from bbbs.net.

### Area management: no rescan, of any kind

BBBS has no separate FileFix. One robot, **BRoboCop**, handles message and file echoes together, with `file` and `echo` qualifiers to target one or the other. Netmail can be addressed to either `AreaFix` or `BRoboCop`, and the password goes on the subject line.

Subject-line flags: `-h` help, `-l` list all, `-q` linked, `-u` unlinked.

Body meta commands, one per line:

```
%help  %list  %query  %unlinked
+arearegexp          connect to file or echo area(s)
-arearegexp          disconnect
file +arearegexp     file areas only
echo +arearegexp     echo areas only
```

Areas are matched as regular expressions; `%all` expands to `.`.

The 2024 binary contains `%ALL %HELP %LINKED %LIST %NOTE %QUERY %UNLINKED`, two more than the manual documents. **There is no `%RESCAN` and no `%RESEND` in either.** The only rescan strings in the binary are a local `rescan.N` flag file that makes BBBS re-scan its own outbound queue, and the sysop console's space-bar "Rescan outbound messages". Neither is something a downlink can ask for.

**Consequence for us:** our `%RESCAN`, which we ship on both AreaFix and FileFix, will not be understood. BRoboCop answers an unrecognised body line with "Unknown BRoboCop request. Try help.", so it fails visibly rather than silently. There is no protocol way to have a BBBS uplink backfill a file echo; that needs the sysop to re-send by hand.

### FREQ: supported both ways

Configured under Global: FidoNet: FREQ.

| Setting | Notes |
|---------|-------|
| Remote FREQ when answering | Manual recommends enabling |
| Remote FREQ when calling | Usually disabled, since the caller pays |
| Magic file list | Keyword to file mapping |
| Normal dir list | Directories served from |
| Maximum files / 100 kB's / minutes | Per-session, with separate values for normal nodes, password-secured sessions, and points |

A per-event "Don't allow file requests" toggle exists, so requests can be shut off during a mail event without disabling the feature.

Requests use the classic BSO `.req` file: the binary carries the outbound name format `%s%04x%04x.req` and the inbound glob `%s*.req`, plus `FREQ: %lu files, %lu bytes` and the refusal `This node does not support file requests!`. The manual's nodelist guidance is that XX is the correct flag, for WaZOO updates and requests.

**Not established:** whether FREQ works over binkp specifically, as opposed to only EMSI or WaZOO sessions. The `.req` file is a BSO artifact and over binkp it is just another file in the batch; whether BBBS processes one that arrives that way is not provable from strings. Needs a live test or a word from the sysop before relying on it.

### Transports

binkp, EMSI, Hydra, Zmodem. It advertises **`binkp/1.0`**, not 1.1, so do not expect multi-batch behaviour on a session with this peer. See issue #32 for the multi-batch work that assumption interacts with.

---

## Checking a peer yourself

The distribution usually answers the question faster than asking does.

```bash
curl -sO https://<vendor>/<package>.tar.gz
tar xzf <package>.tar.gz
grep -ain '<feature>' <manual>
strings -a <binary> | grep -iE '^%[A-Za-z]+$' | sort -u
```

Command sets, kludge names and protocol strings are all literals in the binary. Grepping them settles questions that documentation of a given vintage cannot. Delete the download afterwards.
