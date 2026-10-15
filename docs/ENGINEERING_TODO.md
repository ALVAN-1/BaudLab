# BaudLab 工程问题与待办

记录日期：2026-10-13。依据本次工程分析的源码检查、内存数据库测试和模拟串口测试整理。

状态约定：未勾选表示尚未修复；已勾选表示代码和必要验证已完成。模拟测试不代表真实硬件测试。本次实施优先处理发布、服务器分发和客户端更新，其余问题保留为后续任务。

## 本次发布流程改造

- [x] R01：提供标准库 Tkinter 编写的 Python 发布界面，支持版本号、显示名称、安装包前缀、版本说明、Git remote、tag 和阶段进度。验收：离线可启动，工作线程不阻塞界面，构建日志和错误可见。（`release-tools/release_gui.py` + `release_core.py`，新增「环境自检」）
- [x] R02：统一客户端版本元数据，生成安装包、更新清单、服务器部署 ZIP、说明和 SHA256 校验清单。验收：同一版本资产完整，服务器包不含真实配置、数据库或凭据。（`release_core.build` / `server_zip` / `SHA256SUMS.txt`）
- [x] R03：支持明确触发的 Git 推送、不可覆盖的版本 tag 和 GitHub Release 上传。验收：发布前核对工作区与版本，先草稿上传全部资产再公开；失败报告当前阶段，不静默覆盖 tag。（`release_core._publish`）
- [x] R04：客户端默认从 GitHub Releases 检查更新，单机模式也可用。修复旧版本误判、下载失败提示、重复监听和退出安装流程。验收：检查、下载、进度、安装状态有完整回归验证。（`update-controller.js` + `tests/update-controller.test.js`，`npm run test:updates` 11 项通过）
- [x] R05：补充客户端/服务器下载选择、服务器部署及升级说明、旧 Gitee/团队更新源版本的一次性迁移说明。（`docs/RELEASE_AND_DEPLOYMENT.md`、官网下载区「团队服务器」卡片、README 与 release-tools/README）

## 本次功能改造：客户端内嵌团队服务器与局域网发现

目标：小队协作不必先让管理员单独部署 `BaudLab-Server.zip` 并安装 Node.js——任意一台客户端即可一键在同一局域网内充当主机，其他成员自动发现并接入。保持客户端/服务器分离发行不变，也不改 `server.js` 的零依赖约束。

- [x] E01：内嵌服务器管理。新增 `server-embed.js`，通过 Electron 自带运行时（`ELECTRON_RUN_AS_NODE`）以子进程方式启动与独立部署**完全相同**的 `server.js`，复用全部 API 与数据格式；支持 start/stop/restart/status/getConfig/setConfig/regenerateToken。验收：`node --check` 通过，端到端实测启动、带令牌 200 / 无令牌 401、停止正常。
- [x] E02：端口与配置。优先使用配置端口（默认 3010），被占用时自动顺延 3011–3099；配置/数据库/备份落到可写的用户数据目录，安装目录只读不影响运行。验收：占用端口后能自动换端口启动。
- [x] E03：内嵌默认强制随机访问令牌。局域网明文 HTTP 下空 token 等于无鉴权，内嵌启动时若配置无令牌则生成随机长令牌，界面提供复制与重置。验收：成员必须携带令牌才能访问 API。
- [x] E04：孤儿进程防护。子进程 stdin 保持管道，宿主客户端退出时管道关闭，`server.js` 据此自动退出，避免残留后台服务器。验收：关闭客户端后内嵌服务器进程随之结束。
- [x] E05：`server.js` 增加环境变量覆盖（`BAUDLAB_SERVER_CONFIG` / `BAUDLAB_SERVER_DIR` / `BAUDLAB_PORT` / `BAUDLAB_EMBEDDED`）、内嵌静默模式与机器可读输出（`BAUDLAB_SERVER_READY/ADDR/ERROR`），并在 `server.on('error')` 上报端口占用。验收：`node --check` 通过，独立部署行为不变。
- [x] E06：局域网发现。新增 `mdns.js`，用纯 JS 的 `bonjour-service` 做 advertise/browse（不手写 mDNS）。验收：本机 advertise + browse 往返可相互发现。
- [x] E07：打包内置服务端。`scripts/afterPack.js` 把 `server.js`、`db-schema.js`、`default-protocol-data.js` 及裁剪后的 `better-sqlite3` 复制到 `resources/server/`（asar 之外，原生 `.node` 从真实文件系统加载）。验收：打包产物 `resources/server/` 约 1.85 MB，可从该目录自包含启动并输出 ready 行。
- [x] E08：客户端界面与主进程接线。`main.js` 接入 `teamServer`/`discovery` 实例、IPC 处理器、`autoStart` 与 `before-quit` 清理；`preload.js` 暴露 `teamServer`/`discovery`；`DatabaseConnectionView.vue` 增加「本机作为主机」卡片与「局域网发现的服务器」列表。验收：`node --check` 与 `vite build` 通过。
- [x] E09：文档同步。（`README.md` / `README.en.md` 两种共享方式、`docs/RELEASE_AND_DEPLOYMENT.md` 资产与打包说明、`release-tools/server/README.md`）

遗留（非本次范围，登记待办）：内嵌主机仍是**明文 HTTP**，仅适用于可信内网；若将来需要跨网段/公网，需另行引入 TLS 与更强鉴权。

## 高优先级：权限与数据安全

- [ ] S01：封堵用户表 REPLACE 授权绕过。server.js 的用户写入授权只处理 INSERT/UPDATE/DELETE，REPLACE INTO users 在内存数据库复现了角色修改。验收：普通工程师使用 INSERT 和 REPLACE 都不能提升权限。
- [ ] S02：服务器审核验证指定审核人。AuditReviewView.vue 有指定人限制，server.js 审核分支只验证待审核和非自审。验收：非指定审核人直接请求也被拒绝；合法代审政策需明确。
- [ ] S03：内置 AI 危险工具走统一确认入口。ai-assistant.js 直接 tool.execute，绕过 ai-tools.js 的 executeTool 确认；MCP 已走共享确认入口。验收：内置 AI 和 MCP 对危险工具采取相同授权规则。
- [ ] S04：限制通用 SQL 查询读取 users 敏感字段，并明确公网访问边界。server.js 查询仅验证团队 token，可能读到 password_hash 与 api_token 哈希；默认空 token 放行且监听 0.0.0.0。验收：敏感列不可通过普通查询读取，非授权网络请求被拒绝。

## 中优先级：日志、串口与协议发布

- [ ] D01：移除启动时无条件清空 serial_logs，制定可配置保留策略；批量写失败保留待写数据或报告丢失。证据：main.js 启动清表与日志批写分支。验收：重启保留历史，数据库暂时写失败后可恢复。
- [ ] D02：串口发送与关闭等待真实回调，发送必要时等待 drain，错误返回给 UI。证据：main.js 当前过早返回成功。AFT 有对端 ACK，不能据此判定所有文件传输都会假完成。
- [ ] D03：旧 draft_publish 接入正常审核与完整事务，修复 saveDraft 引用不存在的 protocols.created_by 且吞异常。正常 UI 的 useReviewQueue.js 已有审核路径。验收：AI/MCP 与 UI 发布遵守同样的字段和审核规则。
- [ ] F01：修正 AFT DATA 分块预算，除帧开销外扣除 4 字节 blockIdx。fileTransferSender.js 满载帧比 MTU 多 4 字节；MTU 1024 时解码器拒收。验收：所有支持 MTU 的编码帧不超限，尤其覆盖 1024。
- [ ] F02：修复最终 CRC 失败后的重新传输状态。发送端只清本地状态，远端仍返回 resumeFrom=totalBlocks，第二轮不发送 DATA。验收：CRC 失败后取消/重置双方状态并真实重发全部块。

## 维护与开发体验

- [ ] M01：修正 npm run dev 与开发 URL/入口的配合。目前 dev 不启动 Vite，开发窗口又访问 localhost:5173 根入口；官网和 Vue 入口分别为 index.html / dev.index.html。
- [ ] M02：为权限、AI 确认、AFT 边界和发布流程补充必要回归检查。此前未找到注释提到的 tests/verify-ai.js、verify-file-transfer.js，也没有统一测试命令。
- [ ] M03：逐步拆分 main.js、server.js、App.vue 和 ProtocolConfigView.vue 的大模块；优先按权限、串口、更新和协议编辑边界拆分，避免一次性重构。

## 已有验证基础

- Vue 构建此前通过；存在较大 chunk 和 Vite 配置模块类型警告。
- 核心 CommonJS 文件此前通过 node --check。
- 权限、AI 和 AFT 问题使用纯内存/模拟验证，未连接真实串口、未修改真实数据库。
- MCP 资源已在 scripts/afterPack.js 中复制，不列为打包遗漏问题。
- 用户已有 dist-1014/ 保留；不要自动提交该目录或任何构建产物。
