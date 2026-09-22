#!/usr/bin/env bash
set -euo pipefail

# Offline Linux validation only. No service installation, restart, or provider access.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for tool in nginx openssl systemd-analyze node; do
  command -v "$tool" >/dev/null || { printf 'Missing validation tool: %s\n' "$tool" >&2; exit 1; }
done
test -f "$root/apps/api/dist/apps/api/src/server.js"
test -f "$root/apps/web/dist/index.html"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=example.invalid' \
  -keyout "$temporary/key.pem" -out "$temporary/certificate.pem" \
  >/dev/null 2>&1
sed \
  -e "s|/etc/letsencrypt/live/example.invalid/fullchain.pem|$temporary/certificate.pem|g" \
  -e "s|/etc/letsencrypt/live/example.invalid/privkey.pem|$temporary/key.pem|g" \
  -e "s|/opt/picfind/current/apps/web/dist|$root/apps/web/dist|g" \
  "$root/infra/picfind.nginx.conf" > "$temporary/site.conf"
cat > "$temporary/nginx.conf" <<EOF
pid $temporary/nginx.pid;
error_log stderr;
events {}
http {
  access_log off;
  client_body_temp_path $temporary/client;
  proxy_temp_path $temporary/proxy;
  include $temporary/site.conf;
}
EOF
nginx -t -p "$temporary/" -c "$temporary/nginx.conf"

sed \
  -e "s|/opt/picfind/current/apps/api|$root/apps/api|g" \
  -e "s|/usr/bin/node|$(command -v node)|g" \
  "$root/infra/picfind-api.service" > "$temporary/picfind-api.service"
systemd-analyze verify "$temporary/picfind-api.service"
printf 'Deployment templates passed syntax checks. Runtime, TLS and provider acceptance remain required.\n'
