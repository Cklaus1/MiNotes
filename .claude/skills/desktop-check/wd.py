#!/usr/bin/env python3
"""Minimal W3C WebDriver client for desktop.sh (no dependencies).

usage: wd.py <base-url> <session-id-file> <op> [args]

  new <app-binary>        create a session (tauri-driver launches the app)
  js '<async fn body>'    run in the webview, print the JSON result
  eval '<expression>'     agent-browser-compatible: evaluate an expression,
                          await it, print JSON. `import('/src/...')` is served
                          from window.__MINOTES__.modules (no dev server here).
  press <Combo>           real key input, e.g. Control+k, Escape, Control+Shift+K
  snapshot [-i]           text snapshot of the page (-i: interactive elements)
  wait '<expression>' [timeout-seconds]   poll until truthy (exit 1 on timeout)
  errors [--clear]        uncaught errors / CSP violations / console.error seen
  shot <out.png>          screenshot of the webview
  quit                    end the session
"""
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request

base, sidfile, op, *args = sys.argv[1:]


def transport_fail(msg):
    # Exit 3 = the WebDriver call itself failed (callers may retry); exit 1 = the
    # script ran and threw, or an expectation was not met.
    print(msg, file=sys.stderr)
    sys.exit(3)


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
        transport_fail("webdriver error: " + e.read().decode()[:400])
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        transport_fail(f"webdriver not reachable at {base}: {getattr(e, 'reason', e)}")


# Installed into every page we talk to: records problems the screenshots can't show.
COLLECTOR = r"""
if (!window.__dcErrors) {
  window.__dcErrors = [];
  const push = (kind, msg) => { if (window.__dcErrors.length < 200) window.__dcErrors.push({kind, msg: String(msg).slice(0, 400)}); };
  // WebKit reports this benign layout notice as an error event; it is not a failure.
  window.addEventListener('error', e => /ResizeObserver loop/.test(e.message || '') || push('uncaught', (e.message || e.error) + (e.filename ? ' @' + String(e.filename).split('/').pop() + ':' + e.lineno : '')));
  window.addEventListener('unhandledrejection', e => push('unhandledrejection', (e.reason && (e.reason.message || e.reason)) || 'unknown'));
  document.addEventListener('securitypolicyviolation', e => push('csp', e.effectiveDirective + ' blocked ' + (e.blockedURI || 'inline')));
  const orig = console.error.bind(console);
  console.error = (...a) => { push('console.error', a.map(x => (x && x.message) || (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); orig(...a); };
}
"""

PRELUDE = (
    "const done = arguments[arguments.length - 1];"
    "const invoke = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);"
    + COLLECTOR
)


def run_js(sid, body, timeout_ms=60000):
    """Run an async function body; returns ('ok', value) or ('error', message)."""
    wrapped = (
        PRELUDE + "(async () => {" + body + "\n})().then("
        "v => done({ok: v === undefined ? null : v}),"
        "e => done({error: String((e && e.message) || e)}));"
    )
    call("POST", f"/session/{sid}/timeouts", {"script": timeout_ms})
    v = call("POST", f"/session/{sid}/execute/async", {"script": wrapped, "args": []})
    return ("error", v["error"]) if "error" in v else ("ok", v["ok"])


IMPORT_RE = re.compile(r"""import\(\s*(['"])(/src/[^'"]+)\1\s*\)""")


def rewrite_imports(src):
    # The built app has no dev server to import source modules from; the app
    # exposes the same module objects on window.__MINOTES__.modules.
    return IMPORT_RE.sub(lambda m: f"Promise.resolve(window.__MINOTES__.modules[{json.dumps(m.group(2))}])", src)


KEYS = {
    "control": "", "ctrl": "", "shift": "", "alt": "", "meta": "",
    "escape": "", "enter": "", "return": "", "tab": "",
    "backspace": "", "delete": "", "space": " ",
    "arrowup": "", "arrowdown": "", "arrowleft": "", "arrowright": "",
}

SNAPSHOT = r"""
const interactive = %s;
const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
if (!interactive) {
  const extra = [...document.querySelectorAll('[aria-label],[placeholder],[title]')].filter(vis)
    .map(e => e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title')).filter(Boolean);
  // innerText omits form state: add select options and input values.
  const forms = [...document.querySelectorAll('select')].filter(vis).flatMap(s => [...s.options].map(o => o.text))
    .concat([...document.querySelectorAll('input,textarea')].filter(vis).map(i => i.value).filter(Boolean));
  return document.body.innerText + '\n' + extra.join('\n') + '\n' + forms.join('\n');
}
const sel = 'a,button,input,textarea,select,[contenteditable="true"],[role="button"],[role="textbox"],[tabindex]';
return [...document.querySelectorAll(sel)].filter(vis).map(e => {
  const role = e.getAttribute('role') || (e.isContentEditable ? 'textbox contenteditable editable' : e.tagName.toLowerCase());
  const label = (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.innerText || e.value || '').trim().slice(0, 80);
  return '- ' + role + ' "' + label + '" [' + (e.className && e.className.toString ? e.className.toString() : '') + ']';
}).join('\n');
"""

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
    kind, v = run_js(sid, args[0])
    if kind == "error":
        print("JS ERROR: " + v)
        sys.exit(1)
    print(json.dumps(v, ensure_ascii=False))
elif op == "eval":
    kind, v = run_js(sid, "return await (" + rewrite_imports(args[0]).strip().rstrip(";") + "\n);")
    if kind == "error":
        print("JS ERROR: " + v, file=sys.stderr)
        sys.exit(1)
    print(json.dumps(v, ensure_ascii=False))
elif op == "press":
    parts = args[0].split("+") if args[0] != "+" else ["+"]
    keys = [KEYS.get(p.lower(), p if len(p) == 1 else None) for p in parts]
    if None in keys:
        sys.exit(f"unknown key in combo: {args[0]}")
    actions = [{"type": "keyDown", "value": k} for k in keys] + [{"type": "keyUp", "value": k} for k in reversed(keys)]
    call("POST", f"/session/{sid}/actions", {"actions": [{"type": "key", "id": "kbd", "actions": actions}]})
    call("DELETE", f"/session/{sid}/actions")
elif op == "snapshot":
    kind, v = run_js(sid, SNAPSHOT % ("true" if "-i" in args else "false"))
    print(v if kind == "ok" else "")
elif op == "wait":
    deadline = time.time() + float(args[1] if len(args) > 1 else 15)
    expr = rewrite_imports(args[0])
    while True:
        kind, v = run_js(sid, "try { return !!(await (" + expr + "\n)); } catch (e) { return false; }")
        if kind == "ok" and v:
            sys.exit(0)
        if time.time() > deadline:
            print("timed out waiting for: " + args[0], file=sys.stderr)
            sys.exit(1)
        time.sleep(0.25)
elif op == "errors":
    clear = "window.__dcErrors = [];" if "--clear" in args else ""
    kind, v = run_js(sid, "const e = window.__dcErrors.slice(); " + clear + " return e;")
    for e in v if kind == "ok" else []:
        print(f"{e['kind']}\t{e['msg']}")
elif op == "shot":
    png = base64.b64decode(call("GET", f"/session/{sid}/screenshot"))
    with open(args[0], "wb") as f:
        f.write(png)
    print(args[0])
elif op == "quit":
    call("DELETE", f"/session/{sid}", timeout=20)
else:
    sys.exit(__doc__)
