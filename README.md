<img src="banner.gif" alt="BaudLab 波特律动" width="1500">

<div align="center">

# 波特律动 · BaudLab

**一站式串口协议管理与调试工具**

可视化协议配置 · 实时调试 · 列表发送 · 文件传输 · AI 助手 · MCP 接入

[官网](https://alvan1819184.gitee.io/baudlab) · [下载](https://alvan1819184.gitee.io/baudlab/#download) · [文档](https://alvan1819184.gitee.io/baudlab/#docs) · [反馈](https://alvan1819184.gitee.io/baudlab/#feedback)

</div>

---

## 简介

> 比特在线上律动，协议在屏上清明。

波特律动（BaudLab）是一款面向嵌入式开发的桌面工具——把协议配置、信号管理、实时调试、文件传输收进一个应用，告别靠猜和 print 调串口的时代。本地优先设计，协议数据始终留在你的机器上。

> 本仓库为波特律动官网与发布页源码，安装包通过[官网下载页](https://alvan1819184.gitee.io/baudlab/#download)分发。

## 功能特性

| 模块 | 说明 |
|---|---|
| 可视化协议配置 | 图形化定义帧结构、信号与位域，模板一键复用 |
| 实时串口调试 | 收发数据实时监视，Hex / 文本双视图，毫秒级时间戳 |
| 列表发送 | 多指令周期自动发送，支持变量注入与延时控制 |
| 文件传输 | 内置 AFT-1 协议，分包、校验与进度管理 |
| AI 助手 | 自然语言生成解析规则与调试指令 |
| MCP 接入 | 内置 MCP 服务器，AI 编码工具直连串口 |
| 帧编解码引擎 | 自定义二进制协议格式，大小端 / 位域 / 校验灵活配置 |
| 本地数据库 | SQLite 本地存储，离线可用，数据不出本机 |
| 审核队列 | 协议变更留痕审计，团队协作更安心 |

## 下载

当前稳定版本 **v0.0.40**（2025-09-29）· Windows 10/11 x64 · 65.4 MB · 免费 · MIT License

前往官网下载页获取安装包：<https://alvan1819184.gitee.io/baudlab/#download>

## 本地预览官网

本仓库为纯静态页面，无构建依赖：

```bash
# 方式一：直接用浏览器打开
open index.html

# 方式二：本地起服务
npx serve .
```

## 技术栈

- 官网：单文件 HTML（内联 CSS/JS，零依赖，Inter + JetBrains Mono）
- 应用：Electron + Vue 3 + SQLite（better-sqlite3）+ SerialPort

## 反馈

- 应用内反馈：设置 → 反馈（自动附带运行环境信息，响应最快）
- 官网反馈表单：<https://alvan1819184.gitee.io/baudlab/#feedback>

## License

[MIT](LICENSE)
