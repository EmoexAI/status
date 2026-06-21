#!/usr/bin/env python3
"""Cloud Run health checker driven by config/cloud-run-targets.yml.

For each service, query GCP Logging within a sliding window and decide:
  - unhealthy if any ERROR-level log appears
  - unhealthy if no success-pattern log appears
  - healthy otherwise

Unhealthy → open or comment on a GitHub Issue (Upptime renders open issues
as live incidents on the status page).
Recovered → close the issue.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml


CONFIG_FILE = Path(os.environ.get("CONFIG_FILE", "config/cloud-run-targets.yml"))
REPO = os.environ["GITHUB_REPOSITORY"]


def run(cmd: list[str], *, capture: bool = True, check: bool = True) -> str:
    result = subprocess.run(cmd, capture_output=capture, text=True, check=check)
    return result.stdout.strip() if capture else ""


def gcloud_logging_count(filter_expr: str, project: str, window_minutes: int) -> int:
    """Return number of matching entries within `window_minutes` (capped at 1 for cost)."""
    out = run([
        "gcloud", "logging", "read", filter_expr,
        "--project", project,
        "--freshness", f"{window_minutes}m",
        "--limit", "1",
        "--format", "value(timestamp)",
    ])
    return 0 if not out else 1


def find_open_issue(label: str) -> int | None:
    out = run([
        "gh", "issue", "list",
        "--repo", REPO,
        "--state", "open",
        "--label", label,
        "--json", "number",
        "--jq", ".[0].number // empty",
    ])
    return int(out) if out else None


def open_issue(title: str, body: str, labels: list[str]) -> None:
    cmd = ["gh", "issue", "create", "--repo", REPO, "--title", title, "--body", body]
    for lbl in labels:
        cmd.extend(["--label", lbl])
    run(cmd, capture=False)


def comment_issue(number: int, body: str) -> None:
    run([
        "gh", "issue", "comment", str(number),
        "--repo", REPO,
        "--body", body,
    ], capture=False)


def close_issue(number: int) -> None:
    run(["gh", "issue", "close", str(number), "--repo", REPO], capture=False)


def main() -> int:
    cfg = yaml.safe_load(CONFIG_FILE.read_text())
    project = cfg["project"]
    defaults = cfg.get("defaults", {})
    default_window = int(defaults.get("window_minutes", 15))
    default_error_filter = defaults.get("error_filter", "severity>=ERROR")

    overall = 0
    now = datetime.now(timezone.utc).isoformat()

    for svc in cfg["services"]:
        name = svc["name"]
        region = svc["region"]
        window = int(svc.get("window_minutes", default_window))
        success_filter = svc["success_filter"].strip()
        error_filter = svc.get("error_filter", default_error_filter).strip()

        base = (
            f'resource.type="cloud_run_revision" '
            f'AND resource.labels.service_name="{name}" '
            f'AND resource.labels.location="{region}"'
        )

        print(f"::group::Check {name} (window={window}m)")

        errors = gcloud_logging_count(f"{base} AND ({error_filter})", project, window)
        successes = gcloud_logging_count(f"{base} AND ({success_filter})", project, window)

        reasons: list[str] = []
        if errors:
            reasons.append(f"ERROR-level log found in last {window}m")
        if not successes:
            reasons.append(f"no success log in last {window}m")

        label = f"service:{name}"
        all_labels = ["status", "cloud-run", label]
        existing = find_open_issue(label)

        if reasons:
            overall = 1
            reason_text = "; ".join(reasons)
            body = (
                f"Automated check failed at {now}.\n\n"
                f"**Service:** {name} ({region})\n"
                f"**Reason:** {reason_text}\n"
                f"**Window:** {window} minutes\n\n"
                f"Reproduce locally:\n"
                f"```\n"
                f"gcloud logging read '{base}' --project {project} --freshness {window}m\n"
                f"```\n\n"
                f"This issue was opened by `.github/workflows/cloud-run-monitor.yml` "
                f"and will auto-close when the next check passes."
            )
            if existing is None:
                title = f"\U0001f534 {name} (Cloud Run) is degraded"
                print(f"Opening new incident for {name}")
                open_issue(title, body, all_labels)
            else:
                print(f"Incident #{existing} for {name} already open, commenting")
                comment_issue(existing, body)
        else:
            print(f"{name} healthy")
            if existing is not None:
                print(f"Closing recovered incident #{existing}")
                comment_issue(existing, f"Service recovered at {now}. Auto-closing.")
                close_issue(existing)

        print("::endgroup::")

    return overall


if __name__ == "__main__":
    sys.exit(main())
