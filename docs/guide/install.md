# Install MiNotes

Download from the [latest release](https://github.com/Cklaus1/MiNotes/releases/latest). Open the **Assets** list at the bottom of the release page.

## Windows (10 and 11)

1. Download `MiNotes_<version>_x64-setup.exe` (or the `.msi` if you prefer one, or your IT department needs it).
2. Run it and follow the installer.
3. MiNotes appears in the Start menu.

**SmartScreen warning.** The installers are not code-signed yet, so Windows may show "Windows protected your PC". This is expected for new, unsigned software. Click **More info**, then **Run anyway**. If you would rather not, you can [build MiNotes from source](../../CONTRIBUTING.md).

## Linux

Pick one.

**AppImage (any distribution).** No install needed.

```bash
chmod +x MiNotes_*.AppImage
./MiNotes_*.AppImage
```

If it does not start, your system may be missing FUSE 2 (`sudo apt install libfuse2` on Ubuntu). You can also run it with `--appimage-extract-and-run`.

**Debian, Ubuntu, Linux Mint (.deb)**

```bash
sudo apt install ./MiNotes_*.deb
```

**Fedora, openSUSE (.rpm)**

```bash
sudo dnf install ./MiNotes-*.rpm        # Fedora
sudo zypper install ./MiNotes-*.rpm     # openSUSE
```

## macOS

There is no macOS installer yet. You can build it from source; see [CONTRIBUTING](../../CONTRIBUTING.md).

## Updating

MiNotes does not check for updates by itself. To update, download the new installer from the releases page and install it over the old one. Your notes are not touched.

## Where your notes are stored

Each notebook is a folder. A new notebook goes in `~/MiNotes/<name>` (on Windows, `C:\Users\<you>\MiNotes\<name>`), unless you chose another place when you created it. **Manage notebooks** in the notebook menu shows where each one is.

Some things live outside the notebook folders:

- `~/.minotes/` holds the list of notebooks and app settings. Notebooks from early versions are single files named `~/.minotes/<name>.db`.
- `~/MiNotes_Sync/` (or `~/MiNotes_Sync-<name>/`) is the sync folder for those early single-file notebooks.

Back up a notebook by copying its folder while MiNotes is closed, or use the notebook's zip export. See the [FAQ](faq.md).

## Uninstall

- **Windows:** Settings, Apps, MiNotes, Uninstall.
- **Debian / Ubuntu:** `sudo apt remove mi-notes`
- **Fedora:** `sudo dnf remove mi-notes`
- **AppImage:** delete the file.

Uninstalling does **not** delete your notes. To remove them as well, delete the notebook folders (`~/MiNotes`) and `~/.minotes`.
