# Encrypted notebooks

You can encrypt a whole notebook. Everything in it is unreadable without the key: text, page titles, project names, search index, attachments and whiteboards. Keep sensitive notes in their own encrypted notebook and the rest in an ordinary one.

## Encrypt a notebook

- **New notebook:** choose **Encrypt this notebook** when you create it.
- **Existing notebook:** open **Settings, Security**, then **Encrypt this notebook...**

You choose a **passphrase** (typed twice), then MiNotes shows a **recovery key**.

## The recovery key

The recovery key is a long code, shown once. **Save it somewhere safe and separate from the computer**: a password manager, or a printout in a drawer. You must tick "I have saved my recovery key" to continue.

If you forget your passphrase, the recovery key unlocks the notebook and lets you set a new passphrase. **If you lose both, nobody can recover your notes. There is no backdoor.**

You can show or replace the recovery key later in Settings, Security (it asks for your passphrase first; a new key invalidates the old one).

## Locking and unlocking

- An encrypted notebook is **locked** when MiNotes is closed or you lock it. A locked notebook shows only its name and an unlock screen.
- Lock it yourself with **Ctrl+Shift+L** or from the notebook menu.
- It also locks after a period without use (15 minutes by default; change or turn off in Settings, Security) and when you switch to another notebook.
- **Unlock** with your passphrase, or choose "Use recovery key instead".

## Keep unlocked on this device

If you do not want to type the passphrase every time, turn on **Keep unlocked on this device**. MiNotes then keeps the key in your computer's own secret store (Windows Credential Manager, or the Secret Service on Linux, such as GNOME Keyring or KWallet). It is off by default, and unavailable if your system has no secret store. Anyone who can sign in to your computer account can then open the notebook, so use it only on a device you trust. "Forget on this device" removes it.

## What it protects against

- A lost or stolen laptop or disk, a leaked backup, a copied notebook folder.
- Someone with another account on the same computer.
- A git host or cloud drive that holds your synced notebook.

## What it does not protect against

- Someone using your computer while the notebook is **unlocked**, and malware running as you.
- A weak passphrase. Use a long one.
- Losing both the passphrase and the recovery key.
- The notebook's folder name and its size are visible on disk.

## Other things to know

- Encrypted notebooks have **no plain markdown copy**, and attachments are kept inside the encrypted file.
- Exports (markdown, HTML, zip as plain files) write unencrypted files, so MiNotes asks you to confirm.
- [Sync](sync.md) uploads encrypted files only. A second device joins with the passphrase.
- You can change the passphrase at any time. **Remove encryption** is in Settings, Security too.
- The `minotes` command-line tool asks for the passphrase on a terminal, or reads `MINOTES_PASSPHRASE`.
