# 编译 Linux AppImage

> 本仓库是**个人快照**（非官方），基于官方 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 在提交 `5badb15009`（v0.2.1-alpha.1）的源码，并附带一组让官方打包流水线产出 **Linux AppImage** 的补丁。

## 这个仓库里有什么

| 文件 | 说明 |
| --- | --- |
| `build-dsh-appimage.sh` | 一键编译脚本（自动探测代理、应用补丁、预取锁定运行时、打包并逐字节校验产物） |
| `dsh-linux-appimage.patch` | Linux 打包补丁（36 个文件，含 `patches/@deepseek-ai__libreoffice-kit@0.1.5.patch`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`）；脚本检测到未应用时会自动 `git apply` |
| `LINUX-APPIMAGE.md` | 本文档 |
| `patches/@deepseek-ai__libreoffice-kit@0.1.5.patch` | pnpm 依赖补丁：修正 Electron ASAR 下的 Office 引擎探测（随 `dsh-linux-appimage.patch` 一起应用） |
| `apps/desktop/resources/icon-linux.png` | AppImage 图标（1024×1024 RGBA PNG） |
| `apps/desktop/.env.linux.example` | Linux 打包环境模板（复制为 `.env.linux` 后使用，后者被 gitignore） |

## 为什么需要补丁

官方 `apps/desktop/scripts/package-target.ts` 只注册了 `mac-arm64`、`mac-x64`、`win-x64` 三个发布目标，Linux 会被显式拒绝；共享的 `scripts/primary-runtime/`（Node/CPython/Python 包锁定与 `linux-x64` 条目）和 Office 引擎选择早已原生支持 Linux，所以改动只落在 Desktop 层：

- `scripts/desktop-build-paths.mjs` / `.d.mts`：目标白名单与类型加入 `linux-x64`；`desktopTargetPlatform` 返回 `linux`
- `scripts/desktop-auto-update-environment.mjs` / `.d.mts`：新增 `DesktopBuildTarget`（构建树归属），Linux 有目标构建目录与完成记录文件名，但不进入更新 feed 目标集
- `scripts/package-target.ts`：新增 `linux-x64` 目标（`--linux --x64`）与 Linux x64 宿主机校验；Linux 走独立的 `linux-package` 阶段；Linux 不写 release completion record
- `scripts/desktop-package-environment.mjs` / `.d.mts`：读 `.env.linux`；Linux 只接受共享设置，不需要部署 origin、签名或更新配置
- `scripts/electron-builder-config.mjs`：Linux 不解析 mandatory-update policy、不生成自动更新元数据（`publish: null`）；指定图标、`executableName`，并用 `syncDesktopName` 让 `.desktop`、Electron `app_id` 与可执行名一致
- `scripts/desktop-build-version-discovery.ts`：Linux 没有远端 feed 可查，编号回退到本地产物；产物名正则覆盖 `linux` / `AppImage`
- `scripts/prepare-runtime.ts`、`prepare-dsh.ts`、`prepare-cli.ts`、`development-project.ts`、`smoke-packaged-runtime.ts`、`desktop-toolchain-preflight.ts`、`desktop-upload-plan.ts`：按目标平台选择 Electron 可执行文件、`linux-unpacked` 目录、可执行位与类型条目
- `scripts/runtime-file-policy.ts`、`tests/fixtures/runtime-payload-smoke.mjs`、`tests/runtime-file-policy.spec.ts`：Linux 包剔除 sharp 的原生二进制（原因见「已知限制」）
- `apps/desktop/package.json`：新增 `desktopName`（使窗口 `StartupWMClass` 与桌面项匹配）、`package:linux:x64` 脚本
- `package.json`（根）：新增 `package:desktop:linux:x64` 脚本
- `.gitignore`：忽略 `apps/desktop/.env.linux`
- `tests/package-target.spec.ts`、`tests/desktop-build-paths.spec.ts`、`tests/desktop-auto-update-environment.spec.ts`：断言同步
- `patches/@deepseek-ai__libreoffice-kit@0.1.5.patch`（配 `pnpm-workspace.yaml` 的 `patchedDependencies`）：把 Office 引擎探测从 `lstatSync(path, { throwIfNoEntry: false })` 改为 `existsSync(path)`。Electron 的 ASAR `fs` 垫片对该选项返回**不存在的路径也存在的 Stats**，于是 `libreoffice-kit` 误判「原生引擎已装但不完整」而抛错，永远回退不到 Linux 上的 WASM 引擎（原因见「已知限制」）
- `prepare-dsh.ts` 的 `stageRuntimeDependencyPatches`：Desktop 运行时安装在自己的临时工程里，既不继承 workspace 的 `patches/` 也不继承 `patchedDependencies`，所以该步骤把上面这个补丁复制进运行时工程并向 pnpm 声明
- `apps/desktop/src/main.ts`、`apps/desktop/tests/main-startup.spec.ts`：Linux 不再安装原生应用菜单（`Menu.setApplicationMenu(null)`）。Electron 会把应用菜单画进窗口内顶部，于是窗口上多出一行中文「应用」+ Electron 内置英文「Edit」；这行与 Web 客户端自管的窗口顶栏重复，Linux 上直接不装。`apps/desktop/README.md` 与 `README.zh.md` 同步措辞

## 前置依赖

- Node.js >= 24、pnpm、git、curl、`tar`
- 编译原生模块需要 `python3`、`make`、`gcc`
- 官方 `prepare:dsh` 步骤把 registry 固定为 `registry.npmjs.org`，国内网络建议保留代理；运行 `--ozone-platform=wayland` 需要系统具备 Electron 依赖的共享库（libgtk-3、libnss3、libasound2 等）

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

脚本按顺序执行：探测代理 → 检查/克隆源码 → 幂等应用补丁 → 生成 `apps/desktop/.env.linux` → `pnpm install --frozen-lockfile` → 补装 Electron 二进制（pnpm 的 `strictDepBuilds` 会跳过它的 postinstall）→ 预取按 sha256 锁定命名的 Node/CPython 归档（避免直连 nodejs.org 与 GitHub 卡住）→ `pnpm run package:desktop:linux:x64`（失败自动重试一次；`npmmirror.com` 走直连，避免经代理时的 TLS 抖动）→ 复制产物并逐字节校验。

可用环境变量覆盖：`DSH_REPO`、`DSH_OUT`、`DSH_DESKTOP_APP_ID`、`DSH_DESKTOP_NPM_REGISTRY`、`NODE_MIRROR`、`PY_MIRROR`、`ELECTRON_MIRROR`。

产物默认写到仓库同级目录的 `appimage/`：

```
appimage/deepseek-harness-0.2.1-alpha.1-linux-x86_64.AppImage
```

## 运行

```bash
./deepseek-harness-0.2.1-alpha.1-linux-x86_64.AppImage \
  --ozone-platform=wayland --no-sandbox
```

Electron 44 在部分发行版（Garuda/Arch 系等）使用默认 ozone 后端会 SIGSEGV，必须显式指定 `--ozone-platform=wayland`。

开发模式（不打包、直接跑源码）见 `apps/desktop/README.md`。

## 已知限制

- AppImage **未签名**
- **图片附件处理在 Linux 上不可用**：sharp 预编译的 libvips 自带一份 glib，与 Electron 加载的宿主 glib 在同一进程内符号冲突（跨副本引用计数崩溃，官方未修复，见 [electron#46323](https://github.com/electron/electron/issues/46323)）。因此 Linux 包剔除 `@img/sharp-linux-x64` 与 `@img/sharp-libvips-linux-x64`，需要 sharp 时直接报「Could not load the sharp module using the linux-x64 runtime」，而不是段错误崩溃。其余原生依赖（koffi、node-pty、fs-ext）与 HTML 转换、ripgrep 检索均正常
- **Office 转 PDF 走 WASM 引擎**：官方只发布了 macOS/Windows 的 `@deepseek-ai/libreoffice-kit-<platform>` 原生引擎包，Linux 的 `@deepseek-ai/libreoffice-kit-linux-x64-glibc` 未上架 npm，所以 kit 在 Linux 上按设计回退到 `@deepseek-ai/libreoffice-kit-wasm`（转换可用，但比原生慢）
- Linux 不生成自动更新元数据，也不轮询 mandatory-update policy（上游不支持该目标）
- **Linux 没有原生应用菜单**：窗口顶部不再出现「应用 / Edit」一行。代价是失去菜单里的「关于」、开发态的 Reload Page / Restart App and Host 与 F12 开发者工具快捷键，以及 `editMenu` 角色提供的编辑加速键（编辑器自身的键位处理与右键菜单不受影响）；退出不受影响——Linux 关闭主窗口即 `app.quit()`
- 本仓库是**单提交快照**，不含上游历史；同步上游需换树后重套补丁（与上游**无共同祖先**，不能 `merge`/`rebase`）
- 提交时可能被仓库自带的 lefthook 钩子拦截（上游既有文件的问题），需要 `git commit --no-verify`