# EmoEx Status

Public status page for EmoEx production services. Hosted on **GitHub Pages**
and probed from **GitHub Actions** — completely independent of our GCP
infrastructure, so if the cluster goes down, this page still works and
accurately shows it red.

## What it monitors

| Service                   | How                                                                 |
| ------------------------- | ------------------------------------------------------------------- |
| `api.emoexai.com`         | HTTP probe (Upptime, every 5 min)                                   |
| `iepcp.emoexai.com`       | HTTP probe (Upptime, every 5 min)                                   |
| `pages.emoexai.com`       | HTTP probe (Upptime, every 5 min)                                   |
| Cloud Run: `summary-task` | GCP Logging query (every 5 min, see `config/cloud-run-targets.yml`) |

The three HTTP-probed domains sit behind Cloudflare → GKE, so each probe
verifies the full edge → origin path end to end.

The two Cloud Run services have no user-facing URL, so we ask GCP Logging
two questions in a sliding window:

1. Did any `severity>=ERROR` log appear? → unhealthy
2. Did the service's known **success pattern** appear at least once? → if no, unhealthy

Either failure opens a GitHub Issue labeled `status`. Upptime treats open
issues as live incidents and renders them on the status page.

## First-time setup

### 1. Create the GitHub repo

Create an empty public repo at `https://github.com/EmoexAI/status`.
Don't initialize with README — we already have one.

### 2. Replace placeholders

Open `.upptimerc.yml` and replace `__GITHUB_OWNER__` everywhere with your
GitHub username (or organization name). Three occurrences.

### 3. Push this directory

```bash
cd /Users/geminiwen/Code/EmoEx/status
git init -b master
git add .
git commit -m "Initial commit"
git remote add origin git@github.com:EmoexAI/status.git
git push -u origin master
```

### 4. Enable GitHub Pages

Repo Settings → Pages → Source: **Deploy from a branch** → Branch: `gh-pages` (Upptime will create this on its first `static-site` run).

### 5. Set up GCP Workload Identity Federation (for Cloud Run monitor)

You need GCP `Owner` or `Editor` on `emoex-9aa45`. Then:

```bash
./scripts/setup-gcp-wif.sh EmoexAI/status
```

The script will print three values. Add them as **Repository Variables**
(Settings → Secrets and variables → Actions → **Variables** tab, not Secrets):

- `GCP_PROJECT`
- `GCP_WIF_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

### 6. Trigger the first run

Go to the Actions tab and manually run **Setup CI** once. After that the
cron schedules take over.

### 7. (Optional) Point `status.emoexai.com` at GitHub Pages

In Cloudflare DNS, add a CNAME `status` → `emoexai.github.io` (proxy: off
the first time so GitHub Pages can issue the cert). The CNAME is already
set in `.upptimerc.yml::status-website.cname`.

## Customizing

### Change which HTTP endpoints get probed

Edit `.upptimerc.yml` → `sites`.

### Change Cloud Run rules

Edit `config/cloud-run-targets.yml`. Each service can override `window_minutes`,
`success_filter`, and `error_filter`. Filters use [Cloud Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language).

### Add a new Cloud Run service

Append to `services:` in `config/cloud-run-targets.yml` — no workflow
changes needed.

## Why hosted on GitHub Pages (and not in our cluster)

If status page lives on the same infra it monitors, an outage of that infra
makes the status page unreachable — exactly when users need it most. By
parking everything on GitHub:

- GitHub Pages serves the static site.
- GitHub Actions runs probes from a totally different network.
- Even an "everything red" GCP outage leaves the status page fully functional.

Cloudflare being in front of `api.emoexai.com` is not a problem: the probe
hits `https://api.emoexai.com/`, traverses CF → GCP, and a failure anywhere
in the chain is detected.

## File layout

```
.
├── .upptimerc.yml                    # Upptime config (sites, status page)
├── .github/workflows/
│   ├── uptime.yml                    # HTTP probes every 5 min
│   ├── response-time.yml             # daily response-time stats
│   ├── summary.yml                   # daily uptime summary commit
│   ├── static-site.yml               # rebuild GitHub Pages site
│   ├── setup.yml                     # bootstrap on first run
│   ├── updates.yml                   # auto-update Upptime template
│   └── cloud-run-monitor.yml         # custom — GCP Logging probes
├── config/
│   └── cloud-run-targets.yml         # Cloud Run service → log rules
├── scripts/
│   ├── setup-gcp-wif.sh              # one-shot GCP WIF bootstrap
│   ├── check-cloud-run-health.sh     # thin bash → python wrapper
│   └── check_cloud_run_health.py     # actual log-query logic
└── history/                          # populated by Upptime — DO NOT edit by hand
```
