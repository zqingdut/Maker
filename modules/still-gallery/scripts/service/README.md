# 常驻服务脚本

把 Still Gallery 装成开机自启的后台服务。支持 Linux（systemd）和 macOS（launchd）。

## 这个目录要整体拷贝

安装脚本会读同目录下的模板文件，**只拷 `install-service.sh` 是不够的**：

| 文件 | 谁需要 | 作用 |
|---|---|---|
| `install-service.sh` | 两个平台 | 安装 / 卸载 |
| `service.sh` | 两个平台 | status / start / stop / restart / logs |
| `still-gallery.service` | **仅 Linux** | systemd unit 模板 |
| `run-server.sh` | **仅 macOS** | 包装脚本（launchd 没有 `EnvironmentFile`，只能靠它注入环境变量） |
| `com.still-gallery.server.plist` | **仅 macOS** | launchd 模板 |

> Linux 的 unit 直接 `ExecStart=<node> server.mjs`，**不用 `run-server.sh`**。
> 所以少拷了它 Linux 也能装——但脚本仍会提示你补齐，免得下次换 macOS 才发现。
> 反向同理：Linux 上缺 `.plist` 不影响安装。

拷贝方式任选：

```bash
# 从仓库整体拷贝
scp -r outputs/still-gallery/scripts/service user@HOST:/path/to/still-gallery/scripts/

# 或者用仓库里的打包（dist/ 下，含全部文件）
scp outputs/still-gallery/dist/sg-service-*.tar.gz user@HOST:/tmp/
ssh user@HOST 'cd /path/to/still-gallery/scripts && tar -xzf /tmp/sg-service-*.tar.gz'
```

## 一句话上手

```bash
# Linux 服务器（推荐：系统级服务，开机即起，不依赖登录）
sudo ./scripts/service/install-service.sh --host 0.0.0.0

# macOS（默认装成 LaunchAgent：登录后启动，免 sudo）
./scripts/service/install-service.sh

# macOS 要「开机即起」而不是「登录后起」
sudo ./scripts/service/install-service.sh --system --host 0.0.0.0
```

装完之后：

```bash
./scripts/service/service.sh status     # 状态 + 开机自启 + HTTP 探测
./scripts/service/service.sh logs       # 实时跟日志
./scripts/service/service.sh restart
./scripts/service/service.sh stop
```

卸载（数据、日志、环境变量文件都会保留）：

```bash
sudo ./scripts/service/install-service.sh --uninstall
```

先看看会做什么、不落盘：

```bash
./scripts/service/install-service.sh --dry-run
```

## 文件都是干什么的

| 文件 | 作用 |
|---|---|
| `install-service.sh` | 安装 / 卸载。自动识别平台、模式、node 路径，渲染模板并 enable + 启动 |
| `service.sh` | 日常控制：`start` `stop` `restart` `status` `logs` `enable` `disable` `url` `which` |
| `run-server.sh` | 启动包装器。注入环境变量 → 解析 node → `exec node server.mjs` |
| `still-gallery.service` | systemd 单元**模板**（含 `@@占位符@@`，由安装脚本替换） |
| `com.still-gallery.server.plist` | launchd 作业**模板**（同上） |

> 模板不能直接 `cp` 到 `/etc/systemd/system/` 或 `~/Library/LaunchAgents/` —— 占位符没被替换过。
> 一定要走 `install-service.sh`。

## 为什么需要 `run-server.sh`

三个原因，都不是为了好看：

1. **本项目不读 `.env`。** 这是刻意的（见主 README）。systemd 有 `EnvironmentFile=`，
   launchd 没有对应机制，只能用 `EnvironmentVariables` 写死。用同一个包装器把差异抹平，
   两个平台的环境变量来源就完全一致。
2. **node 绝对路径因机器而异。** nvm 装在 `~/.nvm/versions/node/<版本>/bin/node`，
   而服务管理器启动的进程**没有 shell 初始化**，`PATH` 里不会有 nvm。
   包装器负责解析，换机器/升级 node 只需要改一个地方。
3. **结尾必须是 `exec`。** 否则 SIGTERM 只发给 `sh`，node 收不到，
   `systemctl stop` 会一直等到 `TimeoutStopSec` 才强杀。

## 环境变量文件

安装脚本会生成一个（已存在则不覆盖，权限 `600`）：

| 平台 + 模式 | 默认位置 |
|---|---|
| Linux 系统级 | `/etc/still-gallery/still-gallery.env` |
| Linux 用户级 | `~/.config/still-gallery/still-gallery.env` |
| macOS 系统级 | `/usr/local/etc/still-gallery/still-gallery.env` |
| macOS 用户级 | `~/.config/still-gallery/still-gallery.env` |

**优先级：环境变量文件 > unit / plist 里的值。** 所以 `HOST` / `PORT` / `DATA_DIR`
默认只在文件里以注释形式出现，改的时候取消注释即可。

最常改的是 `ARK_API_KEY`。注意：**一旦在环境里设置，后台的密钥输入框会被锁定**
（env 优先级最高），这是设计如此。

改完环境变量文件要重启：

```bash
./scripts/service/service.sh restart
```

## 两个平台的差别（很重要）

| | Linux systemd | macOS LaunchAgent | macOS LaunchDaemon |
|---|---|---|---|
| 安装位置 | `/etc/systemd/system/` | `~/Library/LaunchAgents/` | `/Library/LaunchDaemons/` |
| 何时启动 | **开机**（系统级） | **用户登录后** | **开机** |
| 需要 sudo | 是 | 否 | 是 |
| 运行身份 | 调用 sudo 的用户 | 登录用户 | `UserName` 指定的用户 |
| 日志 | journald | `logs/*.log` | `logs/*.log` |

macOS 上「开机自启」和「登录后自启」是两回事。如果你希望重启机器后不用登录就
能访问画廊，必须用 `--system`（LaunchDaemon）。

Linux 用户级模式（`--user`）默认只在登录后启动，安装脚本会尝试
`loginctl enable-linger` 来让它开机自启；失败会明确告警。

## 重启为什么不会被 `KeepAlive` 拉回来

`server.mjs` 收到 SIGTERM 会**以 0 退出**。而两个平台都配置成「只在失败时重启」：

- systemd：`Restart=on-failure`
- launchd：`KeepAlive → SuccessfulExit = false`

所以正常停止（`service.sh stop`）之后不会立刻又被拉起来；真崩溃了才会自动重启。

退出前会 `app.flush()` 等 fire-and-forget 的 `metrics.json` 写完，避免丢最后一条统计。

## 日志会一直长

macOS 的 `StandardOutPath` 是**追加**写的，没有内置轮转。
Linux 走 journald，由 journald 自己管。

macOS 上如果跑很久，建议加一条 `newsyslog` 规则或定期清理：

```bash
# 手动清（会丢历史）
: > logs/still-gallery.out.log
: > logs/still-gallery.err.log
```

## 常见问题

**服务起不来** —— 先看日志（`service.sh logs`），再确认环境变量文件里的
`ARK_API_KEY` 是否是你要的那一个。缺 Key 不会导致启动失败，只会让生图返回 503。

**`bind: address already in use`** —— 端口被占了。`lsof -i :4317` 看看，
或者用 `--port` 换一个。

**`service.sh` 说找不到已安装的服务** —— 还没装，或者装到了另一个用户下面
（`~/.config/systemd/user/` 和 `~/Library/LaunchAgents/` 都是 per-user 的）。

**改了 `server.mjs` 要重启吗** —— 要。服务不会热重载：

```bash
./scripts/service/service.sh restart
```
