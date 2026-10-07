/**
 * Desktop-only Host services for plugin surfaces that manage this
 * application's own profile: `desktopProfiles` names the profile the Electron
 * shell booted, and `desktopPnpm` runs the packaged pnpm inside it.
 *
 * The Electron application owns this profile and re-derives its shape at every
 * boot: dependencies pinned to exact registry versions, a
 * `dsh.profile.bundles` list beginning with the built-in desktop bundles, and
 * one validating pass over every dependency manifest. A package operation
 * driven by a plugin therefore has to leave the profile in exactly that shape,
 * which is what {@link reconcileProfile} rewrites after a successful mutation.
 * @module @deepseek-ai/dsh-desktop-host/desktop-services
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The profile this Desktop application booted; provided only in the Electron Host. */
    desktopProfiles?: DesktopProfilesService
    /** Packaged pnpm operations scoped to {@link DesktopProfilesService}; provided only in the Electron Host. */
    desktopPnpm?: DesktopPnpmService
  }
}

/** Active profile identity — the subset of Desktop's `desktopProfiles` contract plugin surfaces read. */
export interface DesktopProfilesService {
  readonly current: {
    readonly name: string
    readonly dir: string
  }
}

/** One running package operation — the subset of Desktop's `desktopPnpm` contract. */
export interface DesktopPnpmHandle {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly done: Promise<{
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
  }>
  cancel(): void
}

/** Package-manager boundary consumed by plugin surfaces that install plugins. */
export interface DesktopPnpmService {
  /**
   * Start one pnpm command in the active profile.
   * @param args - pnpm argv, e.g. `['add', 'dshmarket@1.47.0', '-w', '--reporter=ndjson']`.
   * @param invokingDir - the caller's directory; unused because the profile owns the working directory.
   * @param signal - aborts the operation when it fires.
   * @returns the running handle; throws when another operation holds the slot or the argv is unsupported.
   */
  runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): DesktopPnpmHandle
}

/** Inputs {@link provideDesktopServices} needs from the Electron bootstrap. */
export interface DesktopServicesOptions {
  /** Active profile directory (the Desktop-owned `$DSH_HOME/profiles/desktop`). */
  readonly profileDir: string
  /** Immutable dsh runtime directory this application booted from. */
  readonly runtimeDir: string
}

/** Built-in bundles every desktop profile activates before its own plugins. */
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
/** Registry and store the Electron application pins for its private profile. */
const DESKTOP_REGISTRY = 'https://registry.npmjs.org/'
/** Path of the profile manifest holding both dependencies and the bundle list. */
const PROFILE_MANIFEST = 'package.json'
/** Lockfile pnpm writes for the profile, restored verbatim when a change is rolled back. */
const PROFILE_LOCKFILE = 'pnpm-lock.yaml'
/** Packaged descriptor listing the packages this application supplies to plugins. */
const DESKTOP_RUNTIME_FILE = 'desktop-runtime.json'
/** Grace between the polite and the forced signal when a cancellation lifts a process tree. */
const KILL_GRACE_MS = 5000
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
/** Version part of a registry target: an exact version, dist-tag, or semver range. */
const VERSION_RANGE_RE = /^[0-9A-Za-z^~*<>=|.+_-]+$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error(`desktop profile: ${path} must contain a JSON object`)
  return value
}

/**
 * Whether one `add` target names an npm registry package.
 *
 * The desktop profile holds exact registry versions, so a git, tarball, local
 * or alias target has no valid manifest shape here: pnpm would write a spec
 * the Electron application refuses at the next boot. Rejecting it before any
 * process starts keeps that failure at the point of the request.
 * @param spec - npm package name with an optional version, dist-tag, or range.
 * @returns true when the whole spec is a registry name plus an optional version part.
 */
export function isRegistryTarget(spec: string): boolean {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return PACKAGE_NAME_RE.test(spec)
  return PACKAGE_NAME_RE.test(spec.slice(0, at)) && VERSION_RANGE_RE.test(spec.slice(at + 1))
}

/** The package name of a registry target, without its version part. */
function packageNameOf(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at <= 0 ? spec : spec.slice(0, at)
}

/** The last non-flag argument, which pnpm takes as the operation's target. */
function targetOf(args: readonly string[]): string | undefined {
  return [...args].reverse().find(argument => !argument.startsWith('-'))
}

/**
 * Validate one plugin argv and return the pnpm argv to run.
 * @param args - argv from a plugin surface.
 * @returns pnpm argv, with the exact-pin flag `add` needs for this profile.
 */
function pnpmArgv(args: readonly string[]): string[] {
  const command = args[0]
  if (command === undefined || command === '') throw new Error('dsh desktop: a pnpm command is required')
  if (command !== 'add') return [...args]
  const target = targetOf(args)
  if (target === undefined) throw new Error('dsh desktop: plugin add requires a package target')
  if (!isRegistryTarget(target)) {
    throw new Error(`dsh desktop: ${JSON.stringify(target)} is not an npm registry package; this desktop client installs npm-published plugins only, because its profile holds exact registry versions — install this plugin from an ordinary dsh profile instead`)
  }
  return [...args, '--save-exact']
}

/** Which package one successful command turned on or off, for the bundle rewrite. */
function bundleChange(argv: readonly string[]): { enable?: string; disable?: string } {
  const command = argv[0]
  if (command !== 'add' && command !== 'remove') return {}
  const target = targetOf(argv)
  if (target === undefined) return {}
  const name = packageNameOf(target)
  return command === 'add' ? { enable: name } : { disable: name }
}

function installedManifest(profileDir: string, name: string): Record<string, unknown> {
  const path = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(path)) {
    throw new Error(`desktop profile: installed package ${JSON.stringify(name)} has no manifest`)
  }
  const manifest = readRecord(path)
  if (manifest.name !== name || typeof manifest.version !== 'string') {
    throw new Error(`desktop profile: installed package ${JSON.stringify(name)} has inconsistent name or version`)
  }
  return manifest
}

/** Whether one installed package carries the bundle patch that makes it activatable. */
function isBundle(profileDir: string, name: string, manifest: Record<string, unknown>): boolean {
  const dsh = manifest.dsh
  const bundle = isRecord(dsh) ? dsh.bundle : undefined
  const patch = isRecord(bundle) ? bundle.patch : undefined
  return typeof patch === 'string' && patch !== ''
    && existsSync(resolve(join(profileDir, 'node_modules', ...name.split('/')), patch))
}

/**
 * Rewrite the profile manifest into the shape the Electron application boots:
 * every dependency pinned to its installed version and `dsh.profile.bundles`
 * listing the built-in bundles followed by the enabled plugins, in name order.
 *
 * A package without a bundle patch stays installed but out of the list, which
 * keeps the application bootable instead of failing its dependency validation
 * on a plugin this profile cannot activate.
 * @param profileDir - active Desktop profile directory.
 * @param change - the package this operation just installed or removed.
 */
export function reconcileProfile(profileDir: string, change: { enable?: string; disable?: string } = {}): void {
  const manifestPath = join(profileDir, PROFILE_MANIFEST)
  const manifest = readRecord(manifestPath)
  const dependencies = isRecord(manifest.dependencies) ? { ...manifest.dependencies } : {}
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : []

  const enabled = new Set(bundles.slice(DESKTOP_PROFILE_BUNDLES.length).filter(name => typeof name === 'string'))
  if (change.enable !== undefined) enabled.add(change.enable)
  if (change.disable !== undefined) enabled.delete(change.disable)

  const activatable: string[] = []
  for (const name of Object.keys(dependencies).sort()) {
    const installed = installedManifest(profileDir, name)
    dependencies[name] = installed.version
    if (isBundle(profileDir, name, installed)) activatable.push(name)
  }

  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    dependencies,
    dsh: {
      ...dsh,
      profile: {
        ...profile,
        bundles: [...DESKTOP_PROFILE_BUNDLES, ...activatable.filter(name => enabled.has(name))],
      },
    },
  }, undefined, 2)}\n`, { mode: 0o600 })
}

/** One installed package's dependency surface, as the profile graph check reads it. */
interface ProfilePackage {
  readonly name: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly optionalPeers: ReadonlySet<string>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function profilePackage(directory: string): ProfilePackage {
  const path = join(directory, 'package.json')
  if (!existsSync(path)) throw new Error(`desktop profile: invalid installed package ${directory}`)
  const value = readRecord(path)
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`desktop profile: invalid package manifest ${directory}`)
  }
  const field = (key: string): Record<string, string> => {
    const entries = value[key]
    if (entries === undefined) return {}
    if (!isRecord(entries) || Object.values(entries).some(range => typeof range !== 'string')) {
      throw new Error(`desktop profile: invalid ${key} in ${directory}`)
    }
    return entries as Record<string, string>
  }
  const optionalPeers = new Set<string>()
  const meta = value.peerDependenciesMeta
  if (isRecord(meta)) {
    for (const [name, entry] of Object.entries(meta)) {
      if (isRecord(entry) && entry.optional === true) optionalPeers.add(name)
    }
  }
  return {
    name: value.name,
    dependencies: field('dependencies'),
    optionalDependencies: field('optionalDependencies'),
    peerDependencies: field('peerDependencies'),
    optionalPeers,
  }
}

/** Resolve one dependency the way Node does from an install inside the profile. */
function packageFrom(anchor: string, name: string): string | undefined {
  for (const modules of createRequire(join(anchor, 'package.json')).resolve.paths(name) ?? []) {
    const path = join(modules, name)
    if (existsSync(join(path, 'package.json'))) return realpathSync.native(path)
  }
  return undefined
}

/** The names of the packages this application supplies to plugins itself. */
function sharedPackageNames(runtimeDir: string): ReadonlySet<string> {
  const path = join(runtimeDir, DESKTOP_RUNTIME_FILE)
  if (!existsSync(path)) throw new Error(`dsh desktop: ${path} is missing, so a plugin change cannot be verified`)
  const entries = readRecord(path).sharedPackages
  if (!Array.isArray(entries)) throw new Error('dsh desktop: the runtime descriptor lists no shared packages')
  const names = new Set<string>()
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string') throw new Error('dsh desktop: invalid shared package record')
    names.add(entry.name)
  }
  return names
}

/** Reject every package directory the profile's own container holds but does not own. */
function scanInstalled(
  modules: string, profileRoot: string, shared: ReadonlySet<string>, scanned: Set<string>,
): void {
  if (!existsSync(modules)) return
  if (lstatSync(modules).isSymbolicLink()) throw new Error(`desktop profile: linked package container ${modules}`)
  const directory = realpathSync.native(modules)
  if (scanned.has(directory)) return
  scanned.add(directory)
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(modules, entry.name)
    if (entry.name.startsWith('@')) {
      scanInstalled(path, profileRoot, shared, scanned)
      continue
    }
    if (!existsSync(join(path, 'package.json'))) throw new Error(`desktop profile: invalid installed package ${path}`)
    const canonical = realpathSync.native(path)
    // Host packages are supplied by the runtime rather than owned here, and this
    // profile resolves them from the runtime generation instead of a link.
    if (shared.has(profilePackage(canonical).name)) continue
    if (entry.isSymbolicLink()) throw new Error(`desktop profile: linked private package ${path}`)
    if (!inside(profileRoot, canonical)) throw new Error(`desktop profile: package resolves outside profile: ${path}`)
    scanInstalled(join(path, 'node_modules'), profileRoot, shared, scanned)
  }
}

/** Reject any dependency an active plugin resolves to a package this profile does not own. */
function scanDependencies(
  path: string, chain: string, profileRoot: string, shared: ReadonlySet<string>, visited: Set<string>,
): void {
  if (visited.has(path)) return
  visited.add(path)
  const info = profilePackage(path)
  const declared = { ...info.dependencies, ...info.optionalDependencies }
  for (const [name, range] of Object.entries({ ...declared, ...info.peerDependencies })) {
    const peer = name in info.peerDependencies
    const optional = peer ? info.optionalPeers.has(name) : name in info.optionalDependencies
    if (shared.has(name)) {
      if (name in declared) throw new Error(`desktop profile: ${chain} must declare ${name} as a peer dependency`)
      // The boot-time pass also compares a peer range with the supplied version.
      continue
    }
    const target = packageFrom(path, name)
    if (target === undefined && optional) continue
    if (target === undefined) throw new Error(`desktop profile: ${chain} requires missing ${name}@${range}`)
    if (!inside(profileRoot, target)) {
      throw new Error(`desktop profile: ${chain} resolves ${name} outside its owned packages`)
    }
    scanDependencies(target, `${chain} -> ${name}`, profileRoot, shared, visited)
  }
}

/**
 * Prove the profile still passes the check the Electron application runs before
 * every boot, so a plugin-driven install that cannot be carried reports itself
 * instead of failing the next start.
 *
 * This mirrors `validateDesktopPluginGraph` in the Desktop application, which is
 * the authority: it is the one the boot runs. Two differences, both deliberate.
 * Peer version ranges are not compared, because the bundled runtime carries no
 * semver implementation to compare them with; and the runtime-generation checks
 * are fixed, because this profile always resolves host packages that way.
 * @param profileDir - active Desktop profile directory, after the manifest rewrite.
 * @param runtimeDir - immutable dsh runtime directory this application booted from.
 */
export function validateProfileGraph(profileDir: string, runtimeDir: string): void {
  const profile = resolve(profileDir)
  const profileRoot = realpathSync.native(profile)
  const shared = sharedPackageNames(runtimeDir)
  const manifest = readRecord(join(profile, PROFILE_MANIFEST))
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}
  const section = isRecord(dsh.profile) ? dsh.profile : {}
  const bundles = Array.isArray(section.bundles) ? section.bundles.filter(name => typeof name === 'string') : []
  const plugins = bundles.slice(DESKTOP_PROFILE_BUNDLES.length)
  if (plugins.length === 0) return
  scanInstalled(join(profile, 'node_modules'), profileRoot, shared, new Set<string>())
  const visited = new Set<string>()
  for (const name of plugins) {
    const path = packageFrom(profile, name)
    if (path === undefined || !inside(profileRoot, path)) throw new Error(`desktop profile: missing local plugin ${name}`)
    scanDependencies(path, name, profileRoot, shared, visited)
  }
}

/** The private pnpm state the Electron application shares with its own installs. */
interface PnpmState {
  readonly store: string
  readonly cache: string
  readonly state: string
  readonly config: string
  readonly home: string
  readonly npmrc: string
}

/**
 * Create the private pnpm state on first use.
 * The store directory is the Electron application's own: pnpm records it in
 * `node_modules/.modules.yaml` and refuses every later operation whose store
 * differs, so a plugin-driven install must not invent a second one.
 * @param home - resolved Harness home.
 * @returns the created state paths.
 */
function pnpmState(home: string): PnpmState {
  const root = join(home, 'desktop', 'pnpm')
  const state: PnpmState = {
    store: join(root, 'store'),
    cache: join(root, 'cache'),
    state: join(root, 'state'),
    config: join(root, 'config'),
    home: join(root, 'home'),
    npmrc: join(root, 'config', 'npmrc'),
  }
  for (const path of [join(home, 'desktop'), root, state.store, state.cache, state.state, state.config, state.home]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  if (!existsSync(state.npmrc)) writeFileSync(state.npmrc, '', { mode: 0o600 })
  return state
}

/** Loader flags every desktop pnpm run carries, matching the Electron application's own. */
function registryArgv(state: PnpmState): string[] {
  return [
    `--config.registry=${DESKTOP_REGISTRY}`,
    `--config.store-dir=${state.store}`,
    '--config.enable-global-virtual-store=false',
    `--config.userconfig=${state.npmrc}`,
  ]
}

/** Environment for one desktop pnpm run, matching the Electron application's own. */
function pnpmEnvironment(state: PnpmState): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
  )))
  return {
    ...inherited,
    // The packaged shell runs its own Electron binary as the bundled Node.js.
    ELECTRON_RUN_AS_NODE: '1',
    COREPACK_HOME: state.home,
    NPM_CONFIG_REGISTRY: DESKTOP_REGISTRY,
    NPM_CONFIG_STORE_DIR: state.store,
    NPM_CONFIG_USERCONFIG: state.npmrc,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    PNPM_HOME: state.home,
    XDG_CACHE_HOME: state.cache,
    XDG_CONFIG_HOME: state.config,
    XDG_STATE_HOME: state.state,
  }
}

/**
 * Locate the pnpm entry this application ships.
 *
 * A packaged build carries it beside the dsh runtime tree, while an unpackaged
 * Electron process booted from the workspace runs against a generated project
 * whose runtime directory sits deep inside the workspace. Searching the runtime
 * directory's ancestors covers both, without Electron-only APIs this Node-mode
 * process does not have.
 * @param runtimeDir - immutable dsh runtime directory (argv of this process).
 * @returns the entry path, or undefined when no known layout is present.
 */
function resolvePnpmEntry(runtimeDir: string): string | undefined {
  const entries = [
    join('runtime', 'pnpm', 'bin', 'pnpm.mjs'),
    join('node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    join('node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ]
  let directory = resolve(runtimeDir)
  for (let depth = 0; depth <= 4; depth += 1) {
    for (const entry of entries) {
      const path = join(directory, entry)
      if (existsSync(path)) return path
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/** Signal one process tree, falling back to the bare child when the group is gone. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    child.kill(signal)
  }
}

/** Profile file bytes, or undefined when the file does not exist yet. */
type FileSnapshot = Buffer | undefined

function snapshot(path: string): FileSnapshot {
  return existsSync(path) ? readFileSync(path) : undefined
}

function restore(path: string, before: FileSnapshot): void {
  if (before === undefined) {
    if (existsSync(path)) unlinkSync(path)
    return
  }
  writeFileSync(path, before, { mode: 0o600 })
}

/**
 * Run one pnpm command to completion and collect what it said.
 * The rollback pass runs to completion before the operation reports its outcome,
 * so it cannot go through the request-driven handle that owns the single slot.
 */
function pnpmOnce(
  entry: string, state: PnpmState, profileDir: string, argv: readonly string[],
): Promise<{ readonly exitCode: number | null; readonly stderr: string }> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [entry, ...registryArgv(state), ...argv], {
      cwd: profileDir, env: pnpmEnvironment(state), stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error: Error) => { settle({ exitCode: 127, stderr: `${stderr}${error.message}` }) })
    child.once('close', (exitCode: number | null) => { settle({ exitCode, stderr }) })
  })
}

function createDesktopPnpm(options: {
  readonly profileDir: string
  readonly runtimeDir: string
  readonly home: string
  readonly pnpmEntry: string | undefined
  readonly warn: (error: Error) => void
}): DesktopPnpmService {
  let active: DesktopPnpmHandle | undefined
  return {
    runPlugin(args, _invokingDir, signal) {
      if (active !== undefined) throw new Error('another desktop pnpm operation is already running')
      const argv = pnpmArgv(args)
      const entry = options.pnpmEntry
      if (entry === undefined) {
        throw new Error('dsh desktop: this application ships no pnpm entry, so it cannot manage its own profile')
      }
      const state = pnpmState(options.home)
      // Both files describe the profile as it was before this command; pnpm
      // rewrites them, and a change this profile cannot boot is undone by
      // putting them back and letting pnpm drop whatever they no longer list.
      const manifestBefore = snapshot(join(options.profileDir, PROFILE_MANIFEST))
      const lockBefore = snapshot(join(options.profileDir, PROFILE_LOCKFILE))
      const child = spawn(process.execPath, [entry, ...registryArgv(state), ...argv], {
        cwd: options.profileDir,
        env: pnpmEnvironment(state),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so one signal lifts pnpm with its children.
        detached: process.platform !== 'win32',
      })
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      // Neither pipe may end its destination: the operation appends its own
      // verdict to stderr once the child is gone, and that is the text the
      // caller reads as the reason the change was refused.
      child.stdout.pipe(stdout, { end: false })
      child.stderr.pipe(stderr, { end: false })

      let finished = false
      let killTimer: NodeJS.Timeout | undefined
      let resolveDone!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((settle) => {
        resolveDone = settle
      })
      const finish = (exitCode: number | null, closeSignal: NodeJS.Signals | null, failure?: string): void => {
        if (finished) return
        finished = true
        if (killTimer !== undefined) clearTimeout(killTimer)
        signal?.removeEventListener('abort', cancel)
        if (active === handle) active = undefined
        // Readers attach after the handle returns, so the failure detail is
        // written to the stream before it ends rather than lost with the exit.
        if (failure !== undefined) stderr.write(`${failure}\n`)
        stdout.end()
        stderr.end()
        resolveDone({ exitCode, signal: closeSignal })
      }
      const cancel = (): void => {
        if (finished) return
        signalTree(child, 'SIGTERM')
        killTimer ??= setTimeout(() => { signalTree(child, 'SIGKILL') }, KILL_GRACE_MS)
        killTimer.unref()
      }
      const handle: DesktopPnpmHandle = { stdout, stderr, done, cancel }
      active = handle
      if (signal !== undefined) {
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
      }
      const undo = async (): Promise<string | undefined> => {
        restore(join(options.profileDir, PROFILE_MANIFEST), manifestBefore)
        restore(join(options.profileDir, PROFILE_LOCKFILE), lockBefore)
        const outcome = await pnpmOnce(entry, state, options.profileDir, ['install', '--ignore-scripts'])
        if (outcome.exitCode !== 0) {
          return `pnpm install exited with ${String(outcome.exitCode)}: ${outcome.stderr.trim()}`
        }
        return undefined
      }
      const succeed = async (): Promise<void> => {
        try {
          reconcileProfile(options.profileDir, bundleChange(argv))
        } catch (error) {
          const detail = describe(error)
          options.warn(new Error(`dsh desktop: pnpm succeeded but the profile manifest was not rewritten: ${detail}`))
          finish(1, null, detail)
          return
        }
        try {
          validateProfileGraph(options.profileDir, options.runtimeDir)
        } catch (error) {
          const detail = describe(error)
          const failed = await undo()
          options.warn(new Error(`dsh desktop: ${detail}${failed === undefined
            ? '; the change was rolled back'
            : `; and rolling it back failed: ${failed}`}`))
          // The market reports this text, so it says what the profile did rather
          // than only what was wrong with the plugin.
          finish(1, null, failed === undefined
            ? `this plugin cannot run in the desktop profile: ${detail}. The change was rolled back, so the profile is unchanged.`
            : `this plugin cannot run in the desktop profile: ${detail}. Rolling the change back also failed: ${failed}`)
          return
        }
        finish(0, null)
      }
      child.once('error', (error: Error) => {
        finish(127, null, error.message)
      })
      child.once('close', (exitCode: number | null, closeSignal: NodeJS.Signals | null) => {
        if (exitCode !== 0 || closeSignal !== null) {
          finish(exitCode, closeSignal)
          return
        }
        void succeed()
      })
      return handle
    },
  }
}

/**
 * Provide the `desktopProfiles` and `desktopPnpm` services plugin surfaces
 * detect, so a market installed in this profile manages THIS profile through
 * the packaged pnpm instead of shelling out to the `dsh` CLI, which refuses
 * the reserved `desktop` profile name.
 * @param ctx - Host context, before any Loader entry mounts.
 * @param options - active profile directory and this application's runtime directory.
 */
export function provideDesktopServices(ctx: Context, options: DesktopServicesOptions): void {
  const profileDir = resolve(options.profileDir)
  const home = resolve(ctx.get('dshHomePath')?.() ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  ctx.provide('desktopProfiles', { current: { name: basename(profileDir), dir: profileDir } })
  ctx.provide('desktopPnpm', createDesktopPnpm({
    profileDir,
    runtimeDir: resolve(options.runtimeDir),
    home,
    pnpmEntry: resolvePnpmEntry(resolve(options.runtimeDir)),
    warn: (error) => { ctx.logger.warn(error) },
  }))
}
