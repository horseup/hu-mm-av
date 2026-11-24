#!/usr/bin/env python3
"""Writes THIRD_PARTY_NOTICES.md from `go-licenses report` CSV output (stdin)."""
import csv
import sys

rows = sorted({tuple(r) for r in csv.reader(sys.stdin) if r and not r[0].startswith("github.com/horseup/")})
out = [
    "# Third-party notices",
    "",
    "The hu-mm-av server binary is built from the Go modules below. Each keeps its own license. The release bundle",
    "contains every license and NOTICE file in `third_party/`, collected with `go-licenses save`. The MPL-2.0 modules",
    "are used unmodified; their source is available at the links below.",
    "",
    "The webapp (`webapp/main.js`, `public/pcm-tap.js`) has no third-party code. At runtime it uses React, ReactDOM and",
    "React-Redux, which the Mattermost web app provides.",
    "",
    "| Module | License | License text |",
    "| --- | --- | --- |",
]
out += [f"| `{m}` | {lic} | [link]({url}) |" for m, url, lic in rows]
print("\n".join(out))
