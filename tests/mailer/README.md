# Mailer Test Tools

Test suite for the FTN binkp mailer system. All scripts live in `tests/mailer/` and import from `src/mailer/`.

Run all from the project root.

---

## Automated Tests

### test-binkp-frames.js

Unit test for the binkp protocol module. No network, no database, no project dependencies beyond the protocol file itself.

```
node tests/mailer/test-binkp-frames.js
```

Tests frame encoding/decoding, partial frame reassembly, multi-frame batching, M_NUL/M_ADR/M_FILE/M_EOB/M_ERR parsing, file data reception with fileComplete, CRAM-MD5 verification, NR mode (offset -1) handling, implicit file completion on new M_FILE, double EOB protection, and sendSKIP clearing receive state. ~55 assertions.

### test-loopback.js

Integration test using paired in-memory transports (no network). Requires the project tree for `alogger.js` imports.

```
node tests/mailer/test-loopback.js
```

Five scenarios: CRAM-MD5 handshake, duplicate CRAM-MD5 test, bad password rejection, full file transfer with content verification, and empty session with no files. Plus: double EOB protection, NR mode (offset -1) file receive, and path traversal filename rejection. Creates temp directories, writes test `.pkt` files, verifies arrival and content.

### test-tcp-loopback.js

Full-stack test over real TCP sockets. Starts a server on a random port, connects to it, runs handshake and file transfer.

```
node tests/mailer/test-tcp-loopback.js
```

Validates the complete chain including TCP transport, real network buffering, binkp framing, and file I/O.

---

## Manual Tools

### binkp-echo.js

Standalone binkp answerer. Accepts connections, authenticates, receives files, logs everything. Stays running until Ctrl+C. Good for testing the mailer manager's outbound polling or `binkp-send.js`.

```
node tests/mailer/binkp-echo.js [port] [address] [password]
```

Defaults: port 24554, address `1:999/999`, accept any password. Received files go to `./tmp/mailer/echo-inbound/`.

Examples:
```
node tests/mailer/binkp-echo.js
node tests/mailer/binkp-echo.js 24554 1:999/999 secretpass
```

### binkp-send.js

Standalone binkp caller. Connects to a remote server, authenticates, sends files. If no files are given, runs a handshake-only session (useful for testing auth).

```
node tests/mailer/binkp-send.js <host> <port> <address> <password> [file1] [file2] ...
```

Examples:
```
node tests/mailer/binkp-send.js localhost 24554 1:100/100 testpass ./ftn/outbound/test.pkt
node tests/mailer/binkp-send.js localhost 24554 1:100/100 ""
```

### trigger-poll.js

Triggers an outbound mailer poll for a specific peer connection. Accepts either a connection UUID or an FTN address. Requires the full project environment (database, `.env`). Loads the connection record, displays its config, initiates the outbound call, and reports the result.

```
node tests/mailer/trigger-poll.js <connection-uuid or ftn-address>
```

Examples:
```
node tests/mailer/trigger-poll.js 9f894ef9-5333-42c2-826b-caaf84cb457e
node tests/mailer/trigger-poll.js 1:123/456
```

When given an FTN address, searches all active FTN connections for a matching `connection_data.address`. If no match is found, lists all active FTN connections with their addresses and UUIDs. The connection must have `remote_host` configured in its `connection_data`.

---

## Suggested Testing Sequence

1. `test-binkp-frames.js` — verify protocol module parses correctly
2. `test-loopback.js` — verify handshake + file transfer in memory
3. `test-tcp-loopback.js` — verify over real TCP
4. Start `binkp-echo.js` in one terminal, run `binkp-send.js` against it — verify the two tools work together
5. Start `binkp-echo.js`, configure a peer connection with `remote_host: localhost`, run `trigger-poll.js` with the connection UUID — verify full mailer manager outbound
6. Start the mailer manager, run `binkp-send.js` against it — verify full inbound with DB peer matching
7. Test against a real remote binkd
