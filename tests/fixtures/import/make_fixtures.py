#!/usr/bin/env python3
"""Regenerate the import fixtures (PRD-import §8). Deterministic: run it from
anywhere; it rewrites obsidian-vault/, evernote/ and hostile/ next to itself.

    python3 tests/fixtures/import/make_fixtures.py
"""
import base64, hashlib, io, json, os, shutil, struct, zlib

HERE = os.path.dirname(os.path.abspath(__file__))


def png(w, h, rgb, label=None):
    try:
        from PIL import Image, ImageDraw
        im = Image.new("RGB", (w, h), rgb)
        if label:
            d = ImageDraw.Draw(im)
            d.rectangle([4, 4, w - 5, h - 5], outline=(255, 255, 255), width=3)
            d.text((12, h // 2 - 6), label, fill=(255, 255, 255))
        b = io.BytesIO()
        im.save(b, "PNG", optimize=False)
        return b.getvalue()
    except ImportError:
        raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
        def ch(t, d):
            c = struct.pack(">I", len(d)) + t + d
            return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")


def jpg(w, h, rgb, label):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (w, h), rgb)
    ImageDraw.Draw(im).text((10, h // 2 - 6), label, fill=(0, 0, 0))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=80)
    return b.getvalue()


PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf-8"))


def vault():
    root = os.path.join(HERE, "obsidian-vault")
    shutil.rmtree(root, ignore_errors=True)
    v = lambda p, d: write(os.path.join(root, p), d)
    v(".obsidian/app.json", '{"attachmentFolderPath": "attachments"}\n')
    v(".obsidian/daily-notes.json", '{"folder": "Daily", "format": "YYYY-MM-DD"}\n')
    v(".obsidian/plugins/dataview/data.json", '{"private": true}\n')
    v(".trash/Deleted note.md", "# Deleted\nThis note is in Obsidian's trash and must not be imported.\n")
    v("Home.md", """---
tags: [moc, "project/active"]
aliases:
  - Start Here
  - Dashboard
status: active
rating: 5
created: 2024-01-10
---
# Welcome to the vault

This is the **home** note. It links to [[Alpha]], to [[Projects/Alpha|the alpha project]] and to [[Renamed by frontmatter]].

## Links of every kind
- Heading link: [[Beta#Section Two]]
- Block link: [[Beta#^key-point]]
- Missing block: [[Beta#^nope]]
- Unresolved: [[Missing Note]]
- Daily note: [[2024-01-15]]
- Markdown link to a note: [Deep note](Projects/Sub/Deep.md)
- Alias link: [[Start Here]]
- Same-note heading: [[#Links of every kind]]
- Ambiguous name: [[Meeting]]

## Embeds
![[Beta]]
![[diagram.png]]
![Holiday photo](attachments/photo%20one.jpg)
![[report.pdf]]
![[missing-image.png]]

## Tasks and tags
- [ ] Write the import PRD #todo
- [x] Build the attachment store #nested/tag
  - [ ] A nested task

> [!warning] Mind the gap
> Callouts become quotes with the type in bold.

> [!tip]- Folded tip
> Still a quote.

Text with a %%hidden comment%% inside.

%%
A multi-line comment
%%

Inline math $e^{i\\pi} + 1 = 0$ and a block:

$$
\\int_0^1 x\\,dx
$$

```dataview
LIST FROM #moc
```

```tasks
not done
```

```python
print("[[not a link]]")
```

| Col A | Col B |
|-------|-------|
| 1     | 2     |
""")
    v("Beta.md", """# Beta

Intro paragraph.

## Section Two

The key point of this note. ^key-point

- list item
""")
    v("Projects/Alpha.md", """---
priority: high
---
# Alpha

Alpha is a project. Back to [[Home]].

- Milestone 1
  - Task under milestone
- Milestone 2
""")
    v("Projects/Renamed.md", """---
title: Renamed by frontmatter
---
The filename is Renamed.md but the frontmatter title wins.
""")
    v("Projects/Sub/Deep.md", "# Deep\nNested two folders down. Link up: [[Alpha]]\n")
    v("Projects/Meeting.md", "Project meeting notes.\n")
    v("Archive/Meeting.md", "Archived meeting notes.\n")
    v("Q&A [draft].md", "Brackets in the filename are mapped in the title.\n")
    v("Daily/2024-01-15.md", "- Morning: worked on [[Alpha]]\n- Evening: read\n")
    v("Daily/2024-01-16.md", "Second daily note.\n")
    v("Daily/Not a date.md", "A note in the daily folder that is not a daily note.\n")
    v("attachments/diagram.png", png(240, 120, (40, 110, 200), "diagram.png"))
    v("attachments/photo one.jpg", jpg(240, 120, (240, 200, 60), "photo one.jpg"))
    v("files/report.pdf", PDF)
    v("Unreferenced/old-scan.png", png(120, 80, (120, 120, 120), "old scan"))
    v("Board.canvas", json.dumps({
        "nodes": [
            {"id": "a", "type": "file", "file": "Projects/Alpha.md", "x": 0, "y": 0, "width": 400, "height": 300},
            {"id": "b", "type": "text", "text": "A card on the board", "x": 500, "y": 0, "width": 200, "height": 100},
            {"id": "c", "type": "link", "url": "https://obsidian.md", "x": 0, "y": 400, "width": 200, "height": 100},
        ],
        "edges": [{"id": "e", "fromNode": "a", "toNode": "b"}],
    }, indent=2) + "\n")
    v("Drawings/Sketch.excalidraw.md", """---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Drawing
```json
{"type":"excalidraw","elements":[]}
```
""")


ENEX_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n<en-export export-date="20240301T120000Z" application="Evernote" version="10.0">\n'
ENML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">'


def resource(data, mime, name, wrap=76):
    b64 = base64.b64encode(data).decode()
    lines = "\n".join(b64[i:i + wrap] for i in range(0, len(b64), wrap))
    return f'<resource><data encoding="base64">\n{lines}\n</data><mime>{mime}</mime><width>10</width><resource-attributes><file-name>{name}</file-name></resource-attributes><recognition><![CDATA[<recoIndex/>]]></recognition></resource>', hashlib.md5(data).hexdigest()


def note(title, enml, created="20240105T100000Z", updated="20240106T110000Z", tags=(), attrs="", resources=""):
    t = "".join(f"<tag>{x}</tag>" for x in tags)
    return f"<note><title>{title}</title><created>{created}</created><updated>{updated}</updated>{t}<note-attributes>{attrs}</note-attributes><content><![CDATA[{ENML_HEAD}<en-note>{enml}</en-note>]]></content>{resources}</note>\n"


def evernote():
    root = os.path.join(HERE, "evernote")
    shutil.rmtree(root, ignore_errors=True)
    img = png(200, 100, (200, 60, 90), "evernote image")
    r1, h1 = resource(img, "image/png", "beach.png")
    r2, h2 = resource(PDF, "application/pdf", "ticket.pdf")
    r3, _ = resource(png(60, 40, (10, 160, 90), "extra"), "image/png", "unreferenced.png")
    long_clip = "".join(f"<p>Clipped paragraph number {i} with some text.</p>" for i in range(230))
    notes = [
        note("Packing list", '<div>Things to pack:</div><div><en-todo checked="true"/>Passport</div><div><en-todo checked="false"/>Sunscreen</div><div><en-todo/>Charger</div>', tags=("travel", "todo")),
        note("Trip photos", f'<div>The beach:</div><div><en-media hash="{h1}" type="image/png"/></div><div>Ticket: <en-media hash="{h2}" type="application/pdf"/></div>',
             attrs="<latitude>43.7</latitude><longitude>7.26</longitude><author>Chris</author><source-url>https://example.com/trip</source-url><reminder-time>20240210T090000Z</reminder-time><reminder-order>20240101T000000Z</reminder-order>",
             resources=r1 + r2 + r3, tags=("travel",)),
        note("Secret", '<div>Before the secret.</div><en-crypt hint="the usual" cipher="AES" length="128">RU5DMDqGo0Lg4LGU0Kq1ZmhDYZNpg==</en-crypt><div>After the secret.</div>'),
        note("Itinerary", '<h1>Day one</h1><div>Arrive at <b>noon</b>, check in at <i>the hotel</i>; see <a href="https://example.com/hotel">the hotel site</a>.</div>'
             '<ul><li>Lunch</li><li>Walk<ul><li>Old town</li></ul></li></ul><ol><li>First</li><li>Second</li></ol>'
             '<table><tr><th>Time</th><th>What</th></tr><tr><td>09:00</td><td>Breakfast</td></tr><tr><td>12:00</td><td><table><tr><td>Nested</td><td>table</td></tr></table></td></tr></table>'
             '<div><span style="background-color: rgb(255, 250, 165);">Highlighted text</span> and <span style="color:red;font-family:Comic Sans">styled text</span></div>'
             '<div><code>inline code</code></div><pre>preformatted\n  block</pre><hr/><blockquote><div>A quote</div></blockquote><h2>Day two</h2><div>Free day &amp; rest&nbsp;time.</div>'),
        note("Web clip", long_clip, attrs="<source-url>https://example.com/article</source-url><source>web.clip7</source>"),
        note("Links", '<div>See <a href="evernote:///view/123/s1/1a2b3c4d-0000-0000-0000-000000000000/1a2b3c4d-0000-0000-0000-000000000000/">Itinerary</a> and <a href="evernote:///view/123/s1/ffffffff-0000-0000-0000-000000000000/ffffffff-0000-0000-0000-000000000000/">a note elsewhere</a>.</div>'),
        note("Packing list", "<div>A second note with the same title.</div>", created="20240107T100000Z"),
    ]
    write(os.path.join(root, "Travel.enex"), ENEX_HEAD + "".join(notes) + "</en-export>\n")
    write(os.path.join(root, "Recipes.enex"), ENEX_HEAD + note("Pancakes", "<div>Flour, milk, eggs.</div><div>See also <a href=\"evernote:///view/1/s1/x/x/\">Itinerary</a></div>", tags=("food",)) + "</en-export>\n")


def hostile():
    root = os.path.join(HERE, "hostile")
    shutil.rmtree(root, ignore_errors=True)
    h = lambda p, d: write(os.path.join(root, p), d)
    # Path traversal from a vault.
    h("traversal-vault/.obsidian/app.json", "{}\n")
    h("traversal-vault/Escape.md", """# Escape attempts
![passwd](../../../../../../etc/passwd)
[shadow](/etc/shadow)
![[../../outside.png]]
[up](../sibling.md)
![enc](%2e%2e/%2e%2e/etc/hosts)
[[../../../etc/passwd]]
""")
    h("traversal-vault/inside.png", png(20, 20, (1, 2, 3)))
    h("outside.png", png(20, 20, (9, 9, 9)))  # next to the vault: must never be read
    # Entity bomb (billion laughs): must not expand.
    lol = '<!ENTITY lol "lol">' + "".join(f'<!ENTITY lol{i} "' + ("&lol%s;" % ("" if i == 1 else i - 1)) * 10 + '">' for i in range(1, 10))
    h("entity-bomb.enex", f'<?xml version="1.0"?>\n<!DOCTYPE en-export [{lol}]>\n<en-export>' + note("Bomb", "<div>&lol9;</div>").replace("<title>Bomb</title>", "<title>Bomb &lol9;</title>") + "</en-export>\n")
    # en-media pointing at a hash no resource has.
    data = png(30, 30, (255, 0, 0))
    r, real = resource(data, "image/png", "red.png")
    h("mismatched-hash.enex", ENEX_HEAD + note("Mismatch", '<div><en-media hash="00000000000000000000000000000000" type="image/png"/></div>', resources=r) + "</en-export>\n")
    # Many notes with one title.
    h("duplicate-titles.enex", ENEX_HEAD + "".join(note("Same", f"<div>copy {i}</div>", created=f"2024010{i}T000000Z") for i in range(1, 5)) + "</en-export>\n")
    # A resource bigger than the (test) cap: 300 KB of base64.
    big = bytes((i * 7) % 256 for i in range(300 * 1024))
    r, _ = resource(big, "application/octet-stream", "big.bin")
    h("oversized-base64.enex", ENEX_HEAD + note("Big", "<div>Has a big attachment.</div>", resources=r) + "</en-export>\n")
    # Truncated / malformed XML.
    h("malformed.enex", ENEX_HEAD + "<note><title>Broken</title><content><![CDATA[<en-note><div>unterminated")
    # Deep nesting.
    h("deep-nesting.enex", ENEX_HEAD + note("Deep", "<div>" * 2000 + "bottom" + "</div>" * 2000) + "</en-export>\n")


if __name__ == "__main__":
    vault()
    evernote()
    hostile()
    print("fixtures written to", HERE)
