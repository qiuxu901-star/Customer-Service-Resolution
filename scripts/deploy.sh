#!/usr/bin/env bash
# 独立版本目录 + 外置数据目录，健康检查失败时恢复旧服务。
# 用法：bash deploy.sh <发布包>
# 空白数据上线：RESET_DATA=1 bash deploy.sh <发布包>（不复用旧库）
# 隔离预检：DEPLOY_DRY_RUN=1 APP_DIR=/tmp/csr-check bash deploy.sh <发布包>
set -Eeuo pipefail
APP_DIR=${APP_DIR:-/opt/customer-service-resolution}
PORT=${PORT:-8818}
SERVICE=${SERVICE:-csr}
NODE_BIN=${NODE_BIN:-node}
SRC_TARBALL=${1:-}
DEPLOY_DRY_RUN=${DEPLOY_DRY_RUN:-0}
RESET_DATA=${RESET_DATA:-0}
BIND_HOST=${BIND_HOST:-127.0.0.1}
SYSTEMD_UNIT_DIR=${SYSTEMD_UNIT_DIR:-/etc/systemd/system}
RUN_USER=${SUDO_USER:-$(id -un)}
log(){ echo "[deploy] $*"; }
if [ -z "$SRC_TARBALL" ] || [ ! -f "$SRC_TARBALL" ]; then echo '请提供存在的发布包' >&2; exit 1; fi
if [[ "$APP_DIR" != /* || "$APP_DIR" = / || "$APP_DIR" =~ [[:space:]] ]]; then echo '部署目录必须为无空白的绝对路径且不能为根目录' >&2; exit 1; fi
if [[ ! "$SERVICE" =~ ^[a-zA-Z0-9_-]+$ || ! "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo '服务名称或端口无效' >&2; exit 1; fi
if [[ ! "$RESET_DATA" =~ ^[01]$ || ! "$DEPLOY_DRY_RUN" =~ ^[01]$ ]]; then echo 'RESET_DATA 和 DEPLOY_DRY_RUN 只能为 0 或 1' >&2; exit 1; fi
if [[ "$BIND_HOST" != 127.0.0.1 && "$BIND_HOST" != 0.0.0.0 ]]; then echo 'BIND_HOST 只能为 127.0.0.1 或 0.0.0.0' >&2; exit 1; fi
if ! NODE_BIN=$(command -v "$NODE_BIN"); then echo '未找到Node' >&2; exit 1; fi
NODE_MAJOR=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then echo '需要Node >=18' >&2; exit 1; fi
if [ "$DEPLOY_DRY_RUN" != 1 ] && [ ! -w "$SYSTEMD_UNIT_DIR" ]; then echo '需要systemd配置写入权限' >&2; exit 1; fi
if [ -e "$APP_DIR/current" ] && [ ! -L "$APP_DIR/current" ]; then echo 'current 必须为符号链接' >&2; exit 1; fi
mkdir -p "$APP_DIR/releases" "$APP_DIR/backups"
RELEASE=$(mktemp -d "$APP_DIR/releases/release-XXXXXXXX")
ARCHIVE_LIST="$RELEASE/archive-paths.txt"
tar -tzf "$SRC_TARBALL" > "$ARCHIVE_LIST"
if awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}' "$ARCHIVE_LIST"; then echo '发布包含不安全路径' >&2; exit 1; fi
rm "$ARCHIVE_LIST"
tar -xzf "$SRC_TARBALL" -C "$RELEASE" --strip-components=1
if [ ! -f "$RELEASE/solve-eval-app/server.js" ]; then echo '发布包结构无效' >&2; exit 1; fi
if [ -e "$RELEASE/solve-eval-app/data" ] || [ -L "$RELEASE/solve-eval-app/data" ]; then echo '发布包不得包含运行数据目录' >&2; exit 1; fi
for file in "$RELEASE"/solve-eval-app/*.js; do "$NODE_BIN" --check "$file"; done
if [ "$DEPLOY_DRY_RUN" = 1 ]; then log "发布包预检通过；未停止服务、修改运行数据或切换版本。候选目录：$RELEASE"; exit 0; fi
PREVIOUS=$(readlink "$APP_DIR/current" 2>/dev/null || true)
CURRENT_DATA=$(readlink "$APP_DIR/current/solve-eval-app/data" 2>/dev/null || true)
UNIT_FILE="$SYSTEMD_UNIT_DIR/$SERVICE.service"
HAD_UNIT=0
WAS_ACTIVE=0
BACKUP=$(mktemp -d "$APP_DIR/backups/deploy-XXXXXXXX")
chmod 700 "$BACKUP"
if [ -e "$UNIT_FILE" ]; then cp -p "$UNIT_FILE" "$BACKUP/service.unit"; HAD_UNIT=1; fi
if systemctl is-active --quiet "$SERVICE"; then WAS_ACTIVE=1; fi
rollback(){
  trap - ERR
  set +e
  systemctl stop "$SERVICE"
  if [ -n "$PREVIOUS" ]; then
    ln -s "$PREVIOUS" "$APP_DIR/current.rollback.$$"
    mv -Tf "$APP_DIR/current.rollback.$$" "$APP_DIR/current"
  elif [ -L "$APP_DIR/current" ]; then
    rm "$APP_DIR/current"
  fi
  if [ "$HAD_UNIT" = 1 ]; then cp -p "$BACKUP/service.unit" "$UNIT_FILE"; else rm -f "$UNIT_FILE"; fi
  systemctl daemon-reload
  if [ "$WAS_ACTIVE" = 1 ]; then systemctl restart "$SERVICE"; fi
  log '部署失败，已恢复旧版本链接和服务配置；旧业务数据未删除'
  exit 1
}
trap 'rollback' ERR
LOAD_STATE=$(systemctl show "$SERVICE" -p LoadState --value)
if [ "$LOAD_STATE" != not-found ]; then systemctl stop "$SERVICE"; fi
# 服务停止后再备份或迁移，避免旧进程在切换期间写入数据。
"$NODE_BIN" - "$PORT" <<'NODE'
const net=require('node:net');
const server=net.createServer();
server.once('error',error=>{console.error('目标端口不可用：'+error.message);process.exitCode=1;});
server.listen(Number(process.argv[2]),'0.0.0.0',()=>server.close());
NODE
LEGACY_DATA="$APP_DIR/solve-eval-app/data"
DATA_DIR="$APP_DIR/data"
if [[ "$CURRENT_DATA" = "$APP_DIR/"* ]]; then DATA_DIR="$CURRENT_DATA"; fi
if [ "$RESET_DATA" = 1 ]; then
  DATA_DIR="$APP_DIR/data-$(basename "$RELEASE")"
  mkdir "$DATA_DIR"
  log '本次使用全新数据目录，旧方案、评级记录及模型配置不沿用'
else
  mkdir -p "$DATA_DIR"
  if [ -z "$PREVIOUS" ] && [ -f "$LEGACY_DATA/db.json" ]; then
    if [ -f "$DATA_DIR/db.json" ] && ! cmp -s "$LEGACY_DATA/db.json" "$DATA_DIR/db.json"; then echo '新旧数据目录均有不同数据，迁移中止' >&2; false; fi
    if [ -f "$LEGACY_DATA/auth.json" ]; then
      cp -p "$LEGACY_DATA/auth.json" "$BACKUP/legacy-auth.json"
      if [ -f "$DATA_DIR/auth.json" ] && ! cmp -s "$LEGACY_DATA/auth.json" "$DATA_DIR/auth.json"; then echo '新旧账号数据不同，迁移中止' >&2; false; fi
      if [ ! -f "$DATA_DIR/auth.json" ]; then cp -p "$LEGACY_DATA/auth.json" "$DATA_DIR/auth.json"; fi
    fi
    cp -p "$LEGACY_DATA/db.json" "$BACKUP/legacy-db.json"
    if [ ! -f "$DATA_DIR/db.json" ]; then cp -p "$LEGACY_DATA/db.json" "$DATA_DIR/db.json"; fi
  fi
  if [ -f "$DATA_DIR/auth.json" ]; then
    "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$DATA_DIR/auth.json"
    cp -p "$DATA_DIR/auth.json" "$BACKUP/auth.json"
  fi
  if [ -f "$DATA_DIR/db.json" ]; then
    "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$DATA_DIR/db.json"
    cp -p "$DATA_DIR/db.json" "$BACKUP/db.json"
  fi
fi
chmod 700 "$DATA_DIR"
chown "$RUN_USER" "$DATA_DIR"
chmod 755 "$RELEASE"
ln -s "$DATA_DIR" "$RELEASE/solve-eval-app/data"
ln -s "$RELEASE" "$APP_DIR/current.next.$$"
mv -Tf "$APP_DIR/current.next.$$" "$APP_DIR/current"
cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Customer Service Resolution
After=network.target
[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR/current/solve-eval-app
ExecStart=$NODE_BIN server.js
Environment=PORT=$PORT
Environment=HOST=$BIND_HOST
Environment=CSR_DATA_DIR=$DATA_DIR
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
for attempt in 1 2 3 4 5; do
  if curl --max-time 5 -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    trap - ERR
    log "新版本健康检查通过；代码：${RELEASE}；数据：${DATA_DIR}"
    exit 0
  fi
  sleep 1
done
echo '新版本健康检查失败' >&2
false
