#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# Still Gallery — 常驻服务控制脚本
#
#   ./scripts/service/service.sh status     # 运行状态 + 开机自启是否开启
#   ./scripts/service/service.sh start
#   ./scripts/service/service.sh stop
#   ./scripts/service/service.sh restart
#   ./scripts/service/service.sh logs       # 实时跟踪日志（Ctrl-C 退出）
#   ./scripts/service/service.sh logs 200   # 只看最后 200 行
#   ./scripts/service/service.sh enable     # 开启开机自启
#   ./scripts/service/service.sh disable    # 关闭开机自启（但保留服务）
#   ./scripts/service/service.sh url        # 打印访问地址
#   ./scripts/service/service.sh which      # 打印实际安装方式与文件位置
#
# 不需要指定平台：脚本会去找已经装好的 unit / plist。装之前先跑
# install-service.sh。
# ─────────────────────────────────────────────────────────────────────
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

UNIT_NAME="still-gallery.service"
AGENT_LABEL="com.still-gallery.server"
DAEMON_LABEL="com.still-gallery.server"

say()  { printf '%s\n' "$*"; }
die()  { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }

COMMAND="${1:-status}"
shift 2>/dev/null || true

# ── 找出装在哪里 ─────────────────────────────────────────────────────
MODE=""
TARGET=""
DOMAIN=""
LABEL=""

if [ -f "/etc/systemd/system/$UNIT_NAME" ]; then
  MODE="linux-system"; TARGET="/etc/systemd/system/$UNIT_NAME"; CTL="systemctl"
elif [ -f "$HOME/.config/systemd/user/$UNIT_NAME" ]; then
  MODE="linux-user"; TARGET="$HOME/.config/systemd/user/$UNIT_NAME"; CTL="systemctl --user"
elif [ -f "$HOME/Library/LaunchAgents/$AGENT_LABEL.plist" ]; then
  MODE="mac-agent"; TARGET="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
  DOMAIN="gui/$(id -u)"; LABEL="$AGENT_LABEL"
elif [ -f "/Library/LaunchDaemons/$DAEMON_LABEL.plist" ]; then
  MODE="mac-daemon"; TARGET="/Library/LaunchDaemons/$DAEMON_LABEL.plist"
  DOMAIN="system"; LABEL="$DAEMON_LABEL"
else
  die "没找到已安装的服务。先跑：$SCRIPT_DIR/install-service.sh"
fi

# 系统级单元要提权
SUDO=""
case "$MODE" in
  linux-system|mac-daemon)
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
    ;;
esac
priv() { $SUDO "$@"; }

LOG_DIR="$PROJECT/logs"

# ── 从已安装的配置里读出监听地址 ─────────────────────────────────────
read_setting() { # $1=变量名
  name="$1"
  # 先看环境变量文件（它优先级更高），再看 unit / plist
  env_file=$(read_env_file_path)
  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    value=$(sed -n "s/^[[:space:]]*$name=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}[[:space:]]*$/\1/p" "$env_file" | tail -n 1)
    if [ -n "${value:-}" ]; then printf '%s' "$value"; return 0; fi
  fi
  case "$MODE" in
    linux-system|linux-user)
      value=$(sed -n "s/^Environment=$name=//p" "$TARGET" | tail -n 1)
      ;;
    mac-agent|mac-daemon)
      value=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$name" "$TARGET" 2>/dev/null || true)
      ;;
  esac
  printf '%s' "${value:-}"
}

read_env_file_path() {
  case "$MODE" in
    linux-system|linux-user)
      sed -n 's/^EnvironmentFile=-*//p' "$TARGET" | tail -n 1
      ;;
    mac-agent|mac-daemon)
      /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:STILL_GALLERY_ENV_FILE" "$TARGET" 2>/dev/null || true
      ;;
  esac
}

# ── 各命令 ───────────────────────────────────────────────────────────
case "$COMMAND" in
  which)
    say "安装方式 : $MODE"
    say "配置文件 : $TARGET"
    say "环境变量 : $(read_env_file_path)"
    say "数据目录 : $(read_setting DATA_DIR)"
    say "日志目录 : $LOG_DIR"
    ;;

  url)
    host=$(read_setting HOST); [ -n "${host:-}" ] || host="127.0.0.1"
    port=$(read_setting PORT); [ -n "${port:-}" ] || port="4317"
    if [ "$host" = "0.0.0.0" ] || [ "$host" = "::" ]; then host="<本机IP>"; fi
    say "http://$host:$port/"
    say "http://$host:$port/admin"
    ;;

  start)
    case "$MODE" in
      linux-system|linux-user) # shellcheck disable=SC2086
        priv $CTL start "$UNIT_NAME" ;;
      mac-agent|mac-daemon)
        priv launchctl kickstart "$DOMAIN/$LABEL" ;;
    esac
    say "已启动。"
    ;;

  stop)
    case "$MODE" in
      linux-system|linux-user) # shellcheck disable=SC2086
        priv $CTL stop "$UNIT_NAME" ;;
      mac-agent|mac-daemon)
        # 发 SIGTERM。server.mjs 会以 0 退出，所以 KeepAlive 不会把它拉起来。
        priv launchctl kill SIGTERM "$DOMAIN/$LABEL" ;;
    esac
    say "已停止。"
    ;;

  restart)
    case "$MODE" in
      linux-system|linux-user) # shellcheck disable=SC2086
        priv $CTL restart "$UNIT_NAME" ;;
      mac-agent|mac-daemon)
        priv launchctl kickstart -k "$DOMAIN/$LABEL" ;;
    esac
    say "已重启。"
    ;;

  enable)
    case "$MODE" in
      linux-system|linux-user) # shellcheck disable=SC2086
        priv $CTL enable "$UNIT_NAME" ;;
      mac-agent|mac-daemon)
        priv launchctl enable "$DOMAIN/$LABEL" ;;
    esac
    say "已开启开机自启。"
    ;;

  disable)
    case "$MODE" in
      linux-system|linux-user) # shellcheck disable=SC2086
        priv $CTL disable "$UNIT_NAME" ;;
      mac-agent|mac-daemon)
        priv launchctl disable "$DOMAIN/$LABEL" ;;
    esac
    say "已关闭开机自启（服务本身仍在，只是下次开机不再自动拉起）。"
    ;;

  logs)
    lines="${1:-100}"
    case "$MODE" in
      linux-system) journalctl -u "$UNIT_NAME" -n "$lines" -f ;;
      linux-user)   journalctl --user -u "$UNIT_NAME" -n "$lines" -f ;;
      mac-agent|mac-daemon)
        if [ -f "$LOG_DIR/still-gallery.out.log" ] || [ -f "$LOG_DIR/still-gallery.err.log" ]; then
          say "── 跟踪 $LOG_DIR/still-gallery.{out,err}.log（Ctrl-C 退出）──"
          tail -n "$lines" -f "$LOG_DIR"/still-gallery.out.log "$LOG_DIR"/still-gallery.err.log 2>/dev/null || true
        else
          warn "还没生成日志文件：$LOG_DIR"
          say "服务可能一次都没启动过。先跑 service.sh status 看看。"
        fi
        ;;
    esac
    ;;

  status)
    say "安装方式 : $MODE"
    say "配置文件 : $TARGET"
    say ""
    case "$MODE" in
      linux-system|linux-user)
        # shellcheck disable=SC2086
        $CTL --no-pager --full status "$UNIT_NAME" || true
        say ""
        say "开机自启 : $(priv $CTL is-enabled "$UNIT_NAME" 2>/dev/null || echo '未知')"
        ;;
      mac-agent|mac-daemon)
        # launchctl print 失败时 stdout 是空的（错误走 stderr），所以要先存下来再判断，
        # 不能写成 `... | sed ... || say 未加载` —— 管道的退出码是 sed 的，永远是 0。
        if snapshot=$(priv launchctl print "$DOMAIN/$LABEL" 2>/dev/null); then
          printf '%s\n' "$snapshot" | sed -n '1,16p'
          say ""
          if priv launchctl print-disabled "$DOMAIN" 2>/dev/null | grep -q "\"$LABEL\" => true"; then
            say "开机自启 : 已禁用"
          else
            say "开机自启 : 已启用"
          fi
        else
          say "未加载：这个作业现在不在 launchd 里。"
          say "  如果是在非 GUI 会话里执行的（SSH、CI、agent），launchctl 会拒绝，"
          say "  报 'Bootstrap failed: 5'。在 Terminal.app 里跑同一个命令即可。"
        fi
        ;;
    esac

    # 顺手探一下 HTTP，确认真的在服务
    host=$(read_setting HOST); [ -n "${host:-}" ] || host="127.0.0.1"
    port=$(read_setting PORT); [ -n "${port:-}" ] || port="4317"
    probe_host="$host"; [ "$probe_host" = "0.0.0.0" ] && probe_host="127.0.0.1"
    if command -v curl >/dev/null 2>&1; then
      # 注意：连接失败时 curl 自己就会输出 000 并返回非 0，
      # 所以不能写 `|| echo 000` —— 会拼成 000000。
      code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 3 "http://$probe_host:$port/" 2>/dev/null || true)
      [ -n "${code:-}" ] || code="000"
      say ""
      if [ "$code" = "200" ]; then
        say "HTTP 探测 : 200 OK → http://$probe_host:$port/"
      else
        say "HTTP 探测 : 无响应（code=${code}）。服务可能没起来，或端口不是 ${port}。"
      fi
    fi
    ;;

  *)
    die "不认识的命令：${COMMAND}（用 --help 看用法）"
    ;;
esac
