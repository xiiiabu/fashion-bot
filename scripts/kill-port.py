#!/usr/bin/env python3
"""Terminate whatever node process is listening on a TCP port.

Exists because `npx` leaves an orphaned `next-server` behind when its parent is
killed, and a pattern-matching pkill is unsafe here: the pattern matches the
shell that runs it. This walks /proc, resolves each process's socket inodes
against /proc/net/tcp, and signals only a real listener on the given port.
"""

import os
import pathlib
import signal
import sys


def listening_inodes(port: int) -> set[str]:
    """Socket inodes in LISTEN state on `port`, from both IPv4 and IPv6 tables."""
    wanted = f"{port:04X}"
    inodes: set[str] = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = pathlib.Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10:
                continue
            local, state, inode = fields[1], fields[3], fields[9]
            # 0A is TCP_LISTEN.
            if state == "0A" and local.rsplit(":", 1)[-1] == wanted:
                inodes.add(inode)
    return inodes


def owners(inodes: set[str]) -> set[int]:
    found: set[int] = set()
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        fd_dir = entry / "fd"
        try:
            for fd in fd_dir.iterdir():
                try:
                    target = os.readlink(fd)
                except OSError:
                    continue
                if target.startswith("socket:[") and target[8:-1] in inodes:
                    found.add(int(entry.name))
                    break
        except OSError:
            continue
    return found


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: kill-port.py <port>", file=sys.stderr)
        return 64
    port = int(sys.argv[1])
    inodes = listening_inodes(port)
    if not inodes:
        print(f"nothing listening on {port}")
        return 0
    pids = owners(inodes) - {os.getpid(), os.getppid()}
    if not pids:
        print(f"port {port} is held but its owner is not visible")
        return 0
    for pid in sorted(pids):
        try:
            cmd = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
        except OSError:
            cmd = "?"
        print(f"killing {pid}: {cmd.strip()[:90]}")
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
            except PermissionError:
                print(f"  no permission to signal {pid}", file=sys.stderr)
                break
            os.sched_yield()
            if not pathlib.Path(f"/proc/{pid}").exists():
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
