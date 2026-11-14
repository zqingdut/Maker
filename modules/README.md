# Modules

这两个子项目从私有仓库 `zqingdut/fucc` 的 `outputs/` 目录移过来（2026-11-14），
为以后整合进 Maker 个人主页做准备。

## still-gallery

零依赖的 Node.js 图片 + 提示词画廊（Node >= 20，不用数据库，不用 npm install）。

- 公开画廊 `GET /`：瀑布流照片墙，主界面不显示提示词，点进详情页才展示完整提示词。
- 管理后台 `GET /admin`：单管理员账户，8 个标签页（AI 生成 / 生成记录 / 导入图片 /
  日志导入 / 已入库作品 / 生成指标 / 运行日志 / 数据导出）。
- 排队生图：默认同时跑 8 个（后台可调 1–32），提示词记录存在浏览器 localStorage。
- 两个生图上游：火山方舟（`ARK_API_KEY`）和 01ai 网关（relay，`IMAGE_RELAY_TOKEN`）。
  每次生成先打本机网关 `http://127.0.0.1:4399`，失败才退回配置的域名地址。
- 启动：`node server.mjs`，默认 `http://127.0.0.1:4317`。

## image-gateway

FastAPI + uvicorn 的本地媒体 API 替身，根据一次真实浏览器会话抓包（`capture/spec.json`，已脱敏）重建。
三种模式，按真实程度递增：

- `mock`（默认）：本地应答，不花钱、不触网，给前端开发和测试用。
- `relay`（中转）：把匹配的请求原样转发给真实上游并原样返回。
- `gateway`（中转站）：`POST /v1/images` 的对外封装，持有凭据、计量花费、把结果
  转存成短链接，而不是 2.9 MB 的 base64。

启动：`./run.sh`，默认 `http://127.0.0.1:4399`。

## 注意

- 这两个都是**服务端项目**，GitHub Pages 只能托管静态文件，所以它们在 Maker 仓库里
  只是源码托管、不会在 `zqingdut.github.io/Maker` 上跑起来。以后整合进主页的方式
  是链接/展示，或者部署到别处（VPS / Cloud Run / Vercel）再从主页链过去。
- 二进制演示图片（约 30 MB 的 PNG：still-gallery 的 6 张 demo 图、
  image-gateway 的手册截图和 captured-generated.png）这次**没有一起搬过来**，
  原因是推送通道只支持文本文件。它们都可以用仓库里的脚本重新生成
  （still-gallery：`scripts/make_demo_assets.py`；image-gateway：
  `scripts/build_manual.py` + `scripts/collect_manual_assets.py`），
  也可以以后从 GitHub 网页端直接上传。
- 两个项目各自的 `.gitignore` 都排除了运行时状态和凭据（`data/auth.json`、
  `data/images.json`、`deploy/image-gateway.env`、`.env` 等），搬过来的只是源码和种子数据，
  不含任何密钥。
