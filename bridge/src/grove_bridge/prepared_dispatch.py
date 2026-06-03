"""Prepared dispatch helper for guarded grove execution."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from grove_bridge.store import SQLiteBoardStore

ABORT_EXIT_CODE = 75
ABORT_SENTINEL = "GROVE_PREPARED_DISPATCH_ABORT"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="grove-prepared-dispatch")
    parser.add_argument("--grove-binary", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--timeout", required=True)
    parser.add_argument("--config")
    args = parser.parse_args(argv)

    prompt = sys.stdin.read()
    # This is the last parent-controlled point before irreversible terminal write.
    # A successful consume is one-shot and atomic in the board DB. Any kill flip
    # after this point is caught by the parent heartbeat guarded gate.
    if not _dispatch_lease_ok(args.node):
        print(f"{ABORT_SENTINEL}: dispatch lease rejected", file=sys.stderr)
        return ABORT_EXIT_CODE

    cmd = [args.grove_binary, "ask", args.node, prompt]
    if args.config:
        cmd.extend(["--config", args.config])
    cmd.extend(["--timeout", args.timeout])
    os.execvpe(args.grove_binary, cmd, os.environ)
    return 127


def _dispatch_lease_ok(node: str) -> bool:
    guarded = os.environ.get("GROVE_PREPARED_DISPATCH_GUARDED") == "1"
    token = os.environ.get("GROVE_EXECUTION_DISPATCH_LEASE", "")
    if not token and not guarded:
        return True
    board = os.environ.get("GROVE_BOARD_BOARD")
    task_id = os.environ.get("GROVE_BOARD_TASK")
    run_id = os.environ.get("GROVE_BOARD_RUN_ID")
    db_path = os.environ.get("GROVE_BOARD_DB")
    if not board or not task_id or not run_id or not db_path:
        return False
    try:
        return SQLiteBoardStore(Path(db_path)).consume_execution_dispatch_lease(
            board=board,
            task_id=task_id,
            run_id=run_id,
            node=node,
            token=token,
        )
    except Exception:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
