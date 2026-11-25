#!/usr/bin/env python3
"""Collect advertised shortcuts and source key handlers for shortcuts.sh.

usage: shortcuts_collect.py <repo> advertised   → TSV: combo, source, text
       shortcuts_collect.py <repo> handlers     → TSV: combo, file:line, context
Combos are normalised: "Ctrl+Shift+K", "Ctrl+,", "Esc", "/", "Tab", "Enter", "Alt+→".
"""
import os
import re
import sys

repo, what = sys.argv[1], sys.argv[2]
SRC = os.path.join(repo, "crates/minotes-app/src")


def norm(c):
    c = c.strip().replace("Cmd", "Ctrl").replace("Mod", "Ctrl").replace("Escape", "Esc")
    parts = [p.strip() for p in re.split(r"\+(?=.)", c)]
    mods = [m for m in ("Ctrl", "Shift", "Alt") if m in parts]
    rest = [p for p in parts if p not in ("Ctrl", "Shift", "Alt")]
    key = rest[-1] if rest else ""
    if len(key) == 1 and key.isalpha():
        key = key.upper()
    key = {"ArrowRight": "→", "ArrowLeft": "←", "ArrowUp": "↑", "ArrowDown": "↓", " ": "Space"}.get(key, key)
    return "+".join(mods + [key])


def walk():
    for root, _, files in os.walk(SRC):
        for f in files:
            if f.endswith((".ts", ".tsx")) and "mockBackend" not in f:
                p = os.path.join(root, f)
                yield os.path.relpath(p, repo), open(p, encoding="utf-8").read().split("\n")


COMBO = r"(?:(?:Ctrl|Cmd|Shift|Alt)\+)+(?:Enter|Esc|Tab|Space|[A-Za-z0-9,\\=\-](?![a-z]))"
if what == "advertised":
    out = set()
    for rel, lines in walk():
        name = os.path.basename(rel)
        for i, line in enumerate(lines, 1):
            if name == "SettingsPanel.tsx":
                m = re.search(r'\["([^"]+)", "([^"]+)"\]', line)
                if m:
                    out.add((norm(m.group(1)), "Settings › Keyboard Shortcuts", m.group(2)))
                    continue
            if name == "onboarding.ts":
                for k in re.findall(r"\*\*([^*]+)\*\*", line):
                    if re.fullmatch(COMBO + "|Enter|Backspace|/|\\[\\[|>", k):
                        out.add((norm(k), "Getting Started page", re.sub(r"\*\*", "", line.strip().strip('",'))[:90]))
                continue
            for m in re.finditer(r'(title|placeholder|aria-label)=\{?["`]([^"`]*?\((' + COMBO + r')\)[^"`]*)["`]', line):
                out.add((norm(m.group(3)), f"{m.group(1)} ({name})", m.group(2)))
            m = re.search(r'label: "([^"]+)", shortcut: "([^"]+)"', line)
            if m:
                out.add((norm(m.group(2)), "Command palette hint", m.group(1)))
            if "Search pages and blocks" in line and "type >" in line:
                out.add((">", "Search placeholder", "type > for commands"))
    for doc in ("CLAUDE.md", "README.md"):
        p = os.path.join(repo, doc)
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                for k in re.findall(COMBO, line):
                    out.add((norm(k), doc, line.strip()[:90]))
    for row in sorted(out):
        print("\t".join(row))
elif what == "handlers":
    out = set()
    for rel, lines in walk():
        for i, line in enumerate(lines, 1):
            for m in re.finditer(r'(?:e|event|ev)\.key === "([^"]+)"', line):
                key = m.group(1)
                if key in ("Escape",) and "onKeyDown" not in line and "handleKeyDown" not in "".join(lines[max(0, i - 15):i]):
                    pass
                ctx = " ".join(lines[max(0, i - 3):i]) + line
                mods = []
                if re.search(r"(ctrlKey|metaKey)\)?\s*&&|&&\s*\(?(e|event)\.(ctrlKey|metaKey)|\((e|event)\.metaKey \|\| (e|event)\.ctrlKey\)|\((e|event)\.ctrlKey \|\| (e|event)\.metaKey\)", line) and not re.search(r"!\s*(e|event)\.(ctrlKey|metaKey)", line):
                    mods.append("Ctrl")
                if re.search(r"(e|event)\.shiftKey\s*&&|&&\s*(e|event)\.shiftKey", line) and "!e.shiftKey" not in line and "!event.shiftKey" not in line:
                    mods.append("Shift")
                if re.search(r"if \(!e\.altKey\) return", "\n".join(lines[max(0, i - 12):i])):
                    mods.append("Alt")
                out.add((norm("+".join(mods + [key])), f"{rel}:{i}", line.strip()[:110]))
            m = re.search(r'key: "([^"]+)"', line)
            if m and "CM6" in rel:
                out.add((norm(m.group(1).replace("-", "+")), f"{rel}:{i}", line.strip()[:110]))
    for row in sorted(out):
        print("\t".join(row))
