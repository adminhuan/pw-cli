#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PW="$ROOT_DIR/scripts/pw"

$PW start
sleep 2
$PW open "https://chatgpt.com/auth/login"
$PW title
$PW snapshot
$PW screenshot demo-login-page.png

echo "示例完成，截图在 /tmp/pw-screenshots/demo-login-page.png"
