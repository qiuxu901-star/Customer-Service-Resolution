#!/usr/bin/env bash
# Customer-Service-Resolution 部署 / 更新脚本
# 设计原则：不影响服务器上其他项目 —— 独立目录、独立端口、独立 systemd 单元、独立日志
# 用法：
#   首次部署：  ./deploy.sh /path/to/csr-v1.0.0.tar.gz
#   版本更新：  ./deploy.sh /path/to/csr-v1.1.0.tar.gz   （数据目录不动，记录保留）
# 可用环境变量覆盖：APP_DIR / PORT / SERVICE / NODE_BIN
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/customer-service-resolution}
PORT=${PORT:-8818}
SERVICE=${SERVICE:-csr}
NODE_BIN=${NODE_BIN:-node}
SRC_TARBALL=${1:-}

log() { echo "[deploy] $*"; }

if [ "$(id -u)" -ne 0 ] && [ ! -w /etc/systemd/system ]; then
  echo "需要 root 或 sudo 权限（写 systemd 单元）。请用 sudo 运行：sudo $0 $*" >&2
  exit 1
fi

# ---------- 1. 代码落地 ----------
if [ -z "$SRC_TARBALL" ]; then
  echo "用法: $0 <封版tar包>" >&2
  exit 1
fi
if [ ! -f "$SRC_TARBALL" ]; then
  echo "找不到封版包: $SRC_TARBALL" >&2
  exit 1
fi
mkdir -p "$APP_DIR"
# 保留数据目录，仅替换代码
if [ -d "$APP_DIR/data" ]; then
  DATA_BAK=$(mktemp -d)
  cp -r "$APP_DIR/data" "$DATA_BAK/data"
fi
rm -rf "${APP_DIR:?}/"*
tar -xzf "$SRC_TARBALL" -C "$APP_DIR" --strip-components=1
if [ -n "${DATA_BAK:-}" ]; then
  mkdir -p "$APP_DIR/solve-eval-app"
  rm -rf "$APP_DIR/solve-eval-app/data"
  mv "$DATA_BAK/data" "$APP_DIR/solve-eval-app/data"
  rm -rf "$DATA_BAK"
  log "已保留原有数据目录"
else
  log "首次部署：数据目录为空，启动后自动初始化"
fi
cd "$APP_DIR/solve-eval-app"

# ---------- 2. Node 运行时检查 ----------
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node >= 18，或设置 NODE_BIN 指向可用 node。" >&2
  exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node 版本过低（$($NODE_BIN -v)），需要 >= 18。可设置 NODE_BIN 指向新版 node。" >&2
  exit 1
fi
log "Node: $($NODE_BIN -v)"

# ---------- 3. 端口占用检查 ----------
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  # 若端口被本服务占用则允许（重启场景）
  if ! ss -tlnp 2>/dev/null | grep ":$PORT " | grep -q "$SERVICE"; then
    echo "端口 $PORT 已被其他进程占用，请换 PORT（如 PORT=8819）后重试。" >&2
    exit 1
  fi
fi
log "端口: $PORT"

# ---------- 4. systemd 单元（独立服务，不动其他单元） ----------
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Customer Service Resolution (客服 AI 解决能力价值评估)
After=network.target

[Service]
Type=simple
User=$( [ "$(id -u)" -eq 0 ] && echo "${SUDO_USER:-root}" || echo "$(id -un)" )
WorkingDirectory=$APP_DIR/solve-eval-app
ExecStart=$NODE_BIN server.js
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Restart=always
RestartSec=3
StandardOutput=append:$APP_DIR/server.log
StandardError=append:$APP_DIR/server.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
log "systemd 服务已启动: $SERVICE"

# ---------- 5. 防火墙放行（尽力而为，失败不阻断） ----------
if command -v ufw >/dev/null 2>&1 && ufw status >/dev/null 2>&1; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 && log "ufw 已放行 $PORT/tcp" || log "ufw 放行失败，请手动检查"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && log "firewalld 已放行 $PORT/tcp" || log "firewalld 放行失败，请手动检查"
else
  log "未检测到 ufw/firewalld；若服务器在云厂商控制台，请在安全组放行 $PORT/tcp"
fi

# ---------- 6. 健康检查 ----------
sleep 2
if curl -sf "http://localhost:$PORT/api/bootstrap" >/dev/null; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  log "部署成功 → http://${IP:-<服务器IP>}:$PORT"
  log "管理: systemctl status|restart|stop $SERVICE · 日志: tail -f $APP_DIR/server.log"
else
  echo "健康检查失败，最近日志：" >&2
  journalctl -u "$SERVICE" -n 20 --no-pager >&2 || tail -20 "$APP_DIR/server.log" >&2
  exit 1
fi
