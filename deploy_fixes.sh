#!/usr/bin/env bash
set -euo pipefail

# Deploy security fixes to production server
# This script safely updates the /opt/NL/backend/src directory

APP_DIR="/opt/NL"
BACKEND_DIR="$APP_DIR/backend"
BACKUP_DIR="$APP_DIR/backend_backup_$(date +%Y%m%d_%H%M%S)"

echo "=== Nitto Legends Backend Deployment ==="
echo "Target: $BACKEND_DIR"
echo "Backup: $BACKUP_DIR"
echo ""

# Check if running as root or with sudo
if [[ "${EUID}" -ne 0 ]]; then
  echo "Error: This script must be run with sudo"
  echo "Usage: sudo bash deploy_fixes.sh"
  exit 1
fi

# Check if target directory exists
if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "Error: Backend directory not found: $BACKEND_DIR"
  echo "Please run deploy_vps.sh first to set up the server"
  exit 1
fi

# Create backup
echo "Creating backup..."
cp -r "$BACKEND_DIR" "$BACKUP_DIR"
echo "✓ Backup created at: $BACKUP_DIR"
echo ""

# Get current directory (where this script is run from)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/src"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Error: Source directory not found: $SOURCE_DIR"
  echo "Please run this script from the backend directory"
  exit 1
fi

# Stop the application
echo "Stopping application..."
pm2 stop nl-backend || echo "Application not running"
echo ""

# Copy updated files
echo "Deploying updated files..."
rsync -av --delete "$SOURCE_DIR/" "$BACKEND_DIR/src/"
echo "✓ Files deployed"
echo ""

# Copy security fixes documentation
if [[ -f "$SCRIPT_DIR/SECURITY_FIXES.md" ]]; then
  cp "$SCRIPT_DIR/SECURITY_FIXES.md" "$BACKEND_DIR/"
  echo "✓ Security documentation copied"
fi
echo ""

# Verify syntax
echo "Verifying JavaScript syntax..."
cd "$BACKEND_DIR"
if node --check src/index.js; then
  echo "✓ Syntax check passed"
else
  echo "✗ Syntax check failed!"
  echo "Rolling back..."
  rsync -av --delete "$BACKUP_DIR/src/" "$BACKEND_DIR/src/"
  pm2 start nl-backend
  echo "Rollback complete. Check the errors above."
  exit 1
fi
echo ""

# Start the application
echo "Starting application..."
pm2 start nl-backend
pm2 save
echo "✓ Application started"
echo ""

# Wait a moment for startup
sleep 3

# Check status
echo "Checking application status..."
pm2 status nl-backend
echo ""

# Show recent logs
echo "Recent logs:"
pm2 logs nl-backend --lines 20 --nostream
echo ""

echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "  1. Monitor logs: pm2 logs nl-backend"
echo "  2. Check health: curl http://127.0.0.1:8082/healthz"
echo "  3. Test TCP: telnet 127.0.0.1 3724"
echo ""
echo "If issues occur, rollback with:"
echo "  sudo rsync -av --delete $BACKUP_DIR/src/ $BACKEND_DIR/src/"
echo "  sudo pm2 restart nl-backend"
echo ""
