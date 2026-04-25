#!/usr/bin/env bash
# Direct deployment script - syncs local backend to VPS
# No Git required - uses rsync to copy files directly

set -euo pipefail

VPS_IP="44.206.42.27"
VPS_USER="root"
VPS_BACKEND_DIR="/opt/NL/backend"
LOCAL_BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Direct VPS Deployment ==="
echo "Local:  $LOCAL_BACKEND_DIR"
echo "Remote: $VPS_USER@$VPS_IP:$VPS_BACKEND_DIR"
echo ""

# Check if rsync is available
if ! command -v rsync >/dev/null 2>&1; then
    echo "Error: rsync not found. Install it first:"
    echo "  Windows: Install via WSL or use Git Bash"
    echo "  Linux/Mac: sudo apt install rsync"
    exit 1
fi

# Sync files to VPS (excluding node_modules, logs, and local files)
echo "Syncing files to VPS..."
rsync -avz --delete \
    --exclude 'node_modules/' \
    --exclude '.git/' \
    --exclude '.env' \
    --exclude '*.log' \
    --exclude '.deploy-backups/' \
    --exclude 'fixtures/' \
    "$LOCAL_BACKEND_DIR/" \
    "$VPS_USER@$VPS_IP:$VPS_BACKEND_DIR/"

echo ""
echo "Installing dependencies on VPS..."
ssh "$VPS_USER@$VPS_IP" "cd $VPS_BACKEND_DIR && npm install --omit=dev"

echo ""
echo "Restarting PM2 on VPS..."
ssh "$VPS_USER@$VPS_IP" "cd $VPS_BACKEND_DIR && pm2 restart nl-backend"

echo ""
echo "Checking status..."
ssh "$VPS_USER@$VPS_IP" "pm2 status"

echo ""
echo "Recent logs:"
ssh "$VPS_USER@$VPS_IP" "pm2 logs nl-backend --lines 20 --nostream"

echo ""
echo "=== Deployment Complete ==="
echo "Your local backend is now running on the VPS"
echo ""
echo "Test it:"
echo "  curl http://$VPS_IP/oneclient.html"
echo "  curl http://$VPS_IP/healthz"
