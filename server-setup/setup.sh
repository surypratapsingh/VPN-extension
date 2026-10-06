#!/usr/bin/env bash
# Run this on a fresh Ubuntu/Debian VPS (as root or via sudo) to set up a
# SOCKS5 proxy with Dante, authenticated by a single username/password,
# and lock the firewall down to only SSH + the proxy port.
#
# Usage: PROXY_USER=myuser PROXY_PASS=mypass PROXY_PORT=1080 ./setup.sh
set -euo pipefail

PROXY_USER="${PROXY_USER:?Set PROXY_USER}"
PROXY_PASS="${PROXY_PASS:?Set PROXY_PASS}"
PROXY_PORT="${PROXY_PORT:-1080}"

echo "==> Installing dante-server, ufw, fail2ban"
apt-get update -y
apt-get install -y dante-server ufw fail2ban

echo "==> Creating unprivileged proxy user (no shell login)"
if ! id -u "$PROXY_USER" >/dev/null 2>&1; then
  useradd -M -s /usr/sbin/nologin "$PROXY_USER"
fi
echo "${PROXY_USER}:${PROXY_PASS}" | chpasswd

# Detect the primary public network interface
IFACE="$(ip route | awk '/default/ {print $5; exit}')"

echo "==> Writing /etc/danted.conf (interface: ${IFACE}, port: ${PROXY_PORT})"
cat > /etc/danted.conf <<EOF
logoutput: syslog
internal: 0.0.0.0 port = ${PROXY_PORT}
external: ${IFACE}
socksmethod: username
user.privileged: root
user.unprivileged: nobody

client pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: connect disconnect
}

socks pass {
    from: 0.0.0.0/0 to: 0.0.0.0/0
    log: connect error
}
EOF

echo "==> Enabling and restarting danted"
systemctl enable danted
systemctl restart danted

echo "==> Configuring firewall (SSH + proxy port only)"
ufw allow OpenSSH
ufw allow "${PROXY_PORT}/tcp"
ufw --force enable

echo "==> Enabling fail2ban for SSH"
systemctl enable fail2ban
systemctl restart fail2ban

echo "==> Done. Test from your own machine with:"
echo "    curl --socks5 ${PROXY_USER}:${PROXY_PASS}@$(curl -s ifconfig.me):${PROXY_PORT} https://ipapi.co/json/"
