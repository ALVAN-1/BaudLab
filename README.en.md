<img src="banner.gif" alt="BaudLab" width="1500">

[![English](https://img.shields.io/badge/Language-English-blue)](README.en.md) [![简体中文](https://img.shields.io/badge/Language-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](README.md)

![release](https://img.shields.io/badge/release-v0.0.40-blue) ![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20%C2%B7%20x64-lightgrey) ![license](https://img.shields.io/badge/license-MIT-green) ![stars](https://img.shields.io/github/stars/ALVAN-1/BaudLab.io?label=stars&color=yellow)

![Electron](https://img.shields.io/badge/Electron-31-47848f?logo=electron&logoColor=white) ![Vue.js](https://img.shields.io/badge/Vue.js-3-4FC08D?logo=vuedotjs&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white) ![SerialPort](https://img.shields.io/badge/SerialPort-12-blue) ![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)

<div align="center">

# BaudLab · 波特律动

**One-stop serial protocol management & debugging**

Visual protocol config · Real-time debugging · List sending · File transfer · Custom dashboard · AI assistant · MCP integration

[Website](https://alvan-1.github.io/BaudLab.io/) · [Download](https://alvan-1.github.io/BaudLab.io/#download) · [Docs](https://alvan-1.github.io/BaudLab.io/#docs) · [Feedback](https://alvan-1.github.io/BaudLab.io/#feedback)

</div>

---

## About

> Bits dance on the wire; protocols become clear on screen.

BaudLab is a desktop tool for embedded development — protocol config, signal management, real-time debugging and file transfer, all in one app. Local-first by design: your protocol data never leaves your machine.

> This repository hosts the BaudLab website & landing page. Installers are distributed via the [official download page](https://alvan-1.github.io/BaudLab.io/#download).

## Feature Overview

| Module | Description |
|---|---|
| Visual Protocol Config | Graphical frame structure, module addresses, commands & fields; reusable templates |
| Real-time Serial Debugging | Live TX/RX monitoring, Hex / text dual view, millisecond timestamps |
| Protocol Frame Builder | Pick protocol + command + field values — frames built automatically with checksums |
| List Sending | Schedule commands in cycles, with loop / interval controls |
| File Transfer | Built-in AFT-1 protocol: chunking, sliding window, checksums & resume |
| Custom Dashboard | Drag-and-drop signal monitoring canvas with trends & trigger actions |
| Protocol Preview | One-click spec docs: copy Markdown / export PDF-styled documents |
| Review Queue | Audited protocol changes with an approval workflow and version history |
| AI Assistant | Natural-language chat plus 18 tool calls for protocol & serial tasks |
| MCP Integration | Built-in MCP server — AI coding tools talk to your serial port directly |
| Frame Codec Engine | Custom binary formats: endianness, bit fields, checksums |
| Local Database | SQLite local storage, fully offline, data stays on your machine |

## Feature Details

### 1. Serial Communication (Debug · List Send · File Send)

| Feature | Description |
|---|---|
| Connection | Port enumeration with USB hot-plug detection; baud rate / data bits / stop bits / parity |
| Frame Builder | Pick protocol → command → fill field values; length & checksum computed automatically. Raw HEX / text also supported |
| Frame Preview | Each frame shown as raw values, parsed values and physical values |
| Comm Log | ASCII / HEX dual view, millisecond timestamps, auto-scroll, one-click clear; "Add to send" turns a logged frame into a send item |
| MCP Activity Mirror | Open / close / send actions from external AI clients shown live in the debug page |
| List Sending | Multi-entry batch sending: loop count, loop interval and per-entry interval; data preview before sending; one-click examples |
| File Transfer (AFT-1) | MTU-based chunking (64–1024 adjustable), sliding window, block timeout / frame interval / ACK listen configurable, expected-reply keyword check, selective retransmit, resume, CRC16-CCITT frame check + CRC32 file check, live transfer log |

### 2. Protocol Config

| Feature | Description |
|---|---|
| Protocol Management | Protocol CRUD: name / version / description; multi-project archiving |
| Module Addresses | Sender / receiver module addresses, visually editable |
| Frame Format | Header / tail, length field position, CRC16 / sum checksum, byte order |
| Commands | Command code / name management; fields (byte count, byte order, enum values) with drag-to-reorder bytes |
| Frame Preview | Live frame preview + full example frames |
| Versioning | Automatic version history, load latest, diff any two versions or protocols |
| Import / Export | Protocol file import and export |
| Review Workflow | Save draft → assign reviewer → submit → publish; unsaved-change reminders |

### 3. Protocol Preview

Frame structure / module addresses / command definitions rendered as a spec document — copy Markdown or export PDF-styled output.

### 4. Review Queue

| Feature | Description |
|---|---|
| Review List | Change ID, change type, applicant, submit time, pending-count badge |
| Side-by-side Diff | Before vs after per-item comparison, command comparison, impact scope |
| Actions | Approve / reject / withdraw with review comments |
| Audit Export | Export audit logs; self-review restriction (cannot review your own changes) |

### 5. Custom Dashboard

Drag components from the library (temperature sensors, switches, trends, etc.) onto the canvas → move / resize → bind protocol signals → configure trigger conditions & actions → connect cards. Pan the canvas, configure time windows.

### 6. AI Assistant & MCP

| Feature | Description |
|---|---|
| Models | OpenAI-compatible / Anthropic-compatible, multi-model management, default model, system prompt |
| Chat | SSE streaming output, Markdown rendering, clear session, auto-attach latest tool data as context |
| Built-in Tools (18) | Protocol query / search / detail, build frame, parse frame, protocol diff, recent serial data, system logs, serial open / close / send, wait for reply, file transfer status, DB stats & backup, draft list & publish |
| MCP Server | stdio JSON-RPC service; 3 resources (protocol library / recent serial logs / local ports) + 3 debug prompts (no-response troubleshooting / HEX parsing / library overview) |
| Dual Mode | Online bridge (app running) and offline read-only (direct SQLite, `--offline` for sensitive environments), auto-switching |
| Safety | Write operations (serial open / close / send, draft publish) require in-app human confirmation; "remember allow" policy with one-click reset |

### 7. Data & Team Collaboration

| Feature | Description |
|---|---|
| Local Storage | SQLite (better-sqlite3), 11 tables: protocols / commands / modules / serial logs / audits / protocol versions / roles / users / app logs / projects / notifications |
| Data Source | Team server address + access token, test connection, remote / local switching, offline marker & auto-reconnect banner |
| Team Server | Register / login / email verification / password reset, role & permission CRUD, user management, heartbeat & online users, DB backup & integrity check, update broadcast (SSE) |
| Identity | Login / switch user, session persistence, email suffix auto-complete |

### 8. Desktop Capabilities

System tray (minimize to background), single instance, launch at login, auto-update (electron-updater + Gitee Releases: check / download / install with progress), system notifications, system log, light / dark theme, Gitee Issue feedback (in-app direct, web fallback), MCP setup guide.

## Quick Start: Team Server + Admin Console

BaudLab works standalone by default; for sharing protocol data across a team, start the built-in team data server.

### 1. Start the Server (~2 minutes)

1. Install Node.js LTS on the server machine (22.13+ required, no dependencies to install)
2. Run `启动服务器.bat` (or `node server.js`) from the app source directory
   - First launch auto-generates `server.config.json` (default port 3010)
   - The console prints a LAN address like `http://192.168.1.100:3010` — that's what members fill in
   - If the Windows firewall prompt appears, choose "Allow access"
3. The database lives at `server-data/serial_protocol.db` with built-in auto-backup (every 24 h, keeps 14 by default)

### 2. Sign in to the Admin Console

Open `http://127.0.0.1:3010/admin` in a browser (local-only; remote requests get 403). You can:

| Feature | Description |
|---|---|
| Status | Port, DB driver, uptime, online user list |
| Access Token | Set / change the token in `server.config.json` (empty = no auth; a random long string is recommended) |
| Mail Service | SMTP config & test send (for registration codes & password reset) |
| Users | Create users, reset codes, enable / disable, assign department, delete |
| Roles | Role CRUD & permission management |
| Data Maintenance | DB stats, integrity check, backup list, run backup now |
| Logs | Last 150 auth / gateway log entries |

### 3. Connect Team Members

In the desktop app, open "Database Connection": choose "Team Server" mode → fill in the server address & access token → "Test Connection" → save. Protocol data is then shared across devices; on disconnect the app falls back to local mode and auto-reconnects when the server is back.

## Download

Latest stable **v0.0.40** (2025-09-29) · Windows 10/11 x64 · 65.4 MB · Free · MIT License

Get the installer from the official download page: <https://alvan-1.github.io/BaudLab.io/#download>

## Feedback

- In-app feedback: Settings → Feedback (auto-attaches runtime info, fastest response)
- Website feedback form: <https://alvan-1.github.io/BaudLab.io/#feedback>

## License

[MIT](LICENSE)
