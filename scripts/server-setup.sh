#!/bin/bash
# DigitalOcean server setup for seo-claude
# Run as root on a fresh Ubuntu 22.04 droplet:
#   bash scripts/server-setup.sh

set -e

echo "=== Installing Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "=== Installing PM2 ==="
npm install -g pm2

echo "=== Installing nginx ==="
apt-get install -y nginx

echo "=== Cloning repo ==="
# Replace with your actual GitHub repo URL
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git /root/seo-claude
cd /root/seo-claude

echo "=== Installing dependencies ==="
npm install --production

echo "=== Creating .env ==="
echo "Copy your .env file to /root/seo-claude/.env"
echo "  scp .env root@137.184.119.230:/root/seo-claude/.env"

echo "=== Configuring nginx ==="
cat > /etc/nginx/sites-available/dashboard << 'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:4242;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

ln -sf /etc/nginx/sites-available/dashboard /etc/nginx/sites-enabled/dashboard
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== Starting dashboard with PM2 ==="
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "=== Setup complete ==="
echo "Dashboard running at http://137.184.119.230"
echo ""
echo "Next: set up cron jobs with: crontab -e"
echo "Paste the contents of your local crontab (update paths to /root/seo-claude)"
