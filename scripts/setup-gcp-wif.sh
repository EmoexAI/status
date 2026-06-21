#!/usr/bin/env bash
# One-shot GCP setup for the EmoexAI/status repository.
#
# Creates:
#   1. Workload Identity Pool      : github-actions
#   2. WIF Provider (OIDC)         : github
#   3. Service Account             : status-page-reader@<PROJECT>.iam.gserviceaccount.com
#   4. IAM bindings                : roles/logging.viewer on the project
#   5. Repository-scoped principal : binds GH repo → SA via WIF
#
# Idempotent: safe to re-run; existing resources are skipped.
#
# Run this on your laptop (you need owner/editor on the GCP project):
#   ./scripts/setup-gcp-wif.sh <github-owner>/<github-repo>
# e.g. ./scripts/setup-gcp-wif.sh EmoexAI/status
#
# After it finishes, copy the three values it prints into your GitHub repo:
#   Settings → Secrets and variables → Actions → "Variables" tab
#     GCP_PROJECT
#     GCP_WIF_PROVIDER
#     GCP_SERVICE_ACCOUNT

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <github-owner>/<github-repo>" >&2
  exit 1
fi

REPO_SLUG="$1"
PROJECT="${GCP_PROJECT:-emoex-9aa45}"
POOL_ID="github-actions"
PROVIDER_ID="github"
SA_NAME="status-page-reader"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

echo "Project       : $PROJECT"
echo "GitHub repo   : $REPO_SLUG"
echo "Pool          : $POOL_ID"
echo "Provider      : $PROVIDER_ID"
echo "Service acct  : $SA_EMAIL"
echo

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

echo "==> Enabling APIs"
gcloud services enable \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  iam.googleapis.com \
  logging.googleapis.com \
  --project "$PROJECT"

echo "==> Creating Workload Identity Pool (if missing)"
if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
      --location=global --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --location=global \
    --display-name="GitHub Actions" \
    --project "$PROJECT"
fi

echo "==> Creating OIDC Provider (if missing)"
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
      --location=global --workload-identity-pool="$POOL_ID" \
      --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --display-name="GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository=='${REPO_SLUG}'" \
    --project "$PROJECT"
fi

echo "==> Creating service account (if missing)"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="EmoEx Status Page log reader" \
    --project "$PROJECT"
fi

echo "==> Granting roles/logging.viewer to SA"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/logging.viewer" \
  --condition=None >/dev/null

echo "==> Binding GitHub repo → SA via WIF"
WIF_POOL_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$PROJECT" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${WIF_POOL_RESOURCE}/attribute.repository/${REPO_SLUG}" >/dev/null

WIF_PROVIDER="${WIF_POOL_RESOURCE}/providers/${PROVIDER_ID}"

cat <<EOF

================================================================
Setup complete. Configure these as GitHub Actions VARIABLES
(repo Settings → Secrets and variables → Actions → "Variables" tab):

  GCP_PROJECT          ${PROJECT}
  GCP_WIF_PROVIDER     ${WIF_PROVIDER}
  GCP_SERVICE_ACCOUNT  ${SA_EMAIL}

(They're variables, not secrets — none of these are sensitive.)
================================================================
EOF
