#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/NL"
BACKEND_DIR="$APP_DIR/backend"
NGINX_SITE_NAME="nl"
NGINX_AVAILABLE="/etc/nginx/sites-available/$NGINX_SITE_NAME"
NGINX_ENABLED="/etc/nginx/sites-enabled/$NGINX_SITE_NAME"
REPO_URL="https://github.com/Oblongy/NL.git"
SERVER_IP="173.249.220.49"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this script with sudo."
    exit 1
  fi
}

install_base_packages() {
  apt update
  apt install -y git nginx ufw curl

  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
  fi

  if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2
  fi
}

install_repo() {
  if [[ ! -d "$APP_DIR/.git" ]]; then
    git clone "$REPO_URL" "$APP_DIR"
  else
    git -C "$APP_DIR" fetch --all --prune
    git -C "$APP_DIR" pull --ff-only
  fi
}

install_backend_deps() {
  cd "$BACKEND_DIR"
  npm install --omit=dev
}

ensure_env_file() {
  if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    cat <<EOF
Created $BACKEND_DIR/.env from .env.example.
Edit it now and set:
  HTTP_HOST=127.0.0.1
  PORT=8082
  TCP_HOST=0.0.0.0
  TCP_PORT=3724
  SUPABASE_URL=...
  SUPABASE_SERVICE_ROLE_KEY=...
Then re-run this script.
EOF
    exit 1
  fi
}

configure_nginx() {
  cp "$BACKEND_DIR/nginx.nl.conf" "$NGINX_AVAILABLE"
  sed -i "s/server_name 173.249.220.49;/server_name $SERVER_IP;/" "$NGINX_AVAILABLE"
  ln -sfn "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  nginx -t
  systemctl reload nginx
  systemctl enable nginx
}

configure_firewall() {
  ufw allow OpenSSH
  ufw allow 'Nginx Full'
  ufw allow 3724/tcp
  ufw --force enable
}

start_pm2() {
  cd "$BACKEND_DIR"
  pm2 start ecosystem.config.cjs --update-env
  pm2 save
}

print_verify_steps() {
  cat <<EOF

Deployment applied. Verify:
  curl http://127.0.0.1:8082/healthz
  curl http://$SERVER_IP/healthz
  ss -tulpn | grep -E '8082|3724|80|443'
  ufw status
  nginx -t
  pm2 status
  pm2 logs nl-backend --lines 100

Expected:
  HTTP backend on 127.0.0.1:8082
  TCP listener on 0.0.0.0:3724
  nginx on public 80
EOF
}

require_root
install_base_packages
install_repo
install_backend_deps
ensure_env_file
configure_nginx
configure_firewall
start_pm2
print_verify_steps
