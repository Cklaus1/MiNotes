#!/usr/bin/env python3
"""Generate a deterministic markdown graph for scale-tour.sh.

usage: scale-seed.py <out-dir> <pages> <blocks> [big-page-blocks=2000]

Writes one .md per page (frontmatter title + an indented bullet outline) for
`minotes import dir`, and prints a JSON manifest on stdout. Shape:
  - "Hub": every other page links to it once  -> the heavily back-linked page
  - "Big Page": <big-page-blocks> blocks       -> the very large page
  - "Page 0001".."Page NNNN": <blocks> blocks spread over them, nested 3 levels
    (root -> child -> grandchild), ~15% of blocks carry a [[link]] to another
    page, ~10% are pending TODOs (TODO / - [ ]), ~3% DONE, ~30% contain the
    common word "project"; exactly one block contains the rare token.
  - the first block of every page starts with a unique marker ("p0001 start")
    so the tour can tell when THAT page's content is on screen.
"""
import json, os, random, sys

out, n_pages, n_blocks = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
big = int(sys.argv[4]) if len(sys.argv) > 4 else 2000
rnd = random.Random(20261010)
os.makedirs(out, exist_ok=True)

WORDS = ("alpha beta gamma delta notes meeting design review draft idea budget plan release sprint metric "
         "customer research summary decision risk owner deadline follow context outline section reference "
         "local first sync graph block page editor keyboard search journal folder archive").split()
RARE = "quokkazephyr"
COMMON = "project"
titles = [f"Page {i:04d}" for i in range(1, n_pages + 1)]
stats = {"todos": 0, "links": 0, "blocks": 0, "common": 0}


def sentence(i):
    k = rnd.randint(5, 16)
    s = " ".join(rnd.choice(WORDS) for _ in range(k))
    r = rnd.random()
    if rnd.random() < 0.30:
        s = COMMON + " " + s; stats["common"] += 1
    if rnd.random() < 0.15:
        s += f" see [[{rnd.choice(titles)}]]"; stats["links"] += 1
    if r < 0.06:
        s = "TODO " + s; stats["todos"] += 1
    elif r < 0.10:
        s = "- [ ] " + s; stats["todos"] += 1
    elif r < 0.13:
        s = "DONE " + s
    return s


def outline(count, marker, extra_first=""):
    """count blocks as root -> child -> grandchild groups (depths 0,1,2,1,2,2,...)."""
    lines, depth = [], 0
    for i in range(count):
        if i == 0:
            depth, text = 0, f"{marker} start {extra_first}".strip()
        else:
            # walk the outline: stay, go deeper (max depth 2) or come back up
            depth = max(0, min(2, depth + rnd.choice((-2, -1, 0, 0, 1, 1))))
            if lines and depth > lines[-1][0] + 1:
                depth = lines[-1][0] + 1
            text = sentence(i)
        lines.append((depth, text))
        stats["blocks"] += 1
    return "\n".join("  " * d + "- " + t for d, t in lines) + "\n"


def write(name, title, body):
    with open(os.path.join(out, name + ".md"), "w", encoding="utf-8") as f:
        f.write(f"---\ntitle: {title}\n---\n\n{body}")


write("hub", "Hub", outline(5, "hub"))
write("big-page", "Big Page", outline(big, "bigpage", "links [[Hub]]"))
per = [n_blocks // n_pages] * n_pages
for i in range(n_blocks - sum(per)):
    per[i] += 1
rare_page = n_pages // 2
for i, t in enumerate(titles):
    body = outline(per[i], f"p{i + 1:04d}", "about [[Hub]]")
    if i == rare_page:
        body += f"- the only block that mentions {RARE} in this graph\n"; stats["blocks"] += 1
    write(f"page-{i + 1:04d}", t, body)

print(json.dumps({"pages": n_pages + 2, "blocks": stats["blocks"], "big_page_blocks": big, "todos_expected": stats["todos"],
                  "links_in_text": stats["links"] + n_pages + 1, "common_term": COMMON, "common_blocks": stats["common"],
                  "rare_term": RARE, "hub_backlinks_expected": n_pages + 1,
                  "small_a": titles[1 % n_pages], "small_b": titles[2 % n_pages], "per_page": per[0]}))
