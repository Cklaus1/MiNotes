# Lessons (mistake → rule; corrections/failures only)

## Build / environment
- Vendored OpenSSL for Android failed: `x86_64-linux-android-ranlib: not found` (NDK 27
  ships only `llvm-ranlib`). → Set `RANLIB_<target>` to the NDK's `llvm-ranlib` for
  Android builds (documented in CLAUDE.md).
- The worktree guard refuses shell commands with computed command names, `HOME=`
  assignments or heredocs near `git`. → Put multi-step test drivers in scratchpad
  scripts (written with the Write tool) and run them by absolute path; run git as
  plain separate commands.

## Testing
- A journey that ran alone (trimmed runner) failed because it used `wait_file`, a helper
  defined inside an earlier journey; I spent four debug builds chasing a "stuck mirror".
  → A new journey defines every helper it uses itself; when a trimmed run fails, first
  grep the log for "command not found".
- Desktop journeys reach modules via `window.__MINOTES__.modules`; `import('/src/lib/x.ts')`
  silently fails there unless x is registered in `lib/testModules.ts`. → Register any
  module a journey imports, or use `window.__MINOTES__` helpers.
- The leak scan (grep markers over the whole scratch HOME) found a real plaintext leak a
  unit test missed (switch flush wrote an encrypted notebook's attachments to notes/).
  → For "nothing may be written" properties, scan the real app's files end to end, and
  put the guard in core too (defence in depth), not only at the call site.
