#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# Still Gallery — 安装为常驻服务（开机自启）
#
# 自动识别平台与 init 系统：
#   Linux  → systemd    /etc/systemd/system/still-gallery.service
#                       ~/.config/systemd/user/still-gallery.service
#   macOS  → launchd    ~/Library/LaunchAgents/     （用户登录后启动，免 sudo）
#                       /Library/LaunchDaemons/     （开机即启动，需 sudo）
#
# 用法：
#   ./scripts/service/install-service.sh                   # 自动选模式并安装
#   sudo ./scripts/service/install-service.sh              # 强制系统模式
#   ./scripts/service/install-service.sh --user            # 强制用户模式
#   sudo ./scripts/service/install-service.sh --uninstall  # 卸载
#
# 选项：
#   --host HOST        监听地址（默认 127.0.0.1；对外访问填 0.0.0.0）
#   --port PORT        监听端口（默认 4317）
#   --data-dir DIR     数据目录（默认 <项目>/data）
#   --env-file FILE    环境变量文件（默认见 --dry-run 的打印）
#   --node PATH        node 可执行文件（默认从 PATH 里找）
#   --run-user USER    以哪个用户运行（仅系统模式）
#   --system / --user  强制系统模式或用户模式
#   --dry-run          只打印将要做什么，不写任何文件
#   -y, --yes          不交互确认
#   -h, --help         看这段说明
#
# 幂等：可以反复运行。已存在的环境变量文件不会被覆盖。
# ─────────────────────────────────────────────────────────────────────
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

UNIT_NAME="still-gallery.service"
AGENT_LABEL="com.still-gallery.server"
DAEMON_LABEL="com.still-gallery.server"

RUNNER="$SCRIPT_DIR/run-server.sh"
SYSTEMD_TEMPLATE="$SCRIPT_DIR/$UNIT_NAME"
PLIST_TEMPLATE="$SCRIPT_DIR/$AGENT_LABEL.plist"

ACTION="install"
MODE=""
HOST="127.0.0.1"
PORT="4317"
DATA_DIR=""
ENV_FILE=""
NODE_BIN=""
RUN_USER=""
ASSUME_YES=0
DRY_RUN=0

# ── 输出小工具 ───────────────────────────────────────────────────────
say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m警告：%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Still Gallery 服务安装脚本

用法：
  ./scripts/service/install-service.sh                   # 自动选模式并安装
  sudo ./scripts/service/install-service.sh              # 强制系统模式
  ./scripts/service/install-service.sh --user            # 强制用户模式
  sudo ./scripts/service/install-service.sh --uninstall  # 卸载

选项：
  --host HOST        监听地址（默认 127.0.0.1；对外访问填 0.0.0.0）
  --port PORT        监听端口（默认 4317）
  --data-dir DIR     数据目录（默认 <项目>/data）
  --env-file FILE    环境变量文件
  --node PATH        node 可执行文件（默认从 PATH 里找）
  --run-user USER    以哪个用户运行（仅系统模式）
  --system / --user  强制系统模式或用户模式
  --dry-run          只打印将要做什么，不写任何文件
  -y, --yes          不交互确认
  -h, --help         看这段说明

装完用 scripts/service/service.sh {status|logs|restart|stop|start} 管理。
USAGE
  exit 0
}

# ── 解析参数 ─────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION="uninstall" ;;
    --system)    MODE="system" ;;
    --user)      MODE="user" ;;
    --host)      HOST="${2:?--host 需要参数}"; shift ;;
    --port)      PORT="${2:?--port 需要参数}"; shift ;;
    --data-dir)  DATA_DIR="${2:?--data-dir 需要参数}"; shift ;;
    --env-file)  ENV_FILE="${2:?--env-file 需要参数}"; shift ;;
    --node)      NODE_BIN="${2:?--node 需要参数}"; shift ;;
    --run-user)  RUN_USER="${2:?--run-user 需要参数}"; shift ;;
    --dry-run)   DRY_RUN=1 ;;
    -y|--yes)    ASSUME_YES=1 ;;
    -h|--help)   usage ;;
    *) die "不认识的参数：$1（用 --help 看用法）" ;;
  esac
  shift
done

# ── 平台探测 ─────────────────────────────────────────────────────────
PLATFORM=$(uname -s)
case "$PLATFORM" in
  Linux)  PLATFORM_KIND="linux" ;;
  Darwin) PLATFORM_KIND="darwin" ;;
  *)      die "只支持 Linux 与 macOS，当前是 ${PLATFORM}。" ;;
esac

if [ -z "$MODE" ]; then
  if [ "$PLATFORM_KIND" = "linux" ]; then MODE="system"; else MODE="user"; fi
fi

# 有 sudo 且不是 root 时，系统路径的读写都走 sudo
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi
# 系统模式下必须能提权
if [ "$MODE" = "system" ] && [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; then
  die "系统模式需要 root 权限，但这台机器没有 sudo。改用 --user。"
fi

# ── 卸载分支：不依赖 node / 项目完整性，尽早返回 ─────────────────────
if [ "$ACTION" = "uninstall" ]; then
  step "卸载 Still Gallery 服务（${PLATFORM_KIND}）"
  if [ "$PLATFORM_KIND" = "linux" ]; then
    for spec in "system:$SUDO:/etc/systemd/system/$UNIT_NAME" \
                "user::${HOME}/.config/systemd/user/$UNIT_NAME"; do
      scope="${spec%%:*}"; rest="${spec#*:}"; s="${rest%%:*}"; path="${rest#*:}"
      [ -f "$path" ] || continue
      if [ "$DRY_RUN" = 1 ]; then
        say "  [dry-run] 移除 $path"
        continue
      fi
      if [ "$scope" = "system" ]; then
        $s systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
        $s rm -f "$path"
        $s systemctl daemon-reload 2>/dev/null || true
      else
        systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
        rm -f "$path"
        systemctl --user daemon-reload 2>/dev/null || true
      fi
      say "  已移除 $path"
    done
  else
    # 每个条目自带「是否需要提权」：用户 Agent 在 ~/Library/LaunchAgents，
    # 永远不需要 root；系统 Daemon 才需要。两处都套 $SUDO 会让 --user 装的
    # 作业在卸载时反向索要 root 密码，非交互环境下直接失败（set -eu 会中断）。
    for spec in "gui/$(id -u)::${HOME}/Library/LaunchAgents/$AGENT_LABEL.plist" \
                "system:$SUDO:/Library/LaunchDaemons/$DAEMON_LABEL.plist"; do
      domain="${spec%%:*}"; rest="${spec#*:}"; s="${rest%%:*}"; path="${rest#*:}"
      [ -f "$path" ] || continue
      if [ "$DRY_RUN" = 1 ]; then
        say "  [dry-run] 移除 $path"
        continue
      fi
      $s launchctl bootout "$domain" "$path" >/dev/null 2>&1 || true
      # 不套 || true 会在 set -e 下把「权限不足」变成静默中断；显式报错更好。
      if $s rm -f "$path"; then
        say "  已移除 $path"
      else
        say "  ⚠ 移除失败（权限不足？）：$path"
      fi
    done
  fi
  say ""
  say "数据目录、日志、环境变量文件都保持原样（里面可能有 API Key），要删自己删。"
  exit 0
fi

# ── 基本校验 ─────────────────────────────────────────────────────────
[ -f "$PROJECT/server.mjs" ] || die "在 $PROJECT 下找不到 server.mjs，脚本位置不对？"

# 只校验**当前平台真正会用到**的文件：
#   Linux → unit 里是 `ExecStart=<node> server.mjs`，环境变量走 systemd 的
#           EnvironmentFile，**根本不用 run-server.sh**。缺了它也必须能装。
#   macOS → launchd 没有 EnvironmentFile，只能靠 run-server.sh 注入环境变量。
# 早先这里无条件要求 run-server.sh，导致 Linux 上「缺一个永远不会被读到的文件」
# 就装不了（报错还只提第一个缺的，看不出到底缺几个）。
if [ "$PLATFORM_KIND" = "linux" ]; then
  REQUIRED="$SYSTEMD_TEMPLATE"
else
  REQUIRED="$RUNNER $PLIST_TEMPLATE"
fi

MISSING=""
for f in $REQUIRED; do
  [ -f "$f" ] || MISSING="${MISSING}
  - $f"
done
if [ -n "$MISSING" ]; then
  die "缺少安装所需的文件：${MISSING}

完整的 $SCRIPT_DIR 应当有 5 个文件：
  install-service.sh              安装 / 卸载
  service.sh                      status / start / stop / restart / logs
  run-server.sh                   包装脚本（仅 macOS 需要）
  still-gallery.service           systemd 模板（仅 Linux 需要）
  com.still-gallery.server.plist  launchd 模板（仅 macOS 需要）

最常见的原因是只拷了一部分 —— 请把整个 scripts/service/ 目录一起拷过来。"
fi

# ── 解析 node ────────────────────────────────────────────────────────
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE_BIN" ]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
[ -n "$NODE_BIN" ] || die "找不到 node。请用 --node /绝对路径/node 指定。"
[ -x "$NODE_BIN" ] || die "$NODE_BIN 不可执行。"
# 规范化成绝对路径：nvm 这类装在版本号目录下的路径必须写死进 unit 文件
NODE_BIN=$(CDPATH= cd -- "$(dirname -- "$NODE_BIN")" && pwd)/$(basename -- "$NODE_BIN")
NODE_DIR=$(dirname -- "$NODE_BIN")

NODE_MAJOR=$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "无法识别 node 版本：$NODE_BIN" ;;
esac
[ "$NODE_MAJOR" -ge 20 ] || die "需要 Node 20+，而 $NODE_BIN 是 $("$NODE_BIN" -v 2>/dev/null || echo 未知版本)。"

# ── 默认路径 ─────────────────────────────────────────────────────────
[ -n "$DATA_DIR" ] || DATA_DIR="$PROJECT/data"

if [ -z "$ENV_FILE" ]; then
  if [ "$PLATFORM_KIND" = "linux" ] && [ "$MODE" = "system" ]; then
    ENV_FILE="/etc/still-gallery/still-gallery.env"
  elif [ "$PLATFORM_KIND" = "darwin" ] && [ "$MODE" = "system" ]; then
    ENV_FILE="/usr/local/etc/still-gallery/still-gallery.env"
  else
    ENV_FILE="$HOME/.config/still-gallery/still-gallery.env"
  fi
fi

LOG_DIR="$PROJECT/logs"

# 运行身份：系统模式默认沿用「调用 sudo 的那个人」，而不是 root。
if [ -z "$RUN_USER" ]; then
  if [ "$MODE" = "system" ]; then
    RUN_USER="${SUDO_USER:-$(id -un)}"
  else
    RUN_USER="$(id -un)"
  fi
fi
RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null || id -gn)

# ── 提权包装（用户模式一律不提权，避免把文件写成 root 所有）──────────
priv() {
  if [ "$MODE" = "system" ] && [ -n "$SUDO" ]; then
    $SUDO "$@"
  else
    "$@"
  fi
}

# ── 模板渲染 ─────────────────────────────────────────────────────────
esc() { printf '%s' "$1" | sed -e 's/[&|]/\\&/g'; }

render() {
  sed \
    -e "s|@@PROJECT@@|$(esc "$PROJECT")|g" \
    -e "s|@@RUNNER@@|$(esc "$RUNNER")|g" \
    -e "s|@@NODE_DIR@@|$(esc "$NODE_DIR")|g" \
    -e "s|@@NODE@@|$(esc "$NODE_BIN")|g" \
    -e "s|@@ENV_FILE@@|$(esc "$ENV_FILE")|g" \
    -e "s|@@DATA_DIR@@|$(esc "$DATA_DIR")|g" \
    -e "s|@@LOG_DIR@@|$(esc "$LOG_DIR")|g" \
    -e "s|@@RUN_USER@@|$(esc "$RUN_USER")|g" \
    -e "s|@@RUN_GROUP@@|$(esc "$RUN_GROUP")|g" \
    -e "s|@@LABEL@@|$(esc "$AGENT_LABEL")|g" \
    -e "s|@@HOST@@|$(esc "$HOST")|g" \
    -e "s|@@PORT@@|$(esc "$PORT")|g" \
    "$1"
}

# 从 stdin 落盘并设权限
write_priv() { # $1=目标路径 $2=权限
  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] 将写入 $1（权限 $2），内容如下："
    sed 's/^/      | /'
    return 0
  fi
  priv mkdir -p "$(dirname -- "$1")"
  priv tee "$1" >/dev/null
  priv chmod "$2" "$1"
  say "  已写入 $1"
}

# ── 环境变量文件 ─────────────────────────────────────────────────────
ensure_env_file() {
  if [ -e "$ENV_FILE" ]; then
    say "  已存在，保持不动：$ENV_FILE"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] 创建 ${ENV_FILE}（权限 600）"
    return 0
  fi
  priv mkdir -p "$(dirname -- "$ENV_FILE")"
  priv tee "$ENV_FILE" >/dev/null <<EOF
# Still Gallery 环境变量文件
# 由 scripts/service/install-service.sh 生成。
#
# 这个文件在服务启动时被注入进程环境。本项目**不会自动读取它** ——
# 是 systemd 的 EnvironmentFile= 或 run-server.sh 把它 source 进去的。
#
# 权限应为 600：里面通常放着 API Key。

# ── 生图凭据 ─────────────────────────────────────────────────────────
# 火山方舟 API Key。
# 注意：一旦在这里设置，后台「AI 生成」里的密钥输入框会被锁定（env 优先级最高）。
# ARK_API_KEY=

# 兼容网关地址，一般不用改
# ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3

# ── 运行参数 ─────────────────────────────────────────────────────────
# 下面几项安装时已经写进 unit / plist 了，**需要覆盖时**才取消注释。
# 这里的值优先级更高。改完记得重启：scripts/service/service.sh restart

# HOST=$HOST
# PORT=$PORT
# DATA_DIR=$DATA_DIR

# node 绝对路径。换机器或升级 node 后服务起不来时，改这里。
# STILL_GALLERY_NODE=$NODE_BIN
EOF
  priv chmod 600 "$ENV_FILE"
  say "  已创建 ${ENV_FILE}（权限 600）"
}

# ── Linux / systemd ──────────────────────────────────────────────────
install_linux() {
  command -v systemctl >/dev/null 2>&1 || die "没有 systemctl，这台机器不是 systemd 环境。"

  if [ "$MODE" = "system" ]; then
    TARGET="/etc/systemd/system/$UNIT_NAME"
    CTL="systemctl"
  else
    TARGET="$HOME/.config/systemd/user/$UNIT_NAME"
    CTL="systemctl --user"
  fi

  step "安装 systemd 单元（$MODE 模式）"
  render "$SYSTEMD_TEMPLATE" | write_priv "$TARGET" 644

  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] $CTL daemon-reload && $CTL enable --now $UNIT_NAME"
    return 0
  fi

  # shellcheck disable=SC2086
  $CTL daemon-reload
  # shellcheck disable=SC2086
  $CTL enable --now "$UNIT_NAME"

  if [ "$MODE" = "user" ]; then
    # 用户级服务默认「登录才起」。开启 linger 才能做到开机自启。
    if command -v loginctl >/dev/null 2>&1; then
      if loginctl enable-linger "$RUN_USER" 2>/dev/null; then
        say "  已开启 linger：$RUN_USER 未登录时也会启动"
      else
        warn "开启 linger 失败 —— 这个用户级服务只会在你登录后才启动。"
        warn "手动开启：sudo loginctl enable-linger $RUN_USER"
      fi
    fi
  fi

  say ""
  # shellcheck disable=SC2086
  $CTL --no-pager --full status "$UNIT_NAME" || true
}

# ── macOS / launchd ──────────────────────────────────────────────────
install_darwin() {
  command -v launchctl >/dev/null 2>&1 || die "没有 launchctl。"

  if [ "$MODE" = "system" ]; then
    TARGET="/Library/LaunchDaemons/$DAEMON_LABEL.plist"
    DOMAIN="system"
    LABEL="$DAEMON_LABEL"
  else
    TARGET="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
    DOMAIN="gui/$(id -u)"
    LABEL="$AGENT_LABEL"
  fi

  step "安装 launchd 作业（$MODE 模式）"
  if [ "$MODE" = "system" ]; then
    say "  LaunchDaemon：开机时启动，以 $RUN_USER 身份运行。"
  else
    say "  LaunchAgent：**用户登录后**启动（不是开机即启）。要开机即启用 --system。"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say "  [dry-run] 将写入 ${TARGET}（权限 644），内容如下："
    render "$PLIST_TEMPLATE" | sed 's/^/      | /'
    if [ "$MODE" = "system" ]; then
      say "      + 追加 <key>UserName</key><string>$RUN_USER</string>"
    fi
    say "  [dry-run] launchctl bootstrap $DOMAIN $TARGET"
    return 0
  fi

  # LaunchDaemon 需要 UserName 键，LaunchAgent 不允许有这个键，
  # 所以不在模板里写死，而是渲染完之后按需补上。
  TMP_PLIST=$(mktemp "${TMPDIR:-/tmp}/still-gallery-plist.XXXXXX")
  render "$PLIST_TEMPLATE" >"$TMP_PLIST"
  if [ "$MODE" = "system" ]; then
    /usr/libexec/PlistBuddy -c "Add :UserName string $RUN_USER" "$TMP_PLIST" >/dev/null
  fi
  plutil -lint "$TMP_PLIST" >/dev/null || die "渲染出来的 plist 不合法，已中止。"

  priv mkdir -p "$(dirname -- "$TARGET")" "$LOG_DIR"
  priv cp "$TMP_PLIST" "$TARGET"
  priv chmod 644 "$TARGET"
  rm -f "$TMP_PLIST"
  say "  已写入 $TARGET"

  # 重复安装时先卸掉旧作业，避免 bootstrap 因为 label 已存在而失败。
  priv launchctl bootout "$DOMAIN" "$TARGET" >/dev/null 2>&1 || true

  if bootstrap_err=$(priv launchctl bootstrap "$DOMAIN" "$TARGET" 2>&1); then
    priv launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
    say ""
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,14p' || true
  else
    # `Bootstrap failed: 5: Input/output error` 几乎总是这一个原因：
    # 调用者不在用户的图形登录会话里（SSH、CI、后台 agent 都会这样）。
    # plist 本身没问题，也已经装到位置上了 —— 下次登录时 launchd 会自己加载。
    printf '%s\n' "$bootstrap_err" >&2
    warn "launchctl 拒绝了这次加载。"
    warn "最常见的原因：当前进程不在图形登录会话里（SSH / CI / 后台 agent 里执行就会这样）。"
    warn "plist 已经装好：$TARGET"
    warn "它会在你下次登录时自动启动。想现在就起，在 Terminal.app 里重跑一遍这个命令。"
    say ""
    say "  验证：$SCRIPT_DIR/service.sh status"
  fi
}

# ── 主流程 ───────────────────────────────────────────────────────────
step "Still Gallery 服务安装"
say "  平台      : $PLATFORM ($PLATFORM_KIND)"
say "  模式      : $MODE"
say "  项目目录  : $PROJECT"
say "  node      : $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null || echo '?'))"
say "  监听      : $HOST:$PORT"
say "  数据目录  : $DATA_DIR"
say "  环境文件  : $ENV_FILE"
say "  运行身份  : $RUN_USER:$RUN_GROUP"
say "  日志      : $LOG_DIR"
if [ "$DRY_RUN" = 1 ]; then
  say "  （dry-run，不会真的写文件）"
fi

if [ "$ASSUME_YES" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  printf '\n继续？[y/N] '
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) say "已取消。"; exit 0 ;;
  esac
fi

step "准备目录"
if [ "$DRY_RUN" -ne 1 ]; then
  priv mkdir -p "$DATA_DIR" "$LOG_DIR"
  if [ "$MODE" = "system" ] && [ -n "$SUDO" ]; then
    # 目录归运行用户所有，否则它写不进 uploads/
    $SUDO chown "$RUN_USER:$RUN_GROUP" "$DATA_DIR" "$LOG_DIR" 2>/dev/null || true
  fi
fi
say "  $DATA_DIR"
say "  $LOG_DIR"

step "环境变量文件"
ensure_env_file

if [ "$PLATFORM_KIND" = "linux" ]; then
  install_linux
else
  install_darwin
fi

step "完成"
say "  状态 : $SCRIPT_DIR/service.sh status"
say "  日志 : $SCRIPT_DIR/service.sh logs"
say "  重启 : $SCRIPT_DIR/service.sh restart"
say ""
if [ "$HOST" = "0.0.0.0" ]; then
  say "  画廊首页 http://<本机IP>:$PORT/"
else
  say "  画廊首页 http://$HOST:$PORT/"
fi
say "  管理后台 http://$HOST:$PORT/admin"
