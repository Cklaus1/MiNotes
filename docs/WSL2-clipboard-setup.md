# MiNotes: Image Paste in WSL2

## The Problem

When running MiNotes as a Tauri desktop app in WSL2, pasting images (Ctrl+V) doesn't work out of the box. This is because:

1. **WSL2 runs Linux** — Tauri uses WebKitGTK which reads the Linux clipboard
2. **You copy images in Windows** — screenshots, browser images, etc. go to the Windows clipboard
3. **Two separate clipboards** — Linux and Windows clipboards are isolated by default

## The Solution: WSLg Shared Clipboard

WSLg (Windows Subsystem for Linux GUI) bridges the Windows and Linux clipboards via Wayland. MiNotes uses `wl-paste` to read images from this shared clipboard.

### Prerequisites

1. **WSL2 with WSLg enabled** (Windows 11, or Windows 10 with WSLg update)

   Verify WSLg is running:
   ```bash
   echo $WAYLAND_DISPLAY
   # Should output: wayland-0
   ```

2. **wl-clipboard installed**
   ```bash
   sudo apt install wl-clipboard
   ```

3. **Verify it works**

   Copy an image in Windows (screenshot, right-click copy in browser, etc.), then:
   ```bash
   wl-paste --list-types
   # Should show: image/bmp (or image/png)

   wl-paste --type image/bmp --no-newline | wc -c
   # Should show a large number (image bytes)
   ```

### How It Works in MiNotes

When you press **Ctrl+V** on the whiteboard canvas:

```
Ctrl+V pressed
    │
    ▼
Frontend calls Rust command: paste_image_wsl
    │
    ▼
Rust runs: wl-paste --type image/png (or image/bmp, image/jpeg)
    │
    ▼
wl-paste reads from WSLg Wayland clipboard
(which mirrors the Windows clipboard)
    │
    ▼
Image bytes → base64 → sent to frontend
    │
    ▼
Frontend decodes → places on whiteboard canvas
    │
    ▼
Status: "Pasted!" appears in toolbar
```

### Supported Image Formats

| Format | Source | Notes |
|--------|--------|-------|
| BMP | Windows screenshots (Win+Shift+S) | Most common, always available |
| PNG | Some apps copy as PNG | Tried first, falls back to BMP |
| JPEG | Browser "Copy image" | Supported as fallback |

### Troubleshooting

#### "No image in clipboard" message

**Cause**: The clipboard doesn't contain an image, or WSLg isn't sharing it.

**Fix**:
1. Make sure you copied an **image**, not text or a file
2. Check WSLg is running: `echo $WAYLAND_DISPLAY` → should show `wayland-0`
3. Test manually: `wl-paste --list-types` → should show an image type
4. If no output, restart WSLg: `wsl --shutdown` in Windows, then reopen WSL

#### "Paste failed: wl-paste failed" message

**Cause**: `wl-paste` is not installed or not in PATH.

**Fix**:
```bash
sudo apt install wl-clipboard
which wl-paste  # Should show /usr/bin/wl-paste
```

#### Clipboard works in terminal but not in MiNotes

**Cause**: The Tauri app may not inherit the `WAYLAND_DISPLAY` environment variable.

**Fix**: Launch MiNotes from the same terminal where `wl-paste` works:
```bash
cd crates/minotes-app && npm run tauri dev
```

Or export the variable before launching:
```bash
export WAYLAND_DISPLAY=wayland-0
```

#### WSLg not available (Windows 10 or older WSL)

If `echo $WAYLAND_DISPLAY` is empty, WSLg isn't running. Options:

1. **Update WSL**: `wsl --update` in Windows PowerShell
2. **Use Upload button** instead — click Upload in the whiteboard toolbar and select an image file
3. **Use Windows build** — build MiNotes natively on Windows (no WSL clipboard issue)

### Limitations

| Feature | WSL2 Status | Native Linux/Windows |
|---------|-------------|---------------------|
| Ctrl+V paste | Works via wl-paste bridge | Works natively |
| Drag & drop files | Not supported (WSLg limitation) | Works |
| Upload button | Works | Works |
| Copy from MiNotes | Works | Works |

### Why Not Use Tauri's Clipboard Plugin?

Tauri's `@tauri-apps/plugin-clipboard-manager` reads from the Linux clipboard directly. In WSL2, this is the WSLg Wayland clipboard — but the plugin's `readImage()` returns null even when `wl-paste` can read the image. This appears to be a compatibility issue between the plugin's arboard/wl-clipboard-rs backend and WSLg's Wayland compositor.

The `wl-paste` command-line tool works because it uses a different code path to access the Wayland clipboard. MiNotes calls `wl-paste` directly from Rust as a reliable fallback.

### Architecture

```
Windows Clipboard
    │
    │ (WSLg bridges automatically)
    ▼
WSLg Wayland Compositor (wayland-0)
    │
    ├── wl-paste reads from here ✓ (works)
    ├── Tauri clipboard plugin reads from here ✗ (returns null)
    └── xclip/xsel read from X11 (may or may not work)

MiNotes flow:
    Ctrl+V → Rust → wl-paste → base64 → JS → canvas
```

### Summary

| Step | Action |
|------|--------|
| 1 | Install: `sudo apt install wl-clipboard` |
| 2 | Verify: `wl-paste --list-types` after copying an image in Windows |
| 3 | Use: Ctrl+V on whiteboard canvas |
| 4 | Fallback: Upload button if paste doesn't work |
