#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# Still Gallery — 启动包装器，由 systemd / launchd 调用。
#
# 为什么不让服务管理器直接 `exec node server.mjs`：
#
#   1. 本项目**不读 .env**（README 已明确说明）。systemd 有 EnvironmentFile=，
#      launchd 没有对应的键，只能用 EnvironmentVariables 写死。用同一个包装器
#      抹平这个差异，两个平台的环境变量来源因此完全一致。
#   2. node 的绝对路径因机器而异（nvm / Homebrew / apt / 手工安装）。集中在这里
#      解析，换机器时不用改 unit 文件。
#   3. 结尾用 `exec` 替换掉自身，SIGTERM 才会直达 node —— 否则信号只发给 sh，
#      服务管理器会等到超时才强杀，`systemctl stop` 会白等 90 秒。
#
# 这个脚本是**自定位**的：它永远假定自己在 <项目>/scripts/service/ 下，
# 所以不需要在安装时把路径写进来，直接拷到别的机器也能用。
# ─────────────────────────────────────────────────────────────────────
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

if [ ! -f "$PROJECT/server.mjs" ]; then
  echo "[still-gallery] 在 $PROJECT 下找不到 server.mjs，脚本位置不对？" >&2
  exit 78
fi

# ── 环境变量文件 ─────────────────────────────────────────────────────
# 优先 STILL_GALLERY_ENV_FILE（安装脚本会按平台填好），否则退回项目根的 .env。
# 文件里出现的变量会**覆盖**服务管理器已经设好的同名变量。
ENV_FILE="${STILL_GALLERY_ENV_FILE:-$PROJECT/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# ── 解析 node ────────────────────────────────────────────────────────
# 顺序：STILL_GALLERY_NODE（可在环境变量文件里指定）→ PATH → 常见安装位置。
NODE_BIN="${STILL_GALLERY_NODE:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE_BIN" ]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
# nvm 单独处理：它的目录名是版本号，且 macOS 自带的 sort 没有 -V。
# 服务管理器起的进程没有 shell 初始化，PATH 里不会有 nvm，所以这里必须兜住。
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  nvm_latest=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort | tail -n 1 || true)
  if [ -n "${nvm_latest:-}" ] && [ -x "$HOME/.nvm/versions/node/$nvm_latest/bin/node" ]; then
    NODE_BIN="$HOME/.nvm/versions/node/$nvm_latest/bin/node"
  fi
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[still-gallery] 找不到可执行的 node。" >&2
  echo "  修法：在环境变量文件里加一行 STILL_GALLERY_NODE=/绝对路径/node" >&2
  exit 127
fi

# 服务端不依赖 cwd（ROOT 由 server.mjs 自身位置推出），但设成项目根更符合直觉，
# 也保证相对路径的 DATA_DIR 落在预期的地方。
cd "$PROJECT"

exec "$NODE_BIN" "$PROJECT/server.mjs"
