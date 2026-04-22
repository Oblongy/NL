#!/bin/bash
# VPS Setup Script for Nitto Legends Backend

echo "Setting up Nitto Legends Backend..."

# Create .env file
cat > /opt/NL/backend/.env << 'EOF'
HTTP_HOST=0.0.0.0
PORT=8082
TCP_HOST=0.0.0.0
TCP_PORT=3724
SUPABASE_URL=https://ciodeetppyjdmcxrixmg.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_6eyoVSkDxE24ZSQ5QRoJaw_SWAt0MCA
EOF

echo ".env file created"

# Restart PM2
cd /opt/NL/backend
pm2 restart nl-backend

echo "PM2 restarted"

# Show status
pm2 status
pm2 logs nl-backend --lines 10 --nostream

echo "Setup complete!"
