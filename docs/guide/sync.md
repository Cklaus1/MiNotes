# Sync between devices

MiNotes syncs through **git**. You provide a git repository (a private repository on a git host, a server you run, or even a folder on a shared drive); MiNotes keeps it up to date with your notebook. There is no MiNotes server and no account.

Sync is **off** until you set it up. MiNotes never asks for or stores your password: it uses git's own sign-in (your SSH key or your git credential helper).

You need [git](https://git-scm.com/downloads) installed. If it is missing, the sync settings are hidden.

## Set up sync on your first device

1. Create an **empty, private** repository on your git host and copy its address, for example `git@github.com:you/my-notes.git`.
2. Open **Settings, Sync & Backup**.
3. Paste the address and click **Test connection**. MiNotes tells you if it can reach the repository, if it is empty, or what is wrong (not found, sign-in refused, offline).
4. Click **Set up sync**. The first upload happens right away.

After that MiNotes syncs when it starts, when you come back to the window, and shortly after you stop typing. The sidebar shows a sync chip (synced, syncing, or an error with a Retry). **Sync now** in the chip or in Settings syncs immediately. **Change...** and **Remove** in the same place change the address or stop syncing.

Addresses that point at a folder on your own computer are accepted when the folder is in your home folder or on an external drive; use the folder picker for anywhere else.

## Add a second device

1. Install MiNotes there.
2. In the notebook menu choose **Join an existing notebook...** (or use it in Settings, Sync & Backup).
3. Enter the same repository address. If the notebook is encrypted, enter its passphrase.
4. The notes download as a new notebook, and sync starts.

A fresh device's untouched "Getting Started" page gives way to the one you already have, so you do not end up with two.

## Conflicts

If you edit the same page on two devices before they sync, nothing is lost. When the edits touch different blocks, they are merged. When they touch the same block, MiNotes keeps both versions: your page, and a copy titled "<page> (conflict from <device name>)".

A banner on the page offers **Compare**, a side-by-side view of only the blocks that differ. For each, choose **Keep mine**, **Keep theirs** or **Keep both**, then resolve. The copy goes to Trash and you can undo.

## Deletions

If another device deletes pages, they move to Trash here instead of vanishing. If a sync would delete a lot of pages at once, MiNotes holds the deletions and asks you to review them first: tick the pages you want to keep.

## Things to know

- Pages with the same title created separately on two devices are kept both; the second gets a number, for example "Ideas (2)".
- Whiteboards and attachments sync with the pages that use them.
- Encrypted notebooks sync as encrypted files only. The git host never sees your text. See [encryption](encryption.md).
- A notebook folder copied to another computer does not sync until you click **Sync it here** in the banner it shows. This stops a copied folder from pushing to your remote by accident.
- Sync is not a backup on its own: a mistake syncs too. Keep a [backup](faq.md#how-do-i-back-up-my-notes).
