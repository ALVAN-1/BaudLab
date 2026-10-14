# 发布与部署说明

本文件说明 BaudLab 客户端与团队服务器如何打包、分发和升级。发布操作统一走
`release-tools/start-release-tool.bat`（Python + Tkinter 界面），一个版本一次发布，
客户端与服务器同源同版本。

## 资产清单（每个版本一个 GitHub Release）

`release-tools/release_core.py` 每次打包都会在 `release-tools/output/<tag>/` 生成：

| 资产 | 用途 | 谁需要 |
| --- | --- | --- |
| `BaudLab-Setup-<version>.exe` | Windows 客户端安装包 | 所有成员 |
| `BaudLab-Setup-<version>.exe.blockmap` | 增量更新校验 | 客户端自动更新 |
| `latest.yml` | electron-updater 更新清单 | 客户端自动更新（必须上传） |
| `BaudLab-Server-<version>.zip` | 团队服务器部署包 | 仅管理员 |
| `SHA256SUMS.txt` | 全部资产校验值 | 可选核对 |
| `release-notes-<tag>.md` | 版本说明存档 | 可选 |
| `manifest.json` | 本次发布元数据 / 源码指纹 | 工具自身 |

服务器 ZIP 内只含 `server.js`、`db-schema.js`、`default-protocol-data.js`、`LICENSE`、
启动脚本、`README.md`、`server.config.example.json` 和 `VERSION.json`。
**不含生产数据库、访问令牌或 SMTP 配置。**

## 客户端分发

- 官网下载区 `index.html`（客户端卡片）链接到 `/releases/latest`，无需随版本改动。
- 客户端安装包只从 GitHub Release 获取；不提供独立渠道，避免版本错配。

## 服务器分发（2.2）

服务器与客户端**共用同一个 Release**，一次发布两边同步：

1. 在发布工具里打包并发布当前版本。
2. Release 页面除客户端安装包外，还会带上 `BaudLab-Server-<version>.zip`。
3. 官网下载区新增「团队服务器」卡片，指向同一个
   `https://github.com/ALVAN-1/BaudLab.io/releases/latest`，由管理员按需下载。
4. 成员安装客户端即可，**不需要**各自运行服务器。

这样服务器端有明确去向：它不再「藏在 git 页面」——它是同一 Release 的正式资产，
官网有独立入口，版本号与服务端 `VERSION.json` 一一对应。

### 首次部署

1. 在一台成员可访问的电脑安装 Node.js **22.13 或更高版本**（内置 `node:sqlite`，
   无需 `npm install`）。
2. 解压 `BaudLab-Server-<version>.zip` 全部文件到固定目录，例如 `D:\BaudLab-Server`；
   不要只复制 `server.js`。
3. Windows 双击 `start-server.bat`，Linux/macOS 执行 `sh start-server.sh`；控制台保持运行。
   默认端口 `3010`。首次启动生成 `server.config.json` 与 `server-data/`。
4. 管理员在服务器本机打开 `http://localhost:3010/admin`（仅本机可访问），设置团队访问
   令牌、SMTP 和备份策略。
5. 成员在客户端「数据库连接」页填写 `http://服务器内网IP:3010` 与相同令牌，测试后保存；
   防火墙放行团队内网访问该端口。

> 服务当前监听 `0.0.0.0`，默认空 token 不限制 API。首次部署应在可信内网完成并立即设置
> 令牌，不要直接暴露公网。相关安全遗留问题见 `docs/ENGINEERING_TODO.md`。

### 服务器升级

客户端自动更新**不会**升级服务器，两者独立升级：

1. 停止服务器（控制台 Ctrl+C；作为服务运行的则停止该服务）。
2. 完整备份原目录，尤其是 `server.config.json`、`server-data/` 及自定义数据库/备份路径。
3. 用新版 ZIP 替换代码、启动脚本和 `VERSION.json`，**保留**实际配置与数据。
4. 重启，检查管理台与成员连接。回退时同时恢复备份代码与数据库。

## 客户端自动更新（2.3）

客户端用 `electron-updater` 从 GitHub Release 检查更新，更新源固化在安装包内的
`app-update.yml`（`provider: github` + `owner/repo`）。

- 启动后 10 秒首检，之后每 30 分钟静默检查一次；发现新版本弹系统通知 / 托盘气泡。
- 用户点击通知进入更新面板，可查看版本说明、下载（带进度条）、下载完成后一键安装。
- 团队服务器可通过 SSE `/api/update/stream` 通知在线客户端「有新版本」，客户端据此触发
  一次检查；实际更新源始终是 GitHub Release。

### 用户如何获取新版本

1. **自动**：应用内静默检查，弹通知，点击即可下载安装。
2. **手动**：应用内「关于/更新」入口点「检查更新」。
3. **网页**：官网下载区 → `/releases/latest`，始终指向最新稳定版。

无论哪条路径，最终都指向同一个 GitHub Release 的安装包与 `latest.yml`。

### 上传要求（不可省略）

自动更新依赖 Release 中的 `latest.yml` 与安装包 `.exe`。发布工具已把它们作为正式资产
上传；不要只上传 exe 而漏掉 `latest.yml`，否则客户端检查不到更新。

## 从旧版 Gitee / 团队更新源的一次性迁移

1.0.0 之前客户端安装包内的更新源指向私有 Gitee（`provider: generic`），
公开用户检查更新会 403。迁移方式：

1. 新版本安装包已改为 `provider: github`；**旧版本无法自动跳到新源**，需要用户手动
   下载一次 v1.0.0 或更高版本的安装包覆盖安装。
2. 从 v1.0.0 起，后续版本的自动更新走 GitHub Release，无需再手动迁移。
3. 官网与 README 文案已统一改为 GitHub 渠道；如仍有旧 Gitee 链接，用
   `release-tools/migrate-index-html.js` 的写法批量替换并校验命中数。

## 发布操作速查

```
release-tools\start-release-tool.bat      # 打开界面
```

界面流程：填写版本号 / 显示名称 / 安装包前缀 / 版本说明 → 选择「仅打包」或「打包并发布」
→ 工具同步元数据、构建、校验资产、创建并推送 tag、创建并公开 Release。
发布前请先人工提交所有源码改动（工具只提交发布元数据）。
