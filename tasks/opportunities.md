# Opportunities (deferred work found during the encryption build)

Each entry: proposed severity · what · where · why deferred.

## Baseline (pre-existing, not caused by this run)
- P2 · Desktop journey D2 real typing drops trailing characters under Xvfb ("seed and
  typ", "third lin") — timing flake in xdotool typing on the baseline too.
  `tests/desktop-journey-test.sh` D2.
- P1 · Desktop journey "Evernote scan/import" fails on the baseline (5 assertions:
  scan/import empty, undo leaves 15 pages). `tests/desktop-journey-test.sh`
  (Evernote block). Needs its own investigation.

## Found during the build
