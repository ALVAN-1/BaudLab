"""BaudLab release pipeline. Standard library only; no network during build."""
from __future__ import annotations

import base64
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone


class ReleaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class Options:
    version: str
    product_name: str = "Serial Protocol Manager"
    artifact_prefix: str = "SerialProtocolManager"
    title: str = ""
    notes: str = ""
    owner: str = "ALVAN-1"
    repo: str = "BaudLab.io"
    remote: str = "origin"
    node: str = "node"

    @property
    def tag(self):
        return "v" + self.version

    def validate(self):
        if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", self.version):
            raise ReleaseError("稳定版本号必须为 x.y.z，例如 1.0.1")
        if not self.product_name.strip() or re.search(r'[<>:"/\\|?*\x00-\x1f]', self.product_name):
            raise ReleaseError("显示名称不能为空或含 Windows 文件名禁用字符")
        if self.product_name != self.product_name.strip() or self.product_name.endswith("."):
            raise ReleaseError("显示名称不能有首尾空格或以点结尾")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", self.artifact_prefix):
            raise ReleaseError("安装包前缀限 1–64 位英文字母、数字、下划线或连字符")
        for value in (self.owner, self.repo, self.remote):
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", value):
                raise ReleaseError("GitHub owner、repo 和 remote 格式不正确")
        if not self.notes.strip():
            raise ReleaseError("请填写本版本的更新说明")


METADATA = {"package.json", "package-lock.json", "release-tools/RELEASE_NOTES.md"}
SERVER_FILES = ("server.js", "db-schema.js", "default-protocol-data.js", "LICENSE")
SERVER_TEMPLATES = ("start-server.bat", "start-server.sh", "server.config.example.json", "README.md")
# 构建开始前必须存在、或会被复制进产物的输入。缺一项就在自检阶段明确报错，
# 而不是构建到最后一步才崩（例如漏了 docs/RELEASE_AND_DEPLOYMENT.md）。
REQUIRED_INPUTS = (
    "node_modules/vite/bin/vite.js",
    "node_modules/electron-builder/cli.js",
    "release-tools/verify-artifacts.cjs",
    "release-tools/RELEASE_NOTES.md",
    "docs/RELEASE_AND_DEPLOYMENT.md",
)


def digest_file(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, data):
    """Atomic replacement, with original newline convention when applicable."""
    path = Path(path)
    newline = "\r\n" if path.exists() and b"\r\n" in path.read_bytes() else "\n"
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(text.replace("\n", newline).encode("utf-8"))
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def sync_metadata(root, opts):
    opts.validate()
    root = Path(root)
    package = read_json(root / "package.json")
    package["version"] = opts.version
    build = package["build"]
    build["productName"] = opts.product_name
    # appId, npm package name and executableName retain the installed app identity.
    build["win"].setdefault("executableName", "Serial Protocol Manager")
    build["nsis"]["artifactName"] = opts.artifact_prefix + "-Setup-${version}.${ext}"
    build["publish"] = {"provider": "github", "owner": opts.owner, "repo": opts.repo}
    lock = read_json(root / "package-lock.json")
    lock["version"] = opts.version
    if "" in lock.get("packages", {}):
        lock["packages"][""]["version"] = opts.version
    write_json(root / "package.json", package)
    write_json(root / "package-lock.json", lock)
    (root / "release-tools/RELEASE_NOTES.md").write_text(opts.notes.strip() + "\n", encoding="utf-8")


def normalize_package(package):
    package = copy.deepcopy(package)
    package.pop("version", None)
    build = package.get("build", {})
    build.pop("productName", None)
    build.pop("publish", None)
    build.get("nsis", {}).pop("artifactName", None)
    return package


def normalize_lock(lock):
    lock = copy.deepcopy(lock)
    lock.pop("version", None)
    lock.get("packages", {}).get("", {}).pop("version", None)
    return lock


def parse_status(raw):
    """Porcelain -z preserves spaces in paths and reversed rename path order."""
    records = raw.split(b"\0")
    paths = set()
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        state = record[:2]
        paths.add(os.fsdecode(record[3:]).replace("\\", "/"))
        if b"R" in state or b"C" in state:
            if index < len(records):
                paths.add(os.fsdecode(records[index]).replace("\\", "/"))
                index += 1
    return paths


class NoCredentialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and urllib.parse.urlparse(req.full_url).netloc != urllib.parse.urlparse(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


class GitHub:
    def __init__(self, opts, token, log, progress):
        if not token or any(c.isspace() for c in token):
            raise ReleaseError("发布需要 GitHub token（仓库 Contents 读写权限）")
        self.opts, self.token, self.log, self.progress = opts, token, log, progress
        self.base = f"https://api.github.com/repos/{opts.owner}/{opts.repo}"
        self.opener = urllib.request.build_opener(NoCredentialRedirect())

    def headers(self):
        return {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "BaudLab-release-tool"}

    def api(self, method, path="", data=None, allow_404=False):
        body = None if data is None else json.dumps(data).encode("utf-8")
        headers = self.headers()
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=60) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if error.code == 404 and allow_404:
                return None
            try:
                message = json.loads(error.read()).get("message", "")
            except (ValueError, OSError):
                message = ""
            raise ReleaseError(f"GitHub {method} {path or '/'}: HTTP {error.code} {message}") from None

    def release_for_tag(self):
        # /tags hides unpublished drafts on some auth paths; list is reliable for recovery.
        for page in range(1, 101):
            releases = self.api("GET", f"/releases?per_page=100&page={page}")
            for release in releases:
                if release["tag_name"] == self.opts.tag:
                    return release
            if len(releases) < 100:
                return None
        raise ReleaseError("Release 列表过大，请检查目标仓库")

    def assets(self, release_id):
        result = []
        for page in range(1, 101):
            batch = self.api("GET", f"/releases/{release_id}/assets?per_page=100&page={page}")
            result.extend(batch)
            if len(batch) < 100:
                return result
        raise ReleaseError("Release 资产列表过大")

    def verify_asset(self, asset, entry):
        if asset.get("state") != "uploaded" or asset["size"] != entry["size"]:
            return False
        if asset.get("digest"):
            return asset["digest"] == "sha256:" + entry["sha256"]
        # Older GitHub responses lack digest. Download and hash rather than trust file size.
        headers = self.headers()
        headers["Accept"] = "application/octet-stream"
        request = urllib.request.Request(self.base + f"/releases/assets/{asset['id']}", headers=headers)
        h = hashlib.sha256()
        with self.opener.open(request, timeout=60) as response:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest() == entry["sha256"]

    def upload(self, release, path, offset, total):
        path = Path(path)
        url = release["upload_url"].split("{")[0] + "?name=" + urllib.parse.quote(path.name)
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != "uploads.github.com":
            raise ReleaseError("GitHub 返回了非预期的资产上传地址")
        conn = http.client.HTTPSConnection(parsed.hostname, timeout=120)
        try:
            conn.putrequest("POST", parsed.path + "?" + parsed.query)
            headers = self.headers()
            headers.update({"Content-Type": "application/octet-stream", "Content-Length": str(path.stat().st_size)})
            for key, value in headers.items():
                conn.putheader(key, value)
            conn.endheaders()
            sent = 0
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    conn.send(chunk)
                    sent += len(chunk)
                    self.progress(82 + 15 * (offset + sent) / max(total, 1),
                                  f"上传 {path.name}: {sent / 1048576:.1f} / {path.stat().st_size / 1048576:.1f} MB")
            response = conn.getresponse()
            raw = response.read()
            if response.status != 201:
                raise ReleaseError(f"上传 {path.name} 失败: HTTP {response.status}")
            return json.loads(raw)
        finally:
            conn.close()


class Pipeline:
    def __init__(self, root, log=lambda message: None, progress=lambda value, message: None):
        self.root = Path(root).resolve()
        self._log, self.progress = log, progress
        self._secrets = []

    def redact(self, text):
        text = str(text)
        for secret in self._secrets:
            text = text.replace(secret, '[REDACTED]')
        return text

    def log(self, text):
        self._log(self.redact(text))

    def assert_source(self, fingerprint, head=None):
        if self.fingerprint() != fingerprint:
            raise ReleaseError('源码发生变化，请重新打包')
        if head and self.git('rev-parse', 'HEAD').decode().strip() != head:
            raise ReleaseError('发布期间 HEAD 发生变化，请重新检查并打包')

    def run(self, args, env=None, live=False, check=True):
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        kwargs = dict(cwd=self.root, env=env, creationflags=creationflags, shell=False)
        if live:
            self.log("运行: " + " ".join(str(a) for a in args))
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
            for line in iter(process.stdout.readline, b""):
                self.log(line.decode("utf-8", errors="replace").rstrip())
            code = process.wait()
            result = subprocess.CompletedProcess(args, code, b"", b"")
        else:
            result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
        if check and result.returncode:
            detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
            raise ReleaseError(f"命令失败 ({result.returncode}): {' '.join(map(str, args))}\n{detail}")
        return result

    def git(self, *args, env=None, check=True):
        return self.run(["git", *args], env=env, check=check).stdout

    def fingerprint(self):
        paths = sorted(set(self.git("ls-files", "-co", "--exclude-standard", "-z").split(b"\0")) - {b""})
        h = hashlib.sha256()
        for raw in paths:
            file = self.root / os.fsdecode(raw)
            h.update(raw + b"\0")
            if file.is_file():
                h.update(digest_file(file).encode("ascii"))
            else:
                h.update(b"MISSING")
            h.update(b"\0")
        return h.hexdigest()

    def server_zip(self, target, opts):
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in SERVER_FILES:
                archive.write(self.root / name, name)
            for name in SERVER_TEMPLATES:
                info = zipfile.ZipInfo(name)
                info.external_attr = (0o100755 if name.endswith(".sh") else 0o100644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, (self.root / "release-tools/server" / name).read_bytes())
            archive.writestr("VERSION.json", json.dumps({"version": opts.version, "tag": opts.tag}, indent=2))

    def preflight(self):
        """返回环境与输入的阻断问题列表；空列表表示可以开始构建。界面用它做自检。"""
        problems = []
        for name in REQUIRED_INPUTS:
            if not (self.root / name).is_file():
                if name.startswith("node_modules/"):
                    problems.append("缺少依赖: " + name + "（请先在工程根目录执行 npm ci）")
                else:
                    problems.append("缺少文件: " + name)
        for name in SERVER_FILES:
            if not (self.root / name).is_file():
                problems.append("服务器包缺少源文件: " + name)
        for name in SERVER_TEMPLATES:
            if not (self.root / "release-tools/server" / name).is_file():
                problems.append("服务器包缺少模板: release-tools/server/" + name)
        return problems

    def build(self, opts):
        opts.validate()
        self.progress(1, "环境自检")
        problems = self.preflight()
        if problems:
            raise ReleaseError("构建前自检未通过:\n" + "\n".join(problems))
        self.run([opts.node, "--version"])
        sync_metadata(self.root, opts)
        fingerprint = self.fingerprint()
        work = self.root / "release-tools/.work" / (opts.tag + "-" + uuid.uuid4().hex[:8])
        work.mkdir(parents=True)
        builder = work / "builder"
        config = work / "builder.json"
        config_data = copy.deepcopy(read_json(self.root / 'package.json')['build'])
        config_data.setdefault('directories', {})['output'] = str(builder)
        config_data['releaseInfo'] = {'releaseNotes': opts.notes}
        write_json(config, config_data)
        env = os.environ.copy()
        for name in ("GH_TOKEN", "GITHUB_TOKEN"):
            env.pop(name, None)
        env["CODEBUDDY_SAFE_DELETE_ENABLED"] = "0"
        self.progress(8, "构建 Vue 界面（阶段进度）")
        self.run([opts.node, "node_modules/vite/bin/vite.js", "build"], env=env, live=True)
        self.progress(25, "生成 Windows 安装包（阶段进度，以日志为准）")
        self.run([opts.node, "node_modules/electron-builder/cli.js", "--win", "nsis", "--x64",
                  "--publish", "never", "--config", str(config)], env=env, live=True)
        self.progress(65, "校验安装包与 GitHub 更新源")
        self.run([opts.node, "release-tools/verify-artifacts.cjs", str(builder), opts.version,
                  opts.owner, opts.repo, opts.artifact_prefix], env=env, live=True)
        if self.fingerprint() != fingerprint:
            raise ReleaseError("打包期间源码发生变化，请重新打包")
        output = self.root / "release-tools/output" / opts.tag
        if output.exists():
            output = output.with_name(output.name + "-" + uuid.uuid4().hex[:8])
        output.mkdir(parents=True)
        self.progress(68, "整理产物：安装包 + 服务器部署包 + 校验清单")
        exe_name = f"{opts.artifact_prefix}-Setup-{opts.version}.exe"
        for name in (exe_name, "latest.yml", exe_name + ".blockmap"):
            if (builder / name).exists():
                shutil.copy2(builder / name, output / name)
        self.server_zip(output / f"BaudLab-Server-{opts.version}.zip", opts)
        shutil.copy2(self.root / "docs/RELEASE_AND_DEPLOYMENT.md", output / "RELEASE_AND_DEPLOYMENT.md")
        (output / f"release-notes-{opts.tag}.md").write_text(opts.notes.strip() + "\n", encoding="utf-8")
        sums = "".join(f"{digest_file(path)}  {path.name}\n" for path in sorted(output.iterdir()))
        (output / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
        entries = [{"name": path.name, "size": path.stat().st_size, "sha256": digest_file(path)}
                   for path in sorted(output.iterdir())]
        self.assert_source(fingerprint)
        write_json(output / "manifest.json", {"schema": 1, "built_at": datetime.now(timezone.utc).isoformat(),
                   "options": asdict(opts), "source_sha256": fingerprint, "assets": entries})
        self.progress(72, "客户端安装包与服务器部署包已生成")
        self.log("产物目录: " + str(output))
        return output

    def verify_bundle(self, bundle, opts):
        opts.validate()
        bundle = Path(bundle).resolve()
        manifest = read_json(bundle / "manifest.json")
        # Node path is a local runtime choice; all release metadata must match exactly.
        expected, actual = asdict(opts), manifest["options"].copy()
        expected.pop("node", None)
        actual.pop("node", None)
        if expected != actual:
            raise ReleaseError("界面元数据与安装包 manifest 不一致，请加载产物元数据或重新打包")
        if manifest["source_sha256"] != self.fingerprint():
            raise ReleaseError("源码已变化，现有产物不对应当前工作区，请重新打包")
        required = {f"{opts.artifact_prefix}-Setup-{opts.version}.exe", "latest.yml",
                    f"BaudLab-Server-{opts.version}.zip", "SHA256SUMS.txt", "RELEASE_AND_DEPLOYMENT.md",
                    f"release-notes-{opts.tag}.md"}
        entries = manifest["assets"]
        names = [entry["name"] for entry in entries]
        if len(set(names)) != len(names) or not required.issubset(names):
            raise ReleaseError("产物清单缺少必需文件或有重复文件")
        for entry in entries:
            name = entry["name"]
            if Path(name).name != name or "/" in name or "\\" in name:
                raise ReleaseError("产物清单文件名不合法")
            file = bundle / name
            if file.stat().st_size != entry["size"] or digest_file(file) != entry["sha256"]:
                raise ReleaseError("产物校验失败: " + name)
        return entries

    def local_publish_checks(self, opts):
        branch = self.git("symbolic-ref", "--short", "HEAD").decode().strip()
        dirty = parse_status(self.git("status", "--porcelain=v1", "-z", "--untracked-files=all"))
        extra = sorted(dirty - METADATA)
        if extra:
            raise ReleaseError("请先人工提交这些源码改动，再重新打包并发布（工具只提交发布元数据）:\n" + "\n".join(extra))
        for name, normalize in (("package.json", normalize_package), ("package-lock.json", normalize_lock)):
            original = json.loads(self.git("show", "HEAD:" + name))
            if normalize(original) != normalize(read_json(self.root / name)):
                raise ReleaseError(name + " 包含非发布字段变更，请先提交源码再打包")
        remote = self.git("remote", "get-url", "--push", opts.remote).decode().strip()
        expected = f"{opts.owner}/{opts.repo}".lower()
        match = re.fullmatch(r"https://github\.com/([^?#]+?)(?:\.git)?/?", remote)
        ssh = re.fullmatch(r"git@github\.com:([^?#]+?)(?:\.git)?", remote)
        repo = (match or ssh)
        if not repo or repo[1].lower() != expected or "@" in repo[1]:
            raise ReleaseError("Git remote 必须匹配目标 GitHub 仓库，且不能在 URL 中包含凭据")
        return branch, dirty, bool(match)

    def auth_env(self, token, https):
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"
        if https:
            count = int(env.get("GIT_CONFIG_COUNT", "0"))
            env[f"GIT_CONFIG_KEY_{count}"] = "http.https://github.com/.extraheader"
            credential = base64.b64encode(("x-access-token:" + token).encode()).decode()
            env[f"GIT_CONFIG_VALUE_{count}"] = "AUTHORIZATION: basic " + credential
            env["GIT_CONFIG_COUNT"] = str(count + 1)
        return env

    def publish(self, opts, bundle, token):
        self._secrets = [token, base64.b64encode(('x-access-token:' + token).encode()).decode()] if token else []
        try:
            return self._publish(opts, bundle, token)
        except Exception as error:
            raise ReleaseError(self.redact(error)) from None
        finally:
            self._secrets = []

    def _publish(self, opts, bundle, token):
        self.progress(74, "校验工作区、产物与远程权限")
        start_head = self.git('rev-parse', 'HEAD').decode().strip()
        entries = self.verify_bundle(bundle, opts)
        fingerprint = read_json(Path(bundle) / 'manifest.json')['source_sha256']
        branch, dirty, https = self.local_publish_checks(opts)
        github = GitHub(opts, token, self.log, self.progress)
        repository = github.api("GET")
        if repository.get("private"):
            raise ReleaseError("公开客户端自动更新需要公开 Release，请使用公开仓库")
        if repository.get("permissions", {}).get("push") is False:
            raise ReleaseError("GitHub token 没有仓库写权限")
        release = github.release_for_tag()
        if release and not release['draft']:
            assets = {asset['name']: asset for asset in github.assets(release['id'])}
            if release.get('prerelease') or any(entry['name'] not in assets or not github.verify_asset(assets[entry['name']], entry) for entry in entries):
                raise ReleaseError('公开 Release 的资产不同或不完整，请提高版本号重新发布')
        latest = github.api("GET", "/releases/latest", allow_404=True)
        if latest and latest["tag_name"] != opts.tag:
            current = latest["tag_name"].lstrip("v")
            if re.fullmatch(r"\d+\.\d+\.\d+", current) and tuple(map(int, opts.version.split("."))) <= tuple(map(int, current.split("."))):
                raise ReleaseError("新版本号必须高于当前公开稳定版本 " + current)
        env = self.auth_env(token, https)
        self.git("fetch", "--no-tags", opts.remote, branch, env=env)
        result = self.run(["git", "merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], check=False)
        if result.returncode:
            raise ReleaseError("远程分支包含本地尚未合入的提交，请先同步源码后重新打包")
        remote_tag = self.git("ls-remote", "--tags", opts.remote, "refs/tags/" + opts.tag,
                              "refs/tags/" + opts.tag + "^{}", env=env).decode().splitlines()
        remote_commit = None
        if remote_tag:
            peeled = [line.split()[0] for line in remote_tag if line.endswith("^{}")]
            remote_commit = peeled[0] if peeled else remote_tag[0].split()[0]
        local = self.run(["git", "rev-parse", "--verify", "refs/tags/" + opts.tag + "^{commit}"], check=False)
        local_commit = local.stdout.decode().strip() if local.returncode == 0 else None
        head = self.git("rev-parse", "HEAD").decode().strip()
        # 远程 tag 已被删除（例如删掉发错的 Release 后重发同一版本）时，本地残留的旧 tag 会在下面重建；
        # 只要远程 tag 仍存在且指向别处，就绝不覆盖，要求改用新版本号。
        if remote_commit and remote_commit != head:
            raise ReleaseError("远程同名 tag 已指向其他提交；请使用新版本，工具不会覆盖远程 tag")
        if dirty and (remote_commit or release):
            raise ReleaseError("此版本 tag/Release 已存在且发布元数据有变化，请使用新版本")
        self.assert_source(fingerprint, start_head)
        if release and not release['draft']:
            self.progress(100, '此版本已完整发布，资产内容一致')
            return release['html_url']
        if dirty:
            self.git("add", "--", *sorted(dirty))
            self.git("commit", "-m", f"chore(release): {opts.tag}", "--", *sorted(dirty))
            head = self.git("rev-parse", "HEAD").decode().strip()
        self.assert_source(fingerprint, head)
        if not local_commit:
            self.git('tag', '-a', opts.tag, '-F', 'release-tools/RELEASE_NOTES.md')
        elif remote_commit is None and local_commit != head:
            self.log("远程 tag " + opts.tag + " 已不存在，本地残留 tag 重建到当前提交 " + head[:8])
            self.git('tag', '-f', '-a', opts.tag, '-F', 'release-tools/RELEASE_NOTES.md')
        self.assert_source(fingerprint, head)
        self.progress(79, "推送分支与版本 tag")
        self.git("push", "--atomic", opts.remote, f"HEAD:refs/heads/{branch}", f"refs/tags/{opts.tag}", env=env)
        if not release:
            release = github.api("POST", "/releases", {"tag_name": opts.tag, "target_commitish": head,
                                 "name": opts.title or f"{opts.product_name} {opts.tag}",
                                 "body": opts.notes, "draft": True, "prerelease": False})
        assets = {asset["name"]: asset for asset in github.assets(release["id"])}
        total = sum(entry["size"] for entry in entries)
        offset = 0
        for entry in entries:
            existing = assets.get(entry["name"])
            if existing and not github.verify_asset(existing, entry):
                # An unfinished draft is recoverable. Public release assets are never replaced.
                github.api("DELETE", f"/releases/assets/{existing['id']}")
                existing = None
            if not existing:
                self.log("上传: " + entry["name"])
                existing = github.upload(release, Path(bundle) / entry["name"], offset, total)
            if not github.verify_asset(existing, entry):
                raise ReleaseError("GitHub 资产 SHA256 校验失败: " + entry["name"])
            offset += entry["size"]
        self.assert_source(fingerprint, head)
        self.verify_bundle(bundle, opts)
        release = github.api("PATCH", f"/releases/{release['id']}", {"draft": False, "prerelease": False,
                             "name": opts.title or f"{opts.product_name} {opts.tag}", "body": opts.notes, "make_latest": "true"})
        self.progress(100, "GitHub Release 已公开，客户端可以检查更新")
        return release["html_url"]
