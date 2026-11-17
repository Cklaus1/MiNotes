# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or discussion.

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub private vulnerability reporting).
3. Describe what you found, how to reproduce it, and what you think the impact is. A small example file or notebook helps.

You will get a reply as soon as the maintainer can manage; this is a small project, so please allow a few days. Please give us a reasonable time to fix the problem before you publish details. Do not include your own private notes in a report.

## Supported versions

Only the **latest release** receives security fixes. Please check that the problem still exists in the latest release before reporting.

## What is in scope

- **Encrypted notebooks.** Anything that exposes content, titles, structure or the key of a locked notebook, a weakness in key handling (passphrase, recovery key, OS keychain), or plaintext left on disk (mirror, logs, temporary files, sync repository). See [the encryption guide](docs/guide/encryption.md) for what encryption does and does not protect.
- **Sync.** Git sync and joining a notebook from a remote: command or option injection through a remote address, reading or writing outside the sync folder (including through symlinks), credentials being stored or leaked, a malicious remote affecting other files.
- **Importing untrusted files.** Evernote `.enex` exports, Obsidian vaults, markdown folders and notebook zip files: path traversal, resource exhaustion from crafted files, and script or HTML that runs inside the app.
- **The app itself.** Content in a note that can run code, read files, or reach the network despite the content security policy; remote images or link previews bypassing the block-by-default rule; the local file and network access of the backend commands.
- **The `minotes` command-line tool**, for the same classes of problem.

## Out of scope

- Someone with access to your unlocked computer or an unlocked notebook, or malware running as you. Encryption cannot protect against these.
- A weak passphrase, or a lost passphrase and recovery key (there is no backdoor, by design).
- Problems in a git host or the remote you chose to sync to.
- Plugins: MiNotes does not have a plugin system yet, so there is no plugin sandbox to attack. (The design is in `docs/PRD-plugin-architecture.md`.)
- Findings that need an already-modified install, or only affect unsupported platforms or old releases.
- The Windows SmartScreen warning: installers are not code-signed yet.

## Handling

Confirmed problems are fixed in a new release and noted in the [changelog](CHANGELOG.md). We are happy to credit you if you want to be named.
