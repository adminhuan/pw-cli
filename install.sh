#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "[1/4] 检查 Node.js / npm ..."
if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未安装 node，请先安装 Node.js 18+"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "错误: 未安装 npm，请先安装 npm"
  exit 1
fi

echo "[2/4] 初始化 npm 项目 ..."
if [ ! -f package.json ]; then
  npm init -y >/dev/null 2>&1
fi

echo "[3/4] 安装 Playwright 依赖 ..."
npm install --no-optional playwright >/dev/null 2>&1

echo "[4/4] 设置脚本执行权限 ..."
chmod +x "$ROOT_DIR/scripts/pw"
chmod +x "$ROOT_DIR/examples/demo-commands.sh"

echo "安装完成"
echo "使用方式:"
echo "  cd $ROOT_DIR"
echo "  ./scripts/pw start"
echo "  ./scripts/pw open https://chatgpt.com"
echo ""
echo "建议把以下命令写到 ~/.zshrc 或 ~/.bashrc:"
echo "  export PW=\"$ROOT_DIR/scripts/pw\""
