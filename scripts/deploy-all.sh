#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() {
  printf '[deploy-all] %s\n' "$*"
}

fail() {
  printf '[deploy-all] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "$name is not set in the current azd environment"
  fi
}

load_azd_env() {
  local env_file
  env_file="$(mktemp)"
  azd env get-values > "$env_file"
  set -a
  # azd emits shell-compatible KEY="value" lines. Do not echo this file; it contains secrets.
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  rm -f "$env_file"
}

syntax_check() {
  log 'Running JavaScript syntax checks'
  node --check app.js
  for file in api/_shared/*.js api/*/index.js; do
    node --check "$file"
  done
}

verify_http() {
  local url="$1"
  local expected="$2"
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
  if [[ "$status" != "$expected" ]]; then
    fail "Expected $url to return HTTP $expected, got $status"
  fi
  log "Verified $url -> HTTP $status"
}

require_command az
require_command azd
require_command curl
require_command npm
require_command node

log 'Loading azd environment'
load_azd_env

require_env AZURE_SUBSCRIPTION_ID
require_env AZURE_RESOURCE_GROUP
require_env AZURE_STATIC_WEB_APP_NAME
require_env AZURE_STATIC_WEB_APP_URL
require_env AZURE_OPENAI_ENDPOINT
require_env AZURE_OPENAI_API_KEY
require_env ZATSUCOACH_AUTH_SECRET
require_env ZATSUCOACH_DEMO_EMAIL
require_env ZATSUCOACH_DEMO_PASSWORD_HASH

log "Using Static Web App: $AZURE_STATIC_WEB_APP_NAME"
log "Using URL: $AZURE_STATIC_WEB_APP_URL"

az account set --subscription "$AZURE_SUBSCRIPTION_ID"

syntax_check

log 'Building static frontend artifact'
npm run build

log 'Provisioning Azure resources and app settings, including auth settings'
azd provision --no-prompt

log 'Deploying Static Web Apps web service via azd'
azd deploy web --no-prompt

log 'Fetching Static Web Apps deployment token'
deployment_token="$(
  az staticwebapp secrets list \
    --name "$AZURE_STATIC_WEB_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --query properties.apiKey \
    --output tsv
)"
if [[ -z "$deployment_token" || "$deployment_token" == "null" ]]; then
  fail 'Could not read Static Web Apps deployment token'
fi

log 'Deploying static frontend and Azure Functions API, including auth endpoints, via SWA CLI'
npx -y @azure/static-web-apps-cli@latest deploy ./dist \
  --api-location ./api \
  --api-language node \
  --api-version 20 \
  --swa-config-location ./dist \
  --env production \
  --deployment-token "$deployment_token"

log 'Verifying deployed endpoints'
verify_http "$AZURE_STATIC_WEB_APP_URL/" 200
verify_http "$AZURE_STATIC_WEB_APP_URL/login" 200
verify_http "$AZURE_STATIC_WEB_APP_URL/api/auth/me" 200
verify_http "$AZURE_STATIC_WEB_APP_URL/api/health" 401

log 'Deployment completed successfully'
log "$AZURE_STATIC_WEB_APP_URL"
