#!/usr/bin/env bash
# 在 Oracle Cloud Free Tier 的 Ubuntu VM 上首次部署本项目时运行一次。
# 用法: 把整个 refurb_tracker 文件夹上传到服务器后，在该目录下执行:
#   chmod +x deploy/setup_vm.sh && sudo ./deploy/setup_vm.sh
set -euo pipefail

APP_DIR="/opt/refurb_tracker"
SERVICE_NAME="refurb-tracker"

echo ">>> 安装系统依赖 (python3 / venv)"
apt-get update -y
apt-get install -y python3 python3-venv python3-pip

echo ">>> 部署代码到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
# 假设当前脚本是从项目根目录下的 deploy/ 执行的；只拷运行需要的文件(不带日志和本地 state)
cp ./stock_checker.py ./config.json ./requirements.txt "${APP_DIR}/"

echo ">>> 创建虚拟环境并安装依赖"
python3 -m venv "${APP_DIR}/venv"
"${APP_DIR}/venv/bin/pip" install --upgrade pip
"${APP_DIR}/venv/bin/pip" install -r "${APP_DIR}/requirements.txt"

echo ">>> 收紧 config.json 权限 (内含密钥，仅所有者可读写)"
chmod 600 "${APP_DIR}/config.json"
chown -R ubuntu:ubuntu "${APP_DIR}"

echo ">>> 安装 systemd 服务"
cp ./deploy/refurb-tracker.service "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo ">>> 完成。查看运行状态: sudo systemctl status ${SERVICE_NAME}"
echo ">>> 查看实时日志: sudo journalctl -u ${SERVICE_NAME} -f"
