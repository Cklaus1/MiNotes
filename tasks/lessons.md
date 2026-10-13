# Lessons (mistake → rule; corrections/failures only)

## Build / environment
- Vendored OpenSSL for Android failed: `x86_64-linux-android-ranlib: not found` (NDK 27
  ships only `llvm-ranlib`). → Set `RANLIB_<target>` to the NDK's `llvm-ranlib` for
  Android builds (documented in CLAUDE.md).
- The worktree guard refuses shell commands with computed command names, `HOME=`
  assignments or heredocs near `git`. → Put multi-step test drivers in scratchpad
  scripts (written with the Write tool) and run them by absolute path; run git as
  plain separate commands.
