#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import posixpath
import shlex
import subprocess
import sys
import time
from pathlib import Path

try:
    import paramiko
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "paramiko is required for deploys. Install it with `python -m pip install paramiko`."
    ) from exc


SCRIPT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = SCRIPT_DIR.parent
REPO_ROOT = BACKEND_DIR.parent
MANIFEST_NAME = ".codex-deploy-manifest.txt"
BACKUP_DIR_NAME = ".deploy-backups"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync backend changes to the live VPS and restart PM2."
    )
    parser.add_argument("--host", default=os.getenv("NL_VPS_HOST", "173.249.220.49"))
    parser.add_argument("--user", default=os.getenv("NL_VPS_USER", "root"))
    parser.add_argument("--password", default=os.getenv("NL_VPS_PASSWORD"))
    parser.add_argument(
        "--known-hosts-file",
        default=os.getenv("NL_VPS_KNOWN_HOSTS_FILE"),
        help="Optional path to a known_hosts file to load before connecting.",
    )
    parser.add_argument(
        "--remote-dir",
        default=os.getenv("NL_VPS_BACKEND_DIR", "/opt/NL/backend"),
        help="Remote backend directory on the VPS.",
    )
    parser.add_argument(
        "--app-name",
        default=os.getenv("NL_VPS_PM2_APP", "nl-backend"),
        help="PM2 app name to restart after sync.",
    )
    parser.add_argument(
        "--health-url",
        default=os.getenv("NL_VPS_HEALTH_URL", "http://127.0.0.1:8082/healthz"),
        help="Health endpoint to check on the VPS after restart.",
    )
    parser.add_argument(
        "--skip-healthcheck",
        action="store_true",
        help="Skip the final curl health check.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would change without uploading or restarting.",
    )

    source_group = parser.add_mutually_exclusive_group()
    source_group.add_argument(
        "--all-tracked",
        action="store_true",
        help="Deploy the full tracked backend tree from the local worktree.",
    )
    source_group.add_argument(
        "--file",
        action="append",
        default=[],
        help="Deploy or delete an explicit backend-relative path from the local worktree. Repeat as needed.",
    )

    return parser.parse_args()


def log(message: str) -> None:
    print(message, flush=True)


def run_local_text(*args: str) -> str:
    result = subprocess.run(
        args,
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def run_local_bytes(*args: str) -> bytes:
    result = subprocess.run(
        args,
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return result.stdout


def normalize_backend_relative_path(path: str) -> str:
    normalized = str(path).replace("\\", "/").strip().lstrip("./")
    if normalized.startswith("backend/"):
        normalized = normalized[len("backend/"):]
    if not normalized or normalized.startswith("../") or normalized.startswith("/"):
        raise ValueError(f"Invalid backend-relative path: {path}")
    return Path(normalized).as_posix()


def tracked_backend_files() -> list[str]:
    output = run_local_text("git", "ls-files", "backend")
    tracked = []
    for line in output.splitlines():
        path = line.strip()
        if not path:
            continue
        tracked.append(Path(path).relative_to("backend").as_posix())
    return sorted(tracked)


def staged_backend_delta() -> tuple[set[str], set[str]]:
    output = run_local_text(
        "git",
        "diff",
        "--cached",
        "--name-status",
        "--find-renames",
        "--",
        "backend",
    )
    uploads: set[str] = set()
    deletes: set[str] = set()

    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0]
        code = status[0]

        if code == "R":
            deletes.add(normalize_backend_relative_path(parts[1]))
            uploads.add(normalize_backend_relative_path(parts[2]))
        elif code in {"A", "C", "M"}:
            uploads.add(normalize_backend_relative_path(parts[-1]))
        elif code == "D":
            deletes.add(normalize_backend_relative_path(parts[-1]))

    return uploads, deletes


def explicit_backend_delta(paths: list[str]) -> tuple[set[str], set[str]]:
    uploads: set[str] = set()
    deletes: set[str] = set()

    for raw_path in paths:
        relative_path = normalize_backend_relative_path(raw_path)
        local_path = BACKEND_DIR / relative_path
        if local_path.exists():
            uploads.add(relative_path)
        else:
            deletes.add(relative_path)

    return uploads, deletes


def read_worktree_bytes(relative_path: str) -> bytes:
    return (BACKEND_DIR / Path(relative_path)).read_bytes()


def read_index_bytes(relative_path: str) -> bytes:
    return run_local_bytes("git", "show", f":backend/{relative_path}")


def remote_exists(sftp: paramiko.SFTPClient, remote_path: str) -> bool:
    try:
        sftp.stat(remote_path)
        return True
    except FileNotFoundError:
        return False


def read_remote_bytes(sftp: paramiko.SFTPClient, remote_path: str) -> bytes | None:
    try:
        with sftp.open(remote_path, "rb") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def ensure_remote_dir(sftp: paramiko.SFTPClient, remote_dir: str) -> None:
    parts = []
    current = remote_dir
    while current not in ("", "/"):
        parts.append(current)
        current = posixpath.dirname(current)
    for path in reversed(parts):
        try:
            sftp.stat(path)
        except FileNotFoundError:
            sftp.mkdir(path)


def ensure_remote_parent_dir(sftp: paramiko.SFTPClient, remote_path: str) -> None:
    ensure_remote_dir(sftp, posixpath.dirname(remote_path))


def exec_remote(client: paramiko.SSHClient, command: str) -> tuple[int, str, str]:
    _, stdout, stderr = client.exec_command(command)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    status = stdout.channel.recv_exit_status()
    return status, out, err


def read_remote_git_manifest(client: paramiko.SSHClient, remote_dir: str) -> list[str]:
    repo_root = posixpath.dirname(remote_dir)
    backend_name = posixpath.basename(remote_dir)
    status, out, _ = exec_remote(
        client,
        f"cd {shlex.quote(repo_root)} && git ls-files {shlex.quote(backend_name)}",
    )
    if status != 0:
        return []

    files = []
    for line in out.splitlines():
        path = line.strip()
        if not path:
            continue
        files.append(Path(path).relative_to(backend_name).as_posix())
    return files


def read_remote_manifest(
    client: paramiko.SSHClient,
    sftp: paramiko.SFTPClient,
    remote_dir: str,
) -> list[str]:
    remote_manifest_path = posixpath.join(remote_dir, MANIFEST_NAME)
    try:
        with sftp.open(remote_manifest_path, "rb") as handle:
            return [
                line.strip()
                for line in handle.read().decode("utf-8").splitlines()
                if line.strip()
            ]
    except FileNotFoundError:
        return read_remote_git_manifest(client, remote_dir)


def write_remote_manifest(
    sftp: paramiko.SFTPClient,
    remote_dir: str,
    files: list[str],
) -> None:
    remote_manifest_path = posixpath.join(remote_dir, MANIFEST_NAME)
    ensure_remote_parent_dir(sftp, remote_manifest_path)
    with sftp.open(remote_manifest_path, "wb") as handle:
        handle.write(("\n".join(files) + "\n").encode("utf-8"))


def sha256_bytes(payload: bytes | None) -> str:
    if payload is None:
        return ""
    return hashlib.sha256(payload).hexdigest()


def backup_remote_file(
    client: paramiko.SSHClient,
    remote_backend_dir: str,
    relative_path: str,
    timestamp: str,
) -> None:
    remote_path = posixpath.join(remote_backend_dir, relative_path)
    backup_path = posixpath.join(
        remote_backend_dir,
        BACKUP_DIR_NAME,
        timestamp,
        relative_path,
    )
    backup_dir = posixpath.dirname(backup_path)
    status, _, err = exec_remote(
        client,
        f"mkdir -p {shlex.quote(backup_dir)} && cp -p {shlex.quote(remote_path)} {shlex.quote(backup_path)}",
    )
    if status != 0:
        raise RuntimeError(f"Failed to back up {relative_path}: {err.strip()}")


def build_plan(args: argparse.Namespace) -> tuple[str, set[str], set[str], callable]:
    if args.all_tracked:
        tracked = set(tracked_backend_files())
        return "all-tracked", tracked, set(), read_worktree_bytes

    if args.file:
        uploads, deletes = explicit_backend_delta(args.file)
        return "explicit-files", uploads, deletes, read_worktree_bytes

    uploads, deletes = staged_backend_delta()
    return "staged", uploads, deletes, read_index_bytes


def configure_ssh_client(
    client: paramiko.SSHClient,
    known_hosts_file: str | None,
) -> None:
    client.load_system_host_keys()
    if known_hosts_file:
        client.load_host_keys(known_hosts_file)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())


def main() -> int:
    args = parse_args()
    if not args.password:
        args.password = getpass.getpass(f"Password for {args.user}@{args.host}: ")
    if args.known_hosts_file and not Path(args.known_hosts_file).exists():
        raise SystemExit(f"Known hosts file not found: {args.known_hosts_file}")

    mode, upload_candidates, delete_candidates, read_local_bytes = build_plan(args)
    if not upload_candidates and not delete_candidates:
        raise SystemExit(
            "No backend changes selected. Stage backend files, pass --file, or use --all-tracked."
        )

    client = paramiko.SSHClient()
    configure_ssh_client(client, args.known_hosts_file)
    client.connect(
        hostname=args.host,
        username=args.user,
        password=args.password,
        allow_agent=True,
        look_for_keys=True,
        timeout=20,
        banner_timeout=20,
        auth_timeout=20,
    )
    sftp = client.open_sftp()

    try:
        previous_manifest = set(read_remote_manifest(client, sftp, args.remote_dir))
        files_to_delete = sorted(delete_candidates)

        if mode == "all-tracked":
            desired_manifest = set(upload_candidates)
            files_to_delete = sorted(previous_manifest - desired_manifest)
        else:
            desired_manifest = (previous_manifest - set(files_to_delete)) | set(upload_candidates)

        changed_files = []
        for relative_path in sorted(upload_candidates):
            remote_path = posixpath.join(args.remote_dir, relative_path)
            local_hash = sha256_bytes(read_local_bytes(relative_path))
            remote_hash = sha256_bytes(read_remote_bytes(sftp, remote_path))
            if local_hash != remote_hash:
                changed_files.append(relative_path)

        log(f"Mode: {mode}")
        log(f"Remote backend: {args.user}@{args.host}:{args.remote_dir}")
        log(f"Upload candidates: {len(upload_candidates)}")
        log(f"Changed files: {len(changed_files)}")
        log(f"Deleted files: {len(files_to_delete)}")

        for relative_path in changed_files:
            log(f"  upload {relative_path}")
        for relative_path in files_to_delete:
            log(f"  delete {relative_path}")

        if args.dry_run:
            return 0

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        for relative_path in changed_files + files_to_delete:
            remote_path = posixpath.join(args.remote_dir, relative_path)
            if remote_exists(sftp, remote_path):
                backup_remote_file(client, args.remote_dir, relative_path, timestamp)

        for relative_path in changed_files:
            remote_path = posixpath.join(args.remote_dir, relative_path)
            ensure_remote_parent_dir(sftp, remote_path)
            with sftp.open(remote_path, "wb") as handle:
                handle.write(read_local_bytes(relative_path))

        for relative_path in files_to_delete:
            remote_path = posixpath.join(args.remote_dir, relative_path)
            status, _, err = exec_remote(client, f"rm -f {shlex.quote(remote_path)}")
            if status != 0:
                raise RuntimeError(f"Failed to delete {relative_path}: {err.strip()}")

        write_remote_manifest(sftp, args.remote_dir, sorted(desired_manifest))

        if not changed_files and not files_to_delete:
            log("No content changes detected on the VPS.")
        else:
            status, out, err = exec_remote(
                client,
                f"cd {shlex.quote(args.remote_dir)} && node --check src/index.js",
            )
            if status != 0:
                raise RuntimeError(err.strip() or out.strip() or "node --check failed")

            if any(name in {"package.json", "package-lock.json"} for name in changed_files):
                status, out, err = exec_remote(
                    client,
                    f"cd {shlex.quote(args.remote_dir)} && npm install --omit=dev",
                )
                if status != 0:
                    raise RuntimeError(err.strip() or out.strip() or "npm install failed")

            status, out, err = exec_remote(
                client,
                f"cd {shlex.quote(args.remote_dir)} && pm2 restart {shlex.quote(args.app_name)} --update-env",
            )
            if status != 0:
                raise RuntimeError(err.strip() or out.strip() or "pm2 restart failed")
            if out.strip():
                print(out.rstrip())

        status, out, err = exec_remote(
            client,
            f"cd {shlex.quote(args.remote_dir)} && pm2 status {shlex.quote(args.app_name)} --no-color",
        )
        if status != 0:
            raise RuntimeError(err.strip() or out.strip() or "pm2 status failed")
        print(out.rstrip())

        if not args.skip_healthcheck:
            status, out, err = exec_remote(client, f"curl -sf {shlex.quote(args.health_url)}")
            if status != 0:
                raise RuntimeError(err.strip() or out.strip() or "health check failed")
            log(f"Health check: {out.strip()}")

        return 0
    finally:
        sftp.close()
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
