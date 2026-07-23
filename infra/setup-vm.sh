#!/usr/bin/env bash
#
# CSB cloud VM bootstrap — Ubuntu 22.04/24.04, any provider (AWS/GCP/Azure/DO/…).
# Installs Node 22, avalanche-cli, and project dependencies. Run as a non-root
# user with sudo. Recommended VM: 4+ vCPU, 8+ GB RAM, 100 GB SSD.
#
#   git clone <this repo> csb && cd csb && bash infra/setup-vm.sh
#
set -euo pipefail

echo "==> System packages"
sudo apt-get update -y
sudo apt-get install -y curl git jq build-essential ufw

echo "==> Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> avalanche-cli"
if ! command -v avalanche >/dev/null && [[ ! -x "$HOME/bin/avalanche" ]]; then
  curl -sSfL https://raw.githubusercontent.com/ava-labs/avalanche-cli/main/scripts/install.sh | sh -s
fi
export PATH="$PATH:$HOME/bin"
grep -q 'export PATH=$PATH:$HOME/bin' "$HOME/.bashrc" || echo 'export PATH=$PATH:$HOME/bin' >> "$HOME/.bashrc"
avalanche --version

echo "==> Project dependencies"
npm install --no-audit --no-fund

echo "==> Firewall (SSH + demo server only; the node RPC stays private)"
sudo ufw allow OpenSSH
sudo ufw allow 8080/tcp comment 'CSB demo server'
sudo ufw --force enable
sudo ufw status

cat <<'EOF'

Done. Next steps:
  bash infra/deploy-l1.sh          # create + deploy the CSB Avalanche L1 on this VM
  # then follow docs/cloud-deployment.md to deploy contracts and start the demo.

Security notes:
  - Port 9650 (node RPC) is NOT exposed; the demo server (8080) proxies RPC
    behind its access gate. Tighten 8080 to your own IP if you prefer:
      sudo ufw delete allow 8080/tcp && sudo ufw allow from <your-ip> to any port 8080 proto tcp
  - For a leadership demo over the internet, put Caddy/nginx with TLS in front.
EOF
