"""BaudLab desktop release tool. Python 3.10+ with Tkinter; standard library only."""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import shutil
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk
import webbrowser

from release_core import Options, Pipeline, read_json, write_json

ROOT = Path(__file__).resolve().parent.parent


class ReleaseApp:
    def __init__(self, window, root=ROOT):
        self.window, self.root = window, Path(root)
        self.settings = self.root / "release-tools/local-settings.json"
        self.events = queue.Queue()
        self.busy = False
        self.release_url = ""
        self.controls = []
        self.vars = {}
        window.title("BaudLab · 打包与 GitHub 发布")
        window.geometry("1040x820")
        window.minsize(920, 720)
        window.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style()
        if "vista" in style.theme_names():
            style.theme_use("vista")
        package = read_json(self.root / "package.json")
        build = package["build"]
        publish = build.get("publish", {})
        if not isinstance(publish, dict):
            publish = {}
        defaults = dict(version=package["version"], product_name=build["productName"],
                        artifact_prefix=build["nsis"]["artifactName"].split("-Setup-")[0],
                        title="", owner=publish.get("owner", "ALVAN-1"),
                        repo=publish.get("repo", "BaudLab.io"), remote="origin",
                        node=shutil.which("node") or "node", token="")
        self.remember = tk.BooleanVar(value=False)
        try:
            saved = read_json(self.settings)
            # Version/name/feed come from the workspace, not a stale settings file.
            defaults.update({key: saved[key] for key in ("remote", "node") if key in saved})
            # 勾选“记住 token”后，token 以明文保存在 local-settings.json（已被 .gitignore 忽略）。
            if saved.get("remember_token") and saved.get("token"):
                defaults["token"] = saved["token"]
                self.remember.set(True)
        except (OSError, ValueError):
            pass
        page = ttk.Frame(window, padding=16)
        page.pack(fill="both", expand=True)
        page.columnconfigure(0, weight=1)
        page.rowconfigure(4, weight=1)
        ttk.Label(page, text="客户端安装包 + 服务器部署包 + GitHub Release", font=("Microsoft YaHei UI", 16, "bold")).grid(row=0, column=0, sticky="w", pady=(0, 12))
        meta = ttk.LabelFrame(page, text="版本与名称", padding=10)
        meta.grid(row=1, column=0, sticky="ew")
        for col in (1, 3):
            meta.columnconfigure(col, weight=1)
        for row, fields in enumerate((("version", "稳定版本号", "product_name", "工具显示名称"),
                                      ("artifact_prefix", "安装包文件名前缀", "title", "Release 标题（可空）"))):
            for col, key, label in ((0, fields[0], fields[1]), (2, fields[2], fields[3])):
                self.field(meta, key, label, defaults[key], row, col)
        ttk.Label(meta, text="tag 自动生成 vX.Y.Z。显示名称可修改；应用 ID、可执行文件名和用户数据目录保持原安装身份。同一 Release 会附带服务器部署包 BaudLab-Server-版本.zip。").grid(row=2, column=0, columnspan=4, sticky="w", pady=(8, 0))
        remote = ttk.LabelFrame(page, text="发布目标与运行环境", padding=10)
        remote.grid(row=2, column=0, sticky="ew", pady=8)
        remote.columnconfigure(1, weight=1)
        remote.columnconfigure(3, weight=1)
        self.field(remote, "owner", "GitHub owner", defaults["owner"], 0, 0)
        self.field(remote, "repo", "GitHub 仓库", defaults["repo"], 0, 2)
        self.field(remote, "remote", "Git remote", defaults["remote"], 1, 0)
        self.field(remote, "node", "Node 可执行路径", defaults["node"], 1, 2)
        self.field(remote, "token", "GitHub token", defaults["token"], 2, 0, show="•")
        remember = ttk.Checkbutton(remote, text="记住 token", variable=self.remember)
        remember.grid(row=2, column=2, sticky="w", padx=8)
        self.controls.append(remember)
        ttk.Label(remote, text="需要目标仓库 Contents 读写权限。勾选“记住 token”后以明文保存在本机 release-tools/local-settings.json"
                               "（该文件已被 .gitignore 忽略，不会进仓库或安装包）。").grid(row=3, column=0, columnspan=4, sticky="w", pady=(8, 0))
        notes_frame = ttk.LabelFrame(page, text="版本说明（Markdown；必填，写入 Release 与更新提示）", padding=8)
        notes_frame.grid(row=3, column=0, sticky="ew")
        self.notes = scrolledtext.ScrolledText(notes_frame, height=7, wrap="word", font=("Microsoft YaHei UI", 10))
        self.notes.pack(fill="both", expand=True)
        notes_path = self.root / "release-tools/RELEASE_NOTES.md"
        self.notes.insert("1.0", notes_path.read_text(encoding="utf-8") if notes_path.exists() else "## 更新内容\n\n- \n")
        self.controls.append(self.notes)
        log_frame = ttk.LabelFrame(page, text="构建与发布日志", padding=8)
        log_frame.grid(row=4, column=0, sticky="nsew", pady=8)
        self.log = scrolledtext.ScrolledText(log_frame, height=8, state="disabled", wrap="word", font=("Consolas", 10))
        self.log.pack(fill="both", expand=True)
        bottom = ttk.Frame(page)
        bottom.grid(row=5, column=0, sticky="ew")
        bottom.columnconfigure(1, weight=1)
        self.bundle = tk.StringVar()
        ttk.Label(bottom, text="产物目录").grid(row=0, column=0, padx=(0, 8))
        entry = ttk.Entry(bottom, textvariable=self.bundle)
        entry.grid(row=0, column=1, sticky="ew")
        self.controls.append(entry)
        self.button(bottom, "选择并加载元数据", self.load_bundle).grid(row=0, column=2, padx=(8, 0))
        self.status = tk.StringVar(value="就绪。仅打包不访问 GitHub。")
        ttk.Label(bottom, textvariable=self.status).grid(row=1, column=0, columnspan=3, sticky="w", pady=(8, 4))
        self.progress = ttk.Progressbar(bottom, maximum=100)
        self.progress.grid(row=2, column=0, columnspan=3, sticky="ew")
        actions = ttk.Frame(bottom)
        actions.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(10, 0))
        self.button(actions, "仅打包", lambda: self.start("build")).pack(side="left")
        self.button(actions, "打包并发布", lambda: self.start("both")).pack(side="left", padx=8)
        self.button(actions, "发布已有产物", lambda: self.start("publish")).pack(side="left")
        self.button(actions, "环境自检", self.selfcheck).pack(side="left", padx=8)
        self.button(actions, "打开产物目录", self.open_bundle).pack(side="right")
        self.button(actions, "查看 Release", self.open_release).pack(side="right", padx=8)
        ttk.Label(page, text="发布会提交版本元数据、推送当前分支、创建 tag，并公开全部资产（客户端安装包 + latest.yml + 服务器部署包）。其他源码改动请先人工提交。构建条为阶段进度，上传条为实际字节进度。", wraplength=990).grid(row=6, column=0, sticky="w", pady=(10, 0))
        window.after(100, self.poll)

    def field(self, parent, key, label, value, row, col, **kwargs):
        ttk.Label(parent, text=label).grid(row=row, column=col, sticky="w", padx=(0, 8), pady=4)
        self.vars[key] = tk.StringVar(value=value)
        entry = ttk.Entry(parent, textvariable=self.vars[key], **kwargs)
        entry.grid(row=row, column=col + 1, sticky="ew", padx=(0, 12), pady=4)
        self.controls.append(entry)

    def button(self, parent, text, command):
        button = ttk.Button(parent, text=text, command=command)
        self.controls.append(button)
        return button

    def options(self):
        data = {key: var.get().strip() for key, var in self.vars.items() if key != "token"}
        data["notes"] = self.notes.get("1.0", "end-1c").strip()
        opts = Options(**data)
        opts.validate()
        return opts

    def load_bundle(self):
        directory = filedialog.askdirectory(title="选择包含 manifest.json 的产物目录", initialdir=str(self.root / "release-tools/output"))
        if not directory:
            return
        try:
            manifest = read_json(Path(directory) / "manifest.json")
            opts = Options(**manifest["options"])
            opts.validate()
            for key, var in self.vars.items():
                if key != "token":
                    var.set(getattr(opts, key))
            self.notes.delete("1.0", "end")
            self.notes.insert("1.0", opts.notes)
            self.bundle.set(directory)
            self.status.set("已加载产物元数据；发布前仍会校验源码与文件哈希。")
        except Exception as error:
            messagebox.showerror("无法加载产物", str(error))

    def start(self, mode):
        if self.busy:
            return
        try:
            opts = self.options()
            token = self.vars["token"].get().strip()
            bundle = self.bundle.get().strip()
            if mode != "build" and not token:
                raise ValueError("请填写 GitHub token")
            if mode == "publish" and not (Path(bundle) / "manifest.json").is_file():
                raise ValueError("请选择已生成的产物目录")
            if mode != "build" and not messagebox.askyesno("发布此版本", f"即将发布 {opts.tag} 到 {opts.owner}/{opts.repo}\n\n提交发布元数据 → push 当前分支 → 创建 tag → 上传并公开 Release。\n\n是否执行？"):
                return
            settings = {key: getattr(opts, key) for key in ("remote", "node")}
            if self.remember.get() and token:
                settings["remember_token"] = True
                settings["token"] = token
            write_json(self.settings, settings)
        except Exception as error:
            messagebox.showerror("检查输入", str(error))
            return
        self.busy = True
        self.release_url = ""
        self.progress["value"] = 0
        for widget in self.controls:
            widget.configure(state="disabled")
        self.status.set("任务运行中…")
        self.append_log(f"开始 {opts.tag} · {mode}")
        threading.Thread(target=self.work, args=(mode, opts, bundle, token), daemon=True).start()

    def selfcheck(self):
        if self.busy:
            return
        self.status.set("环境自检中…")
        self.append_log("环境自检：检查依赖、服务器源文件、服务器模板、发布说明与部署文档…")
        threading.Thread(target=self.selfcheck_work, daemon=True).start()

    def selfcheck_work(self):
        try:
            problems = Pipeline(self.root).preflight()
        except Exception as error:
            self.events.put(("status", "自检失败，详见日志。"))
            self.events.put(("log", "自检异常: " + str(error)))
            return
        if problems:
            self.events.put(("log", "自检发现问题:\n  - " + "\n  - ".join(problems)))
            self.events.put(("status", "自检未通过，请修复后再打包。"))
        else:
            self.events.put(("log", "自检通过：依赖、服务器源文件、服务器模板、发布说明、部署文档齐全。"))
            self.events.put(("status", "自检通过，可以打包。"))

    def work(self, mode, opts, bundle, token):
        pipeline = Pipeline(self.root, log=lambda text: self.events.put(("log", text)),
                            progress=lambda value, text: self.events.put(("progress", (value, text))))
        try:
            if mode in ("build", "both"):
                bundle = str(pipeline.build(opts))
                self.events.put(("bundle", bundle))
            url = pipeline.publish(opts, bundle, token) if mode != "build" else ""
            self.events.put(("done", (bundle, url)))
        except Exception as error:
            text = str(error)
            if token:
                text = text.replace(token, "[REDACTED]")
            self.events.put(("error", text))

    def append_log(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def poll(self):
        try:
            while True:
                event, data = self.events.get_nowait()
                if event == "log":
                    self.append_log(data)
                elif event == "progress":
                    self.progress["value"], text = data
                    self.status.set(text)
                elif event == "status":
                    self.status.set(data)
                elif event == "bundle":
                    self.bundle.set(data)
                elif event in ("done", "error"):
                    self.busy = False
                    for widget in self.controls:
                        widget.configure(state="normal")
                    if event == "done":
                        bundle, self.release_url = data
                        self.bundle.set(bundle)
                        self.progress["value"] = 100
                        self.status.set("发布成功，客户端可检查更新。" if self.release_url else "打包成功；尚未推送或发布。")
                        self.append_log(self.release_url or bundle)
                    else:
                        self.status.set("任务失败，详细信息见日志。")
                        self.append_log(data)
                        messagebox.showerror("任务失败", data + "\n\n已生成的产物与远程草稿会保留，可修复后重试。")
        except queue.Empty:
            pass
        self.window.after(100, self.poll)

    def open_bundle(self):
        directory = Path(self.bundle.get())
        if not self.bundle.get() or not directory.is_dir():
            messagebox.showinfo("产物目录", "请先打包或选择产物目录")
            return
        if os.name == "nt":
            os.startfile(directory)
        else:
            webbrowser.open(directory.resolve().as_uri())

    def open_release(self):
        if self.release_url:
            webbrowser.open(self.release_url)
        else:
            messagebox.showinfo("Release", "当前任务尚未完成远程发布")

    def close(self):
        if self.busy:
            messagebox.showinfo("任务运行中", "请等待任务结束后关闭窗口，避免中断上传或安装包构建。")
            return
        self.vars["token"].set("")
        self.window.destroy()


if __name__ == "__main__":
    window = tk.Tk()
    ReleaseApp(window)
    window.mainloop()
