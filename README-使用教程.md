# 浏览器控制工具打包版（pw-browser-control-kit）

这个包用于通过命令行控制本地 Chrome 浏览器，适合自动化测试、页面巡检、人工协作注册等场景。

## 1. 包内文件

- `scripts/pw`：命令入口脚本
- `scripts/pw.mjs`：核心控制逻辑（Playwright）
- `install.sh`：一键安装依赖脚本
- `examples/demo-commands.sh`：最小演示脚本

## 2. 环境要求

- macOS（默认使用本机 Google Chrome）
- Node.js 18+ 和 npm
- 网络可访问目标网站

## 3. 快速安装

```bash
cd pw-browser-control-kit
./install.sh
```

安装完成后，建议设置环境变量（可选）：

```bash
export PW="$(pwd)/scripts/pw"
# 如 Chrome 不在默认路径，可手动指定
# export PW_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## 4. 快速开始

### 4.1 启动浏览器并打开页面

```bash
$PW start
$PW open https://chatgpt.com/auth/login
$PW title
$PW snapshot
```

### 4.2 常用命令

```bash
$PW click 'button:has-text("Log in")'
$PW fill 'input[type="email"]' 'test@example.com'
$PW fill 'input[type="password"]' 'Aa123456!xYz'
$PW screenshot login.png
$PW exists 'text=Continue'
$PW wait 'input[type="text"]' 15000
$PW eval 'location.href'
$PW stop
```

## 5. Cloudflare / 人机协作建议

当页面出现 Cloudflare 人机验证时，自动化通常不稳定，建议改为人工协作：

1. 脚本推进到验证页后暂停。
2. 人工在可视化浏览器中点击“确认您是真人”。
3. 再继续执行后续命令。

## 6. 故障排查

### 6.1 无法连接会话

```bash
$PW stop
$PW start
$PW status
```

### 6.2 页面空白或卡住

```bash
$PW restart
$PW open https://chatgpt.com
```

### 6.3 看不到控制窗口

先关闭其他 Chrome，再重启会话：

```bash
pkill -f 'Google Chrome'
$PW start
```

## 7. 日志和截图位置

- 会话文件：`~/.pw-session.json`
- 运行日志：`~/.pw.log`
- 截图目录：`/tmp/pw-screenshots/`

## 8. 分发建议

发给别人时，直接发送以下任意一个压缩包：

- `pw-browser-control-kit-*.zip`
- `pw-browser-control-kit-*.tar.gz`

对方解压后执行 `./install.sh` 即可使用。
