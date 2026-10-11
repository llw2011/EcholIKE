# Windows 桌面 OTA 正式发布工具

本工具把 EcholIKE online NSIS OTA 的构建、验证、静态落位、停用草稿、CAS 激活、旧版本收敛和公网验收固化为可恢复流程。它不修改版本号、不编辑 Worklog、不提交或推送 Git，也不部署或重启 Server。

## 发布前准备

1. 将 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 的 EcholIKE 版本同步到目标版本。
2. 使用编辑器创建 UTF-8 无 BOM 的说明文件，例如 `release-notes-0.2.16.local`。`.local` 文件被 Git 忽略；发布完成后人工删除。
3. 完成源码、版本和预发布 Worklog 的本地提交，确认 `git status --short` 为空。
4. 在构建环境注入 `TAURI_UPDATER_PUBLIC_KEY`、默认 Tauri signing key/password，确认 WSL、生产 EchoLike Server 和固定 OTA 静态目录可用。源码中的 updater 公钥只是占位符，构建脚本会从环境变量注入临时配置。

说明文件只保存面向用户的实际改动，不写部署细节。工具会原样比较普通 update、Tauri manifest 和 Bootstrap 中的说明。

## 推荐用法

先只构建和验证，不写生产：

```powershell
npm.cmd run release:desktop:ota -- -Version 0.2.16 -ReleaseNotesFile release-notes-0.2.16.local
```

检查生成的 manifest 后，从已验证产物继续发布，不重复构建：

```powershell
npm.cmd run release:desktop:ota -- -Version 0.2.16 -ReleaseNotesFile release-notes-0.2.16.local -Stage All -Publish -Resume
```

也可在 clean 工作树中一次完成：

```powershell
npm.cmd run release:desktop:ota -- -Version 0.2.16 -ReleaseNotesFile release-notes-0.2.16.local -Stage All -Publish
```

`All`、`Static`、`Draft` 和 `Activate` 必须显式提供 `-Publish`。默认 `Prepare` 永远不写生产。

## 中断恢复

每次 `Prepare` 会在以下 ignored 目录生成带源码 commit、生产 API 身份、公共 baseline、release notes、长度、SHA 和签名的 manifest：

```text
src-tauri/target-codex-check/ota-release/<version>/manifest.json
```

只要产品源码没有变化，`-Resume` 会逐字节重验已有产物并跳过第二次构建。manifest 的源码 commit 之后只允许增加 `WORKLOG.md`，或修正本正式工具自身的脚本/测试/规范；`package.json` 只允许新增 `release:desktop:ota` 命令。任何桌面产品源码、版本事实、锁文件或其他构建输入变化都会 fail-closed。

可按阶段恢复：

```powershell
# 静态安装包/签名原子落位或幂等确认
npm.cmd run release:desktop:ota -- -Version 0.2.16 -ReleaseNotesFile release-notes-0.2.16.local -Stage Static -Publish -Resume

# 创建或确认 disabled 草稿，并证明公网 baseline 未变化
npm.cmd run release:desktop:ota -- -Version 0.2.16 -ReleaseNotesFile release-notes-0.2.16.local -Stage Draft -Publish -Resume

# revision CAS 激活、artifact 重验和旧 release 事务收敛
npm.cmd run release:desktop:ota -- -Version 0.2.16 -ReleaseNotesFile release-notes-0.2.16.local -Stage Activate -Publish -Resume

# 纯只读公网复验
npm.cmd run release:desktop:ota -- -Version 0.2.16 -ReleaseNotesFile release-notes-0.2.16.local -Stage Verify -Resume
```

草稿创建回执丢失、激活成功但收敛未完成、收敛结果回执丢失均可安全重放；同键记录的 immutable payload 不一致时拒绝覆盖。

## 固化的安全边界

- 全流程持有单实例文件锁；构建前强制 clean 工作树、五处版本一致、唯一 production updater endpoint、目标版本高于公网 current，且不允许并发 EchoLike Cargo/Tauri 构建。构建日志实时输出，完成后再次复核 clean、版本和源码 provenance。
- 每个版本默认只允许唯一一次 `build:desktop:ota`；同版本旧产物存在但没有 manifest 时拒绝猜测 provenance。
- 本地验收包括 canonical/online 逐字节一致、Minisign、公钥、安装器与主程序 File/ProductVersion、长度、SHA，以及仅生成 online NSIS。
- WSL 静态发布只接受固定 `/srv/echolike/ota/`。目标目录使用锁定 `dir_fd`、`O_EXCL/O_NOFOLLOW`、hard-link no-clobber、逐 inode 清理和 fsync；两个目标均已存在且完全一致时按幂等成功，单边或内容不一致时拒绝继续。
- 只有静态文件公开且完整 GET 一致后才创建 disabled 草稿；草稿阶段公网必须仍以旧版本为 current。
- 控制面只调用生产 dist 的领域 service，不使用裸 SQL。owner/admin 权限在事务内重验，激活使用 revision CAS，旧 release 在 convergence 事务中按完整 ID/revision 集合收敛。
- artifact 激活前再次验证无 redirect 的完整 GET、长度、SHA、Tauri Minisign 和 PE 版本；`0.2.15` 与 Windows 资源中的等价 `0.2.15.0` 按同一版本处理。
- 最终自动验证 health/ready、旧版更新、当前版无更新、两种 Windows Tauri target、完整 artifact/signature GET 以及 Bootstrap 策略和下载信息隔离。

修改正式工具后必须先运行三组隔离测试；它们只使用工作区临时目录或内存 fake，不读取或写入生产：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ota/tests/release-desktop-ota.test.ps1
wsl.exe -e /usr/bin/node --test scripts/ota/tests/control-release.test.mjs
wsl.exe -e python3 -B -m unittest discover -s scripts/ota/tests -p test_publish_static.py
```

## 产物与交付

最终只生成并发布：

```text
EcholIKE_<version>_x64-setup.exe
EcholIKE_<version>_x64-setup.exe.sig
```

公网验收结果写入：

```text
src-tauri/target-codex-check/ota-release/<version>/verification.json
```

发布完成后仍需把实际结果回写根目录 `WORKLOG.md`，单独本地提交并添加 Git note。发布授权不包含 Git push、tag 或 remote 写入。
