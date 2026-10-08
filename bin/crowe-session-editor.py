#!/usr/bin/env python3
"""Return a managed CLI draft through its authenticated local session broker."""
import json
import os
import stat
import sys
import time
import urllib.request


def edit(filename):
    port = int(os.environ["CROWE_DRAFT_PORT"])
    if not 1 <= port <= 65535:
        raise ValueError("Invalid session broker port")
    session_id = os.environ["CROWE_DRAFT_SESSION"]
    secret = os.environ["CROWE_DRAFT_SECRET"]
    draft_id = None

    def call(route, **fields):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/{route}",
            data=json.dumps({"sessionId": session_id, **fields}).encode(),
            headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        )
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=5) as response:
            return json.load(response)

    try:
        fd = os.open(filename, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "r+b") as document:
            before = os.fstat(document.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 256 * 1024:
                raise ValueError("Shared drafts require a regular file under 256 KiB")
            original = document.read()
            draft_id = call("open", text=original.decode("utf-8"))["id"]
            while True:
                result = call("result", draftId=draft_id)
                if result["status"] == "discarded":
                    # A cancelled external edit succeeds with the original file.
                    # This works with both VISUAL/EDITOR and the Crowe CLI wrapper.
                    return 0
                if result["status"] == "returned":
                    text = result["text"]
                    if b"\r\n" in original:
                        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
                    content = text.encode("utf-8")
                    if len(content) > 256 * 1024:
                        raise ValueError("Returned draft exceeds 256 KiB")
                    document.seek(0)
                    current = os.stat(filename, follow_symlinks=False)
                    if document.read() != original or (current.st_dev, current.st_ino, current.st_nlink) != (before.st_dev, before.st_ino, 1):
                        raise ValueError("Draft file changed while editing; original preserved")
                    document.seek(0)
                    document.write(content)
                    document.truncate()
                    document.flush()
                    os.fsync(document.fileno())
                    try:
                        call("ack", draftId=draft_id)
                    except OSError:
                        pass
                    draft_id = None
                    return 0
                time.sleep(0.3)
    finally:
        if draft_id:
            try:
                call("cancel", draftId=draft_id)
            except OSError:
                pass


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Pass exactly one draft file")
        sys.exit(edit(sys.argv[1]))
    except (OSError, ValueError, KeyError) as error:
        print(f"Cannot return the shared draft: {error}", file=sys.stderr)
        sys.exit(1)
