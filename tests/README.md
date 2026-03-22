# Canectic BBS Test Suite

## Running tests

```
npm test
```

Runs all unit tests via Mocha. No database, Redis, or network required.

## Structure

```
tests/
  *.test.js          — mocha unit tests (run by npm test)
  mailer/            — mailer test scripts (see below)
    test-*.js        — standalone integration tests (NOT run by npm test)
    binkp-echo.js    — manual binkp answerer tool
    binkp-send.js    — manual binkp caller tool
    trigger-poll.js  — requires full environment (DB, Redis, .env)
    README.md        — detailed usage for mailer test tools
```

## Mocha unit tests (285 tests, all passing)

| File | Module under test | Coverage area |
|---|---|---|
| `bsoScanner.test.js` | `src/mailer/bsoScanner.js` | BSO filename parsing (net/node/zone decoding, flow/packet/request types, flavours) |
| `codepageConversions.test.js` | `src/utils/codepageConversions.js` | CP437/UTF-8 conversion, HTML entity escaping, edge-space replacement |
| `configDefaults.test.js` | `src/config/configDefaults.js` | CONFIG_DEFINITIONS structure, getDefaults(), getDefinition(), getCategories() |
| `configvars.test.js` | `src/utils/configvars.js` | %X token substitution for door/session/terminal config strings |
| `fileDescExtractor.test.js` | `src/utils/fileDescExtractor.js` | ZIP FILE_ID.DIZ extraction, description normalization, applyDescriptions() |
| `fileHasher.test.js` | `src/utils/fileHasher.js` | CRC32 and SHA-256 file hashing |
| `nodelistParser.test.js` | `src/utils/nodelistParser.js` | FTN nodelist text parsing, flag string parsing (CM/IP/IBN/ITN/INA/etc.) |
| `termMsgFormat.test.js` | `src/utils/termMsgFormat.js` | Line classification, ANSI art detection, pipe/CtrlA code conversion, reflow |

## Mocha configuration (.mocharc.yml)

- Glob: `tests/**/*.test.js` — picks up all current and future `.test.js` files in any subdirectory
- Timeout: 10000ms — covers tests that create temp files
- ES module support is automatic (project has `"type": "module"` in package.json)

## Mailer integration tests (standalone, NOT part of npm test)

The `tests/mailer/` scripts use a hand-rolled assert framework and exit with `process.exit(0/1)`. They are not Mocha-compatible and must be run directly with `node`. See `tests/mailer/README.md` for full usage.

```bash
node tests/mailer/test-binkp-frames.js   # ~55 assertions, no network/DB
node tests/mailer/test-loopback.js       # in-memory paired transports
node tests/mailer/test-tcp-loopback.js   # real TCP sockets, no DB
```

## Coverage gaps

Components with no automated unit test coverage as of 2026-03-21:

- `src/middleware/tossers/` — FTN/QWK/NNTP tossers (require DB)
- `src/handlers/` — terminal handlers (require terminal session context)
- `src/models/` — DB models (require PostgreSQL)
- `src/routes/` — Express routes (require full app context)
- `src/mailer/manager.js`, `session.js` — require live connections
- `src/utils/terminalText.js` — `formatBodyHtml()` (importable, unit-testable candidate)
- `src/utils/alogger.js` — logging utility (unit-testable candidate)

## Adding new tests

1. Create `tests/<name>.test.js` using ES module syntax (`import`) and `var` declarations
2. Use Mocha's `describe`/`it` with Node's built-in `assert` module
3. No DB or Redis calls — mock or stub external dependencies
4. `npm test` will pick up the new file automatically via the glob pattern
