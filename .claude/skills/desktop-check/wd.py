#!/usr/bin/env python3
"""Minimal W3C WebDriver client for desktop.sh (no dependencies).

usage: wd.py <base-url> <session-id-file> new <app-binary>
       wd.py <base-url> <session-id-file> js '<async function body>'
       wd.py <base-url> <session-id-file> shot <out.png>
       wd.py <base-url> <session-id-file> quit
"""
import base64
import json
import sys
import urllib.error
import urllib.request

base, sidfile, op, *args = sys.argv[1:]


def call(method, path, body=None, timeout=90):
    req = urllib.request.Request(
        base + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)["value"]
    except urllib.error.HTTPError as e:
        sys.exit("webdriver error: " + e.read().decode()[:400])
    except urllib.error.URLError as e:
        sys.exit(f"webdriver not reachable at {base}: {e.reason}")


if op == "new":
    caps = {"browserName": "wry", "tauri:options": {"application": args[0]}}
    v = call("POST", "/session", {"capabilities": {"alwaysMatch": caps}})
    with open(sidfile, "w") as f:
        f.write(v["sessionId"])
    sys.exit(0)

try:
    with open(sidfile) as f:
        sid = f.read().strip()
except FileNotFoundError:
    sys.exit("no webdriver session — start with: desktop.sh up --webdriver")

if op == "js":
    # The body runs as an async function inside the app's webview. `invoke` calls a
    # Tauri command directly (withGlobalTauri is off, so use the internals handle).
    wrapped = (
        "const done = arguments[arguments.length - 1];"
        "const invoke = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);"
        "(async () => {" + args[0] + "\n})().then("
        "v => done({ok: v === undefined ? null : v}),"
        "e => done({error: String((e && e.message) || e)}));"
    )
    call("POST", f"/session/{sid}/timeouts", {"script": 60000})
    v = call("POST", f"/session/{sid}/execute/async", {"script": wrapped, "args": []})
    if "error" in v:
        print("JS ERROR: " + v["error"])
        sys.exit(1)
    print(json.dumps(v["ok"], ensure_ascii=False))
elif op == "shot":
    png = base64.b64decode(call("GET", f"/session/{sid}/screenshot"))
    with open(args[0], "wb") as f:
        f.write(png)
    print(args[0])
elif op == "quit":
    call("DELETE", f"/session/{sid}", timeout=20)
else:
    sys.exit(__doc__)
