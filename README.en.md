<img src="banner.gif" alt="BaudLab" width="1500">

<div align="center">

# BaudLab · 波特律动

**One-stop serial protocol management & debugging**

Visual protocol config · Real-time debugging · List sending · File transfer · AI assistant · MCP integration

[Website](https://alvan1819184.gitee.io/baudlab) · [Download](https://alvan1819184.gitee.io/baudlab/#download) · [Docs](https://alvan1819184.gitee.io/baudlab/#docs) · [Feedback](https://alvan1819184.gitee.io/baudlab/#feedback)

</div>

---

## About

> Bits dance on the wire; protocols become clear on screen.

BaudLab is a desktop tool for embedded development — protocol config, signal management, real-time debugging and file transfer, all in one app. Local-first by design: your protocol data never leaves your machine.

> This repository hosts the BaudLab website & landing page. Installers are distributed via the [official download page](https://alvan1819184.gitee.io/baudlab/#download).

## Features

| Module | Description |
|---|---|
| Visual Protocol Config | Graphical frame structure, signals & bit fields; reusable templates |
| Real-time Serial Debugging | Live TX/RX monitoring, Hex / text dual view, millisecond timestamps |
| List Sending | Schedule commands in cycles, with variable injection & delay control |
| File Transfer | Built-in AFT-1 protocol: chunking, checksum & progress management |
| AI Assistant | Natural-language protocol rules & debug command generation |
| MCP Integration | Built-in MCP server — AI coding tools talk to your serial port directly |
| Frame Codec Engine | Custom binary formats: endianness, bit fields, checksums |
| Local Database | SQLite local storage, fully offline, data stays on your machine |
| Review Queue | Audited protocol changes for confident team collaboration |

## Download

Latest stable **v0.0.40** (2025-09-29) · Windows 10/11 x64 · 65.4 MB · Free · MIT License

Get the installer from the official download page: <https://alvan1819184.gitee.io/baudlab/#download>

## Local Preview

This repository is a pure static page with no build step:

```bash
# Option 1: open directly in a browser
open index.html

# Option 2: serve locally
npx serve .
```

## Tech Stack

- Website: single-file HTML (inline CSS/JS, zero dependencies, Inter + JetBrains Mono)
- App: Electron + Vue 3 + SQLite (better-sqlite3) + SerialPort

## Feedback

- In-app feedback: Settings → Feedback (auto-attaches runtime info, fastest response)
- Website feedback form: <https://alvan1819184.gitee.io/baudlab/#feedback>

## License

[MIT](LICENSE)
