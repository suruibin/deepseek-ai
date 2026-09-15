# 编译 Linux AppImage

> 本仓库是**个人快照**（非官方），基于官方 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 在提交 `0d1f500`（v0.1.6-alpha.1）的源码，并附带一组让官方打包流水线产出 **Linux AppImage** 的补丁。

## 这个仓库里有什么

| 文件 | 说明 |
| --- | --- |
| `build-dsh-appimage.sh` | 一键编译脚本（自动探测代理、应用补丁、预取运行时、打包并逐字节校验产物） |
| `dsh-linux-appimage.patch` | Linux 打包补丁（11 个文件）；脚本检测到未应用时会自动 `git apply` |
| `LINUX-APPIMAGE.md` | 本文档 |
| `apps/desktop/build/icon.png` | AppImage 图标（DeepSeek 鲸鱼 logo，256×256 RGBA PNG） |

## 为什么需要补丁

官方 `apps/desktop/scripts/package-target.ts` 只注册了 `mac-arm64`、`mac-x64`、`win-x64` 三个发布目标，Linux 会被显式拒绝。补丁做了最小改动使其支持 `linux-x64`：

- `scripts/desktop-build-paths.mjs` / `.d.mts`：目标白名单与类型加入 `linux-x64`
- `scripts/package-target.ts`：新增 `linux-x64` 目标（`--linux --x64`）与 Linux x64 宿主机校验；Linux 跳过 release completion record
- `scripts/desktop-auto-update-environment.d.mts`、`scripts/desktop-upload-plan.ts`：类型与上传计划补齐 linux 条目
- `electron-builder.config.mjs`：Linux 不生成自动更新元数据；指定合法的 `executableName` 与图标 `build/icon.png`
- `package.json`（根与 `apps/desktop`）：新增 `package:desktop:linux:x64` 脚本
- `tests/fixtures/runtime-payload-smoke.mjs`：上游该断言仍在校验已废弃的 `fs-ext`，改为校验当前的 `@deepseek-ai/node-addon-system/flock`
- `tests/package-target.spec.ts`、`tests/desktop-build-paths.spec.ts`：断言同步

## 前置依赖

- Node.js >= 24、pnpm、git、curl
- 编译原生模块需要 `python3`、`make`、`gcc`
- 官方 `prepare:dsh` 步骤把 registry 固定为 `registry.npmjs.org`，国内网络建议保留代理

## 编译

```bash
# 在本仓库内直接运行
./build-dsh-appimage.sh

# 从零开始：脚本会克隆官方上游并应用补丁
./build-dsh-appimage.sh --clone --repo /path/to/deepseek-harness

# 其他选项
./build-dsh-appimage.sh --out /path/to/output
./build-dsh-appimage.sh --no-proxy
./build-dsh-appimage.sh --proxy http://127.0.0.1:1080
```

脚本按顺序执行：探测代理 → 检查/克隆源码 → 幂等应用补丁 → `pnpm install` → 补装 Electron 二进制（pnpm 的 `strictDepBuilds` 会跳过它的 postinstall）→ 预取内置 Node.js 运行时 → `pnpm run package:desktop:linux:x64`（失败自动重试一次；`npmmirror.com` 走直连，避免经代理时的 TLS 抖动）→ 复制产物并逐字节校验。

可用环境变量覆盖：`DSH_REPO`、`DSH_OUT`、`DSH_DESKTOP_APP_ID`、`NODE_MIRROR`、`ELECTRON_MIRROR`。

产物默认写到仓库同级目录的 `appimage/`：

```
appimage/deepseek-harness-0.1.6-alpha.1-linux-x86_64.AppImage
```

## 运行

```bash
./deepseek-harness-0.1.6-alpha.1-linux-x86_64.AppImage \
  --ozone-platform=wayland --no-sandbox
```

Electron 44 在部分发行版（Garuda/Arch 系等）使用默认 ozone 后端会 SIGSEGV，必须显式指定 `--ozone-platform=wayland`。

开发模式（不打包、直接跑源码）：

```bash
pnpm run dev:desktop
```

开发模式需要设置 `DSH_DESKTOP_HOST_INSPECT_PORT`，否则 Host 缺少 `--allow-linked-profile`，界面会报 `profile bundle "@deepseek-ai/dsh-base" resolved outside the Desktop runtime and profile`。

## 已知限制

- AppImage **未签名**（图标已内嵌，来源 `apps/desktop/build/icon.png`）
- Linux 不生成自动更新元数据（上游不支持该目标）
- 本仓库是**单提交快照**，不含上游历史；同步上游：`git fetch upstream && git merge upstream/master --allow-unrelated-histories`
- 提交时会被仓库自带的 lefthook 钩子拦截（上游既有文件的问题：尾随空格等），需要 `git commit --no-verify`
