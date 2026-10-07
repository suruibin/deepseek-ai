/** Local plugin packages installed into the disposable development profile. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { valid } from 'semver'
import { DESKTOP_HOST_PACKAGE } from './core-package-set.ts'
import { DESKTOP_PROFILE_BUNDLES, type DesktopProjectMutation } from './project-manager.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const PLUGIN_MANIFEST = 'plugins.json'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u

/** One local plugin checkout linked into the disposable development project. */
export interface DevelopmentPluginRecord {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
  /** Absolute plugin package directory the record was inspected from. */
  readonly directory: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function removeLinkedPath(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true })
    return
  }
  unlinkSync(path)
}

function linkDirectory(source: string, destination: string): void {
  removeLinkedPath(destination)
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function assertNever(mutation: never): never {
  throw new Error(`desktop development: unsupported plugin change ${JSON.stringify(mutation)}`)
}

/**
 * Resolve the inventory file that survives development project rebuilds.
 *
 * The unpackaged shell replaces its generated project on every launch, so installed
 * local plugins are recorded next to that project instead of inside it.
 * @param projectDir - Disposable development project directory.
 * @returns Absolute path of the development plugin manifest.
 */
export function developmentPluginRegistry(projectDir: string): string {
  return join(dirname(projectDir), PLUGIN_MANIFEST)
}

/**
 * Read the installed development plugin inventory.
 * @param registryPath - Manifest returned by {@link developmentPluginRegistry}.
 * @returns Installed plugin records in manifest order.
 */
export function readDevelopmentPlugins(registryPath: string): readonly DevelopmentPluginRecord[] {
  if (!existsSync(registryPath)) return []
  const value = readJson(registryPath)
  const entries = isRecord(value) ? value.plugins : undefined
  if (!Array.isArray(entries)) throw new Error(`desktop development: invalid plugin manifest ${registryPath}`)
  return entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.version !== 'string'
      || typeof entry.enabled !== 'boolean' || typeof entry.directory !== 'string') {
      throw new Error(`desktop development: invalid plugin record in ${registryPath}`)
    }
    return { name: entry.name, version: entry.version, enabled: entry.enabled, directory: entry.directory }
  })
}

/**
 * Replace the installed development plugin inventory.
 * @param registryPath - Manifest returned by {@link developmentPluginRegistry}.
 * @param plugins - Installed plugin records to persist.
 */
export function writeDevelopmentPlugins(
  registryPath: string, plugins: readonly DevelopmentPluginRecord[],
): void {
  mkdirSync(dirname(registryPath), { recursive: true, mode: 0o700 })
  writeFileSync(registryPath, `${JSON.stringify({ plugins }, undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Inspect a local plugin checkout the way the packaged shell inspects npm packages.
 * @param directory - Plugin package directory holding `package.json`.
 * @returns Enabled record for the inspected package.
 */
export function inspectDevelopmentPlugin(directory: string): DevelopmentPluginRecord {
  const target = resolve(directory)
  const manifestPath = join(target, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`desktop development: plugin ${target} has no package.json`)
  const manifest: unknown = readJson(manifestPath)
  if (!isRecord(manifest)) throw new Error(`desktop development: plugin ${target} has no package manifest`)
  const dsh = manifest.dsh
  const bundle = isRecord(dsh) ? dsh.bundle : undefined
  const patch = isRecord(bundle) ? bundle.patch : undefined
  if (typeof manifest.name !== 'string' || !PACKAGE_NAME_PATTERN.test(manifest.name)
    || typeof manifest.version !== 'string' || valid(manifest.version) !== manifest.version) {
    throw new Error(`desktop development: plugin ${target} needs an exact npm package name and version`)
  }
  if (typeof patch !== 'string' || patch === '' || !existsSync(resolve(target, patch))) {
    throw new Error(`desktop development: ${manifest.name}@${manifest.version} does not declare dsh.bundle.patch`)
  }
  return { name: manifest.name, version: manifest.version, enabled: true, directory: target }
}

/**
 * Seed the inventory on first launch so the launcher's default plugins stay installed.
 * @param registryPath - Manifest returned by {@link developmentPluginRegistry}.
 * @param directories - Plugin checkout directories used when no inventory exists yet.
 * @returns Installed plugin records after seeding.
 */
export function seedDevelopmentPlugins(
  registryPath: string, directories: readonly string[],
): readonly DevelopmentPluginRecord[] {
  if (existsSync(registryPath)) return readDevelopmentPlugins(registryPath)
  const plugins = directories.map(inspectDevelopmentPlugin)
  writeDevelopmentPlugins(registryPath, plugins)
  return plugins
}

/**
 * Write the installed plugins into the generated project and link their checkouts.
 * @param projectDir - Disposable development project directory.
 * @param plugins - Installed plugin records to activate or keep installed.
 * @param previous - Names linked by the previous inventory, removed when absent from `plugins`.
 */
export function applyDevelopmentProjectPlugins(
  projectDir: string, plugins: readonly DevelopmentPluginRecord[], previous: readonly string[] = [],
): void {
  const manifestPath = join(projectDir, 'package.json')
  const manifest = readJson(manifestPath)
  if (!isRecord(manifest) || !isRecord(manifest.dependencies) || !isRecord(manifest.dsh)) {
    throw new Error(`desktop development: invalid development project manifest ${manifestPath}`)
  }
  const dependencies: Record<string, string> = {}
  for (const name of [DSH_PACKAGE, DESKTOP_HOST_PACKAGE]) {
    const version = manifest.dependencies[name]
    if (typeof version === 'string') dependencies[name] = version
  }
  for (const plugin of plugins) dependencies[plugin.name] = plugin.version
  const profile = isRecord(manifest.dsh.profile) ? manifest.dsh.profile : {}
  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    dependencies,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...profile,
        bundles: [...DESKTOP_PROFILE_BUNDLES, ...plugins.filter(plugin => plugin.enabled).map(plugin => plugin.name)],
      },
    },
  }, undefined, 2)}\n`, { mode: 0o600 })
  const modules = join(projectDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  for (const name of previous) {
    if (!plugins.some(plugin => plugin.name === name)) removeLinkedPath(join(modules, ...name.split('/')))
  }
  for (const plugin of plugins) linkDirectory(plugin.directory, join(modules, ...plugin.name.split('/')))
}

/**
 * Apply one Desktop plugins mutation to the development inventory.
 * @param plugins - Currently installed development plugins.
 * @param mutation - Requested Desktop plugin change.
 * @returns Updated development plugin inventory.
 */
export function mutateDevelopmentPlugins(
  plugins: readonly DevelopmentPluginRecord[], mutation: DesktopProjectMutation,
): readonly DevelopmentPluginRecord[] {
  const replaced = (record: DevelopmentPluginRecord): readonly DevelopmentPluginRecord[] => [
    ...plugins.filter(plugin => plugin.name !== record.name),
    record,
  ].sort((left, right) => left.name.localeCompare(right.name))
  switch (mutation.type) {
    case 'plugin-add': {
      const directory = mutation.spec.startsWith('file:') ? mutation.spec.slice('file:'.length) : mutation.spec
      if (!isAbsolute(directory)) {
        throw new Error('desktop development: installing a plugin requires an absolute plugin directory')
      }
      return replaced(inspectDevelopmentPlugin(directory))
    }
    case 'plugin-remove':
      return plugins.filter(plugin => plugin.name !== mutation.name)
    case 'plugin-toggle':
      return plugins.map(plugin => (
        plugin.name === mutation.name ? { ...plugin, enabled: mutation.enabled } : plugin
      ))
    case 'plugin-update': {
      const target = plugins.find(plugin => plugin.name === mutation.name)
      if (target === undefined) throw new Error(`desktop development: plugin ${mutation.name} is not installed`)
      return replaced(inspectDevelopmentPlugin(target.directory))
    }
    case 'plugins-disable-all':
      return plugins.map(plugin => ({ ...plugin, enabled: false }))
    default:
      return assertNever(mutation)
  }
}
