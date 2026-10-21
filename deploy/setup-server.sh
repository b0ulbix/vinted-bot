#!/usr/bin/env bash
# Installe le bot Vinted sur un serveur Ubuntu (Oracle Cloud) et le lance en continu
set -euo pipefail
cd "$(dirname "$0")/.."

# Node.js 24
if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Cloudflare Tunnel (relie vinted.ton-domaine.fr au serveur)
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
  sudo dpkg -i /tmp/cloudflared.deb
fi

npm ci --omit=dev

# Services : redémarrent tout seuls en cas de plantage et au démarrage du serveur
sudo cp deploy/vinted-bot.service deploy/vinted-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vinted-bot vinted-tunnel
sudo systemctl restart vinted-bot vinted-tunnel
echo "Installation terminée."
