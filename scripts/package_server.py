#!/usr/bin/env python3
"""Packages the built language server for other editors.

Writes dist/ca65-lsp-server-<version>.tar.gz and .zip, each holding
ca65-lsp-server-<version>/ with server/out/server.js, server/data/, LICENSE.txt and
README.txt. The Neovim plugin downloads the .tar.gz from the GitHub release whose
tag matches package.json's version, so the release workflow attaches both.

Run `npm run bundle` first. Usage: python3 scripts/package_server.py
"""
import io
import json
import os
import sys
import tarfile
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "hobbett64/ca65-lsp"


def main():
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    top = f"ca65-lsp-server-{version}"

    server_js = os.path.join(ROOT, "server", "out", "server.js")
    if not os.path.isfile(server_js):
        sys.exit("server/out/server.js is missing: run `npm run bundle` first")

    readme = f"""ca65 language server {version}
{'=' * (len('ca65 language server ') + len(version))}

The language server from the ca65 VS Code extension, for use in other editors
(Neovim, Helix, Emacs, Sublime Text...). It speaks the Language Server Protocol
over stdio.

Requires Node.js 18 or newer, and ca65 on your PATH (or the ca65.executablePath
setting) for diagnostics.

Run it with:

    node /path/to/{top}/server/out/server.js --stdio

Keep server/out and server/data side by side: the server loads its instruction
and directive data from ../data relative to server.js.

Neovim users can install the plugin instead, which downloads this server itself.
Settings, the Neovim plugin and other editors are covered in the README:
https://github.com/{REPO}/blob/v{version}/README.md#using-the-language-server-in-other-editors
"""

    files = [(f"{top}/server/out/server.js", server_js)]
    data_dir = os.path.join(ROOT, "server", "data")
    for name in sorted(os.listdir(data_dir)):
        files.append((f"{top}/server/data/{name}", os.path.join(data_dir, name)))
    files.append((f"{top}/LICENSE.txt", os.path.join(ROOT, "LICENSE")))
    contents = []
    for arcname, path in files:
        with open(path, "rb") as f:
            contents.append((arcname, f.read()))
    contents.append((f"{top}/README.txt", readme.encode("utf-8")))

    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    now = int(time.time())
    tar_path = os.path.join(dist, f"{top}.tar.gz")
    with tarfile.open(tar_path, "w:gz") as tar:
        for arcname, data in contents:
            info = tarfile.TarInfo(arcname)
            info.size, info.mode, info.mtime = len(data), 0o644, now
            tar.addfile(info, io.BytesIO(data))
    zip_path = os.path.join(dist, f"{top}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, data in contents:
            zf.writestr(arcname, data)
    print(tar_path)
    print(zip_path)


if __name__ == "__main__":
    main()
