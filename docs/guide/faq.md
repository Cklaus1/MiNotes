# FAQ

## Windows says "Windows protected your PC". Is MiNotes safe?

The installers are not yet signed with a code-signing certificate, which Windows treats as "unrecognised". Click **More info**, then **Run anyway**. The source code is public if you want to check it or build it yourself. Signed installers will remove the warning later.

## Where are my files?

Each notebook is a folder, by default `~/MiNotes/<name>` (on Windows `C:\Users\<you>\MiNotes\<name>`). Inside is the notebook's database, and a readable markdown copy of your pages in a `notes` folder (except in an encrypted notebook, which keeps everything inside its encrypted database). App settings and the notebook list are in `~/.minotes`. See [Install](install.md#where-your-notes-are-stored).

The markdown copy is kept up to date by MiNotes. If you edit those files in another editor while MiNotes is open, MiNotes notices and brings the changes in. Encrypted notebooks have no markdown copy.

## How do I back up my notes?

- Close MiNotes and copy the notebook folder, or
- use the notebook's **Export** to a zip file (and **Import notebook** to restore it), or
- sync to a private git repository (see [Sync](sync.md); a good extra copy, though not a backup by itself).

Pages you delete go to Trash first, and deleting from Trash asks you to confirm.

## Can I leave MiNotes and take my notes with me?

Yes. Your notes are plain markdown files in the notebook folder, and you can also export a notebook to markdown, HTML or JSON, or per page.

## Is MiNotes open source?

Yes. It is released under the [MIT license](../../LICENSE). The code is at [github.com/Cklaus1/MiNotes](https://github.com/Cklaus1/MiNotes).

## Is there a mobile app?

Android: each release has a test APK (a debug build to sideload and try; not on the Play Store yet). iOS: no app — Apple only allows App Store or TestFlight installs, which needs an Apple developer account and review. macOS: an experimental, not-yet-signed `.dmg` is on the releases page (see [Install](install.md#macos)).

## What about privacy?

Your notes stay on your computer. There is no account and no MiNotes server, and the app has no analytics. The only network use is what you turn on or ask for: git sync to the address you give it; web images (blocked until you allow them in Settings, Privacy); link preview cards for web addresses in your notes; and the optional AI assistant, which is off until you choose a provider and add your own key. Encrypted notebooks are encrypted on disk and in sync.

## Does it work offline?

Yes. Only sync, web images, link previews and AI need a network.

## Can I use it on two computers?

Yes, with [git sync](sync.md). Putting one notebook folder on a shared drive and opening it from two computers is not supported; use sync instead.

## I forgot my passphrase.

Use your recovery key: choose "Use recovery key instead" on the unlock screen. If you have neither, the notes cannot be recovered. See [Encryption](encryption.md).

## How do I report a bug or ask for a feature?

[Open an issue](https://github.com/Cklaus1/MiNotes/issues/new/choose) (do not paste private notes) or ask in [Discussions](https://github.com/Cklaus1/MiNotes/discussions). Security problems: see [SECURITY.md](../../SECURITY.md).
