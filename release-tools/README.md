# BaudLab 打包发布工具（release-tools）

本目录是客户端的**一键打包 + GitHub 发布**工具，以及发布产物归档目录。
产物（`output/`）、临时构建目录（`.work/`）和本机设置（`local-settings.json`）
已在 `.gitignore` 中排除；工具脚本本身进 git。

> 一个版本 = 一个 GitHub Release，同时包含**客户端安装包**和**服务器部署包**，
> 两者版本号一致。完整分发与升级说明见 `docs/RELEASE_AND_DEPLOYMENT.md`。

## 工具组成

| 文件 | 作用 |
| --- | --- |
| `start-release-tool.bat` | 双击启动（自动挑选 Python 3.10+ 含 Tkinter） |
| `release_gui.py` | Tkinter 界面：版本号 / 显示名称 / 安装包前缀 / 版本说明 / 发布目标 / 进度条 |
| `release_core.py` | 无界面流水线：同步元数据 → 构建 → 校验 → 提交元数据 → push → tag → Release 上传公开 |
| `verify-artifacts.cjs` | 构建后校验安装包、`latest.yml`、`app-update.yml`、asar 与 MCP 资源 |
| `server/` | 服务器部署包模板（启动脚本、示例配置、部署 README） |
| `RELEASE_NOTES.md` | 当前待发布的版本说明（会被写入 Release 与更新提示） |

## 日常使用

```
release-tools\start-release-tool.bat
```

界面流程：

1. 点「环境自检」：确认依赖、服务器源文件/模板、发布说明、部署文档齐全。
2. 填写版本号（`x.y.z`）、显示名称、安装包前缀、Release 标题（可空）、版本说明。
3. 填 GitHub token（需目标仓库 Contents 读写权限）。默认仅内存保存；勾选右侧「记住 token」后写入
   `release-tools/local-settings.json`（明文，已被 `.gitignore` 忽略，不会进仓库或安装包）。
4. 「仅打包」只本地构建；「打包并发布」额外推送分支、创建 tag、上传并公开 Release。

> 发布前请先**人工提交所有源码改动**：工具只提交发布元数据
> （`package.json` / `package-lock.json` / `RELEASE_NOTES.md`），其余未提交改动会阻断发布。
> **远程**同名 tag 不会被覆盖；若远程 tag 已被删除而本地仍有同名残留 tag，工具会把它重建到当前提交。

## 产物

构建输出到 `release-tools/output/<tag>/`：

```
BaudLab-Setup-x.y.z.exe            # 客户端安装包
BaudLab-Setup-x.y.z.exe.blockmap   # 增量更新校验
latest.yml                         # electron-updater 更新清单（必须随 Release 上传）
BaudLab-Server-x.y.z.zip           # 服务器部署包（仅管理员）
SHA256SUMS.txt                     # 全部资产校验值
release-notes-<tag>.md             # 版本说明存档
RELEASE_AND_DEPLOYMENT.md          # 分发/部署说明副本
manifest.json                      # 本次发布元数据 + 源码指纹
```

> 构建成功后自动清理：删除本次 `release-tools/.work/` 临时目录，并把
> `release-tools/output/` 收敛为最新一份。上次失败遗留的 `.work/` 会在下次构建开始时清掉。

## 发布流程清单

1. 人工提交所有源码改动。
2. `start-release-tool.bat` → 环境自检 → 填版本与说明 → 打包并发布。
3. 发布完成后 Release 内已含客户端、`latest.yml`、服务器 ZIP 与校验清单。
4. 官网下载区客户端/服务器卡片均指向 `/releases/latest`，无需随版本改动。

## 故障排查

### `EnsureEmptyDir ... app.asar: being used by another process`

构建时报 `remove dist/win-unpacked/resources/app.asar: ... being used by another
process`，是 **app.asar 被驱动级锁死**（本机为绿盾过滤驱动持有；无用户态进程，
重启才释放）。发布工具已改用独立临时输出目录规避，如仍遇到：

```
set CODEBUDDY_SAFE_DELETE_ENABLED=0
npm run build -- -c.directories.output=dist-新目录名
```

**根治**：重启电脑（锁全清）→ 删掉旧 `dist*/` 残留 → 之后用 GUI 工具正常打包。

### 自检报「缺少文件」

按提示补齐，常见的是漏了 `docs/RELEASE_AND_DEPLOYMENT.md` 或 `release-tools/server/` 模板。

## 相关文档

- `docs/RELEASE_AND_DEPLOYMENT.md`：客户端 / 服务器分发、部署、升级与旧 Gitee 迁移。
- `docs/ENGINEERING_TODO.md`：工程问题与待办总表。
