#!/bin/sh
set -eu

# Small VPS operator front end for the VoxHF Docker Compose deployment.
# It centralizes paths, health checks, backups, and rollback state so operators
# do not need to reconstruct long Docker commands during an incident.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
ENV_FILE="$SCRIPT_DIR/.env"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ROLLBACK_FILE="$ROOT/.voxhf-previous-release"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

env_value() {
  key=$1
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

require_env() {
  [ -f "$ENV_FILE" ] || fail "Missing $ENV_FILE. Run: $0 setup"
}

backup_dir() {
  configured=$(env_value VOXHF_BACKUP_HOST_DIR 2>/dev/null || true)
  case "$configured" in
    '') printf '%s\n' "$SCRIPT_DIR/backups" ;;
    /*) printf '%s\n' "$configured" ;;
    *) printf '%s\n' "$SCRIPT_DIR/$configured" ;;
  esac
}

health_url() {
  domain=$(env_value RELAY_DOMAIN)
  [ -n "$domain" ] || fail 'RELAY_DOMAIN is missing from infra/docker/.env.'
  printf 'https://%s/health\n' "$domain"
}

wait_for_health() {
  url=$(health_url)
  attempt=1
  while [ "$attempt" -le 20 ]; do
    if curl --fail --silent --show-error --max-time 8 "$url" >/dev/null 2>&1; then
      echo "[OK] Relay health: $url"
      return 0
    fi
    sleep 3
    attempt=$((attempt + 1))
  done
  echo "[ERROR] Relay health check failed: $url" >&2
  return 1
}

backup_named() {
  label=$1
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  name="voxhf-${label}-${stamp}.db"
  host_dir=$(backup_dir)
  mkdir -p "$host_dir"
  if ! compose exec -T voxhf-relay test -f /app/scripts/relay-backup.js; then
    # The first upgrade from an older VoxHF image predates this helper. Copying
    # it into the disposable running container lets us back up before rebuild.
    compose exec -T voxhf-relay mkdir -p /app/scripts
    compose cp "$ROOT/scripts/relay-backup.js" voxhf-relay:/app/scripts/relay-backup.js
  fi
  compose exec -T voxhf-relay node scripts/relay-backup.js backup \
    --db /var/lib/voxhf-relay/voxhf.db \
    --output "/var/backups/voxhf/$name"
  printf '%s\n' "$name"
}

command_setup() {
  command -v docker >/dev/null 2>&1 || fail 'Docker is required.'
  [ ! -f "$ENV_FILE" ] || fail "$ENV_FILE already exists. Move it first to regenerate configuration."
  docker run --rm -it -v "$ROOT:/app" -w /app node:20-bookworm-slim node scripts/setup.js server
  echo "[OK] Created $ENV_FILE"
}

command_doctor() {
  require_env
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed.'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is not available.'
  command -v curl >/dev/null 2>&1 || fail 'curl is not installed.'
  grep -Eq '^RELAY_DOMAIN=[A-Za-z0-9.-]+$' "$ENV_FILE" || fail 'RELAY_DOMAIN is missing or invalid.'
  if grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" \
    | grep -Eq '(example\.com|replace-with|INCOLLA|hex-token-from)'; then
    fail 'infra/docker/.env still contains placeholder values.'
  fi
  compose config --quiet
  echo '[OK] Docker, Compose, environment, and configuration syntax.'
  if compose ps --status running --services | grep -q '^voxhf-relay$'; then wait_for_health; fi
}

command_start() {
  require_env
  compose up -d --build
  compose ps
  wait_for_health
}

command_backup() {
  require_env
  backup_named manual >/dev/null
  echo "[OK] Backup directory: $(backup_dir)"
}

restore_database() {
  host_dir=$(backup_dir)
  input=$1
  case "$input" in
    /*) host_file=$input ;;
    *) host_file="$host_dir/$input" ;;
  esac
  [ -f "$host_file" ] || fail "Backup not found: $host_file"
  name=$(basename "$host_file")
  [ "$host_file" = "$host_dir/$name" ] || {
    cp "$host_file" "$host_dir/$name"
    [ ! -f "$host_file.json" ] || cp "$host_file.json" "$host_dir/$name.json"
  }
  compose run --rm --no-deps voxhf-relay node scripts/relay-backup.js restore \
    "/var/backups/voxhf/$name" --db /var/lib/voxhf-relay/voxhf.db --force
}

command_restore() {
  require_env
  [ "$#" -eq 1 ] || fail "Usage: $0 restore <backup-file>"
  compose stop voxhf-relay
  restore_database "$1"
  compose up -d voxhf-relay
  wait_for_health
}

require_clean_git() {
  [ -d "$ROOT/.git" ] || fail 'This update command requires a Git checkout. ZIP installs must use a published server update bundle.'
  [ -z "$(git -C "$ROOT" status --short)" ] || fail 'Tracked working tree changes must be committed or removed before update.'
}

command_update() {
  require_env
  require_clean_git
  previous=$(git -C "$ROOT" rev-parse HEAD)
  backup=$(backup_named before-update | tail -n 1)
  git -C "$ROOT" pull --ff-only
  current=$(git -C "$ROOT" rev-parse HEAD)
  printf '%s\n%s\n%s\n' "$previous" "$current" "$backup" > "$ROLLBACK_FILE"
  if ! command_start; then
    echo "Update failed. Run '$0 rollback' to restore commit $previous and its database." >&2
    exit 1
  fi
  echo "[OK] Updated $previous -> $current"
}

command_rollback() {
  require_env
  require_clean_git
  [ -f "$ROLLBACK_FILE" ] || fail 'No previous release metadata is available.'
  previous=$(sed -n '1p' "$ROLLBACK_FILE")
  backup=$(sed -n '3p' "$ROLLBACK_FILE")
  [ -n "$previous" ] && [ -n "$backup" ] || fail 'Rollback metadata is incomplete.'
  if compose ps --status running --services | grep -q '^voxhf-relay$'; then
    backup_named before-rollback >/dev/null
  else
    echo '[WARN] Relay is not running; using the recorded pre-update backup.' >&2
  fi
  # Restore while the current image still contains the backup helper. The
  # previous release may predate that helper, so rebuilding it first would
  # make an otherwise valid rollback impossible.
  compose stop voxhf-relay
  restore_database "$backup"
  git -C "$ROOT" reset --hard "$previous"
  compose up -d --build
  wait_for_health
  echo "[OK] Rolled back to $previous"
}

command_logs() {
  require_env
  compose logs --tail=100 -f
}

print_help() {
  cat <<'EOF'
VoxHF server operations

Usage: infra/docker/voxhf-server.sh <command>

  setup                 Create infra/docker/.env interactively
  doctor                Validate Docker, environment, Compose, and health
  start                 Build/start the stack and wait for relay health
  backup                Create a consistent live SQLite backup
  restore <file>        Stop relay, restore backup, and verify health
  update                 Backup, git pull, rebuild, and record rollback state
  rollback               Restore the previous commit and pre-update database
  logs                   Follow recent container logs
EOF
}

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

command=${1:-help}
[ "$#" -eq 0 ] || shift
case "$command" in
  setup) command_setup "$@" ;;
  doctor) command_doctor "$@" ;;
  start) command_start "$@" ;;
  backup) command_backup "$@" ;;
  restore) command_restore "$@" ;;
  update) command_update "$@" ;;
  rollback) command_rollback "$@" ;;
  logs) command_logs "$@" ;;
  help|-h|--help) print_help ;;
  *) fail "Unknown command: $command" ;;
esac
