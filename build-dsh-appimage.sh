#!/usr/bin/env bash
# 从源码编译 DeepSeek Harness 官方桌面端 —— Linux AppImage
#
# 上游只提供 mac/win 打包目标；本脚本在需要时用同目录的 dsh-linux-appimage.patch
# 补上 linux-x64，再走官方 prepare(运行时/包集/dsh) + electron-builder 流程。
#
# 用法:
#   ./build-dsh-appimage.sh              # 编译脚本所在的仓库
#   ./build-dsh-appimage.sh --clone      # 源码不存在时自动克隆官方仓库
#   ./build-dsh-appimage.sh --repo DIR --out DIR
#   ./build-dsh-appimage.sh --no-proxy
# 依赖: node(>=24) pnpm git curl；打包需要 tar；首次编译还需要 python3 + make + gcc
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 默认仓库根: 脚本所在目录；否则其父目录；最后回退到常见路径
if [ -d "$SCRIPT_DIR/.git" ]; then
  DEFAULT_REPO="$SCRIPT_DIR"
elif [ -d "$(dirname "$SCRIPT_DIR")/.git" ]; then
  DEFAULT_REPO="$(dirname "$SCRIPT_DIR")"
else
  DEFAULT_REPO="/projects/deepseek-ai/deepseek-harness"
fi

# 默认补丁: 优先脚本同目录
if [ -f "$SCRIPT_DIR/dsh-linux-appimage.patch" ]; then
  DEFAULT_PATCH="$SCRIPT_DIR/dsh-linux-appimage.patch"
else
  DEFAULT_PATCH="/projects/deepseek-ai/dsh-linux-appimage.patch"
fi

REPO="${DSH_REPO:-$DEFAULT_REPO}"
OUT="${DSH_OUT:-$(dirname "$DEFAULT_REPO")/appimage}"
PATCH="${DSH_PATCH:-$DEFAULT_PATCH}"
CLONE=0
PROXY=""
PROXY_SET=0
APP_ID="${DSH_DESKTOP_APP_ID:-com.deepseek.harness}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
EB_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
PY_MIRROR="${PY_MIRROR:-https://github.com/astral-sh/python-build-standalone/releases/download}"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --patch) PATCH="$2"; shift 2 ;;
    --clone) CLONE=1; shift ;;
    --proxy) PROXY="$2"; PROXY_SET=1; shift 2 ;;
    --no-proxy) PROXY=""; PROXY_SET=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

for bin in node pnpm git curl tar; do command -v "$bin" >/dev/null || die "缺少命令: $bin"; done

# 代理: 默认探测本机 7890
if [ "$PROXY_SET" -eq 0 ]; then
  if (exec 3<>/dev/tcp/127.0.0.1/7890) 2>/dev/null; then PROXY="http://127.0.0.1:7890"; exec 3<&- 3>&-; fi
fi
if [ -n "$PROXY" ]; then
  export http_proxy="$PROXY" https_proxy="$PROXY" all_proxy="$PROXY"
  log "使用代理 $PROXY"
else
  log "未使用代理（依赖 npmmirror 直连）"
fi
# Electron / electron-builder 的产物走 npmmirror，直连更稳（经代理易 TLS 抖动）
export no_proxy="npmmirror.com,.npmmirror.com,localhost,127.0.0.1${no_proxy:+,$no_proxy}"
export NO_PROXY="$no_proxy"
# Node 内置 fetch 走代理（prepare 阶段下载锁定归档用）
export NODE_USE_ENV_PROXY=1
export ELECTRON_MIRROR ELECTRON_BUILDER_BINARIES_MIRROR

# 1. 源码
if [ ! -d "$REPO/.git" ]; then
  [ "$CLONE" -eq 1 ] || die "源码不存在: $REPO（加 --clone 自动克隆）"
  log "克隆官方仓库到 $REPO"
  mkdir -p "$(dirname "$REPO")"
  git -c http.proxy="$PROXY" -c https.proxy="$PROXY" clone --depth 1 --single-branch \
    https://github.com/deepseek-ai/deepseek-harness.git "$REPO"
fi
cd "$REPO"
log "源码 $(git log --oneline -1 2>/dev/null || echo '(无 git 信息)')"

# 2. Linux 打包补丁（幂等）
if grep -q "'linux-x64'" apps/desktop/scripts/desktop-build-paths.mjs 2>/dev/null; then
  log "linux-x64 补丁已存在，跳过"
else
  [ -f "$PATCH" ] || die "补丁不存在: $PATCH"
  log "应用补丁 $PATCH"
  git apply --check "$PATCH" || die "补丁无法应用（源码已变动？）请手动处理 $PATCH"
  git apply "$PATCH"
fi

# 3. 打包环境文件（被 gitignore，全新检出没有）
if [ ! -f apps/desktop/.env.linux ]; then
  log "生成 apps/desktop/.env.linux"
  {
    printf 'DSH_DESKTOP_APP_ID=%s\n' "$APP_ID"
    [ -n "${DSH_DESKTOP_NPM_REGISTRY:-}" ] && printf 'DSH_DESKTOP_NPM_REGISTRY=%s\n' "$DSH_DESKTOP_NPM_REGISTRY"
  } > apps/desktop/.env.linux
fi

# 4. 依赖
log "安装 workspace 依赖"
pnpm install --frozen-lockfile

# 5. Electron 二进制（pnpm 的 strictDepBuilds 会跳过它的 postinstall）
ELECTRON_BIN="apps/desktop/node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  log "下载 Electron 二进制（$ELECTRON_MIRROR）"
  ( cd apps/desktop && node node_modules/electron/install.js )
fi
[ -x "$ELECTRON_BIN" ] || die "Electron 二进制缺失: $ELECTRON_BIN"

# 6. 预取锁定运行时归档，避免 prepare 阶段直连 nodejs.org / GitHub 卡住。
#    缓存按 sha256 命名，与 scripts/primary-runtime/prepare.ts 的约定一致。
fetch_locked() {
  local url="$1" sha="$2" label="$3"
  local dest="$DL/$sha"
  if [ -s "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$sha" ]; then
    log "已有 $label"
    return 0
  fi
  log "预取 $label"
  rm -f "$dest"
  curl -fsSL --retry 2 --max-time 600 -o "$dest" "$url" || { rm -f "$dest"; log "$label 预取失败，交由 prepare 自行下载"; return 0; }
  if [ "$(sha256sum "$dest" | cut -d' ' -f1)" != "$sha" ]; then
    rm -f "$dest"
    die "$label 校验和不匹配，请检查镜像"
  fi
}

DL="$REPO/apps/desktop/.desktop-build/downloads"
mkdir -p "$DL"
LOCK="$REPO/scripts/primary-runtime/lock.json"
NODE_VERSION="$(node -p "require('$LOCK').nodeVersion")"
NODE_SHA="$(node -p "require('$LOCK').targets['linux-x64'].nodeSha256")"
PY_VERSION="$(node -p "require('$LOCK').pythonVersion")"
PY_RELEASE="$(node -p "require('$LOCK').pythonRelease")"
PY_TARGET="$(node -p "require('$LOCK').targets['linux-x64'].pythonTarget")"
PY_SHA="$(node -p "require('$LOCK').targets['linux-x64'].pythonSha256")"
fetch_locked "$NODE_MIRROR/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz" "$NODE_SHA" "Node $NODE_VERSION linux-x64"
fetch_locked "$PY_MIRROR/$PY_RELEASE/cpython-$PY_VERSION+$PY_RELEASE-$PY_TARGET-install_only_stripped.tar.gz" "$PY_SHA" "CPython $PY_VERSION $PY_TARGET"

# 7. 打包
mkdir -p "$OUT"
[ -w "$OUT" ] || die "输出目录不可写: $OUT"
LOG="$OUT/build-$(date +%Y%m%d-%H%M%S).log"
log "开始打包（日志: $LOG）"
: > "$LOG"
STATUS=1
for attempt in 1 2; do
  STATUS=0
  pnpm run package:desktop:linux:x64 2>&1 | tee -a "$LOG" || STATUS=$?
  if [ "$STATUS" -eq 0 ]; then break; fi
  log "第 $attempt 次打包失败（exit $STATUS），15 秒后重试"
  sleep 15
done
[ "$STATUS" -eq 0 ] || die "打包失败（exit $STATUS），见 $LOG"

# 8. 收集产物（复制后逐字节校验，避免静默截断或丢失）
ARTIFACTS="apps/desktop/.desktop-build/targets/linux-x64/artifacts"
SOURCE_APPIMAGE="$(ls -t "$ARTIFACTS"/*.AppImage | head -1)"
cp -f "$SOURCE_APPIMAGE" "$OUT/"
sync
APPIMAGE="$OUT/$(basename "$SOURCE_APPIMAGE")"
[ -s "$APPIMAGE" ] || die "产物复制失败: $APPIMAGE"
cmp -s "$SOURCE_APPIMAGE" "$APPIMAGE" || die "产物校验不一致: $APPIMAGE"
log "完成: $APPIMAGE"
ls -la "$APPIMAGE"
sha256sum "$APPIMAGE"
cat <<EOF

运行（Electron 44 在部分发行版默认 ozone 后端会崩溃）:
  "$APPIMAGE" --ozone-platform=wayland --no-sandbox
EOF