/**
 * Desktop Host services: the profile identity plugin surfaces read, the pnpm
 * boundary they install through, and the manifest rewrite that keeps the
 * Electron application bootable after a plugin-driven package operation.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { isRegistryTarget, provideDesktopServices, reconcileProfile, validateProfileGraph } from '../../desktop-host/src/desktop-services.ts'

interface Fixture {
  readonly root: string
  readonly home: string
  readonly profileDir: string
  readonly runtimeDir: string
  readonly recorded: string
}

/** One installed plugin with a bundle patch, plus a package that has none. */
function writeInstalled(
  profileDir: string, name: string, version: string, bundle: boolean, dependencies: Record<string, string> = {},
): void {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    dependencies,
    ...(bundle ? { dsh: { bundle: { patch: 'bundle.yml' } } } : {}),
  }))
  if (bundle) writeFileSync(join(dir, 'bundle.yml'), '[]\n')
}

/**
 * Build a desktop layout: a runtime directory two levels below the application,
 * the pnpm entry beside it, and one profile holding one installed plugin.
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-services-'))
  const home = join(root, '.dsh')
  const profileDir = join(home, 'profiles', 'desktop')
  const runtimeDir = join(root, 'app', 'runtime')
  const recorded = join(root, 'pnpm-argv.json')
  mkdirSync(runtimeDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }))
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: unchanged\n')
  writeFileSync(join(runtimeDir, 'desktop-runtime.json'), JSON.stringify({
    schemaVersion: 1,
    release: { version: '1.0.0', nodeVersion: '1.0.0', pnpmVersion: '1.0.0' },
    platform: 'linux',
    arch: 'x64',
    sharedPackages: [{ name: '@deepseek-ai/cordis', version: '4.0.2', path: 'node_modules/@deepseek-ai/cordis' }],
    files: [],
  }))
  const entry = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  mkdirSync(join(entry, '..'), { recursive: true })
  // A stand-in for pnpm: records its argv and writes the dependency the way
  // `pnpm add --save-exact` would, so the reconcile pass runs for real.
  writeFileSync(entry, `import { readFileSync, writeFileSync } from 'node:fs'
const recorded = ${JSON.stringify(recorded)}
const manifestPath = ${JSON.stringify(join(profileDir, 'package.json'))}
const argv = process.argv.slice(2)
writeFileSync(recorded, JSON.stringify(argv))
const target = [...argv].reverse().find(argument => !argument.startsWith('-'))
const command = argv.find(argument => !argument.startsWith('-'))
if (command === 'add' && target !== undefined) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const name = target.startsWith('@') ? target.slice(0, target.indexOf('@', 1)) : target.split('@')[0]
  manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\\n')
  writeFileSync(${JSON.stringify(join(profileDir, 'pnpm-lock.yaml'))}, 'lockfileVersion: changed\\n')
}
`)
  return { root, home, profileDir, runtimeDir, recorded }
}

/** Provide the services on a bare Context the way the Electron Host boot does. */
function services(built: Fixture): Context {
  const ctx = new Context()
  ctx.provide('dshHomePath', (...segments: string[]) => join(built.home, ...segments))
  provideDesktopServices(ctx, { profileDir: built.profileDir, runtimeDir: built.runtimeDir })
  return ctx
}

interface ProfileManifest {
  readonly dependencies: Record<string, string>
  readonly dsh: { readonly profile: { readonly bundles: string[] } }
}

function manifest(profileDir: string): ProfileManifest {
  const value: unknown = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  if (typeof value !== 'object' || value === null) throw new Error('fixture profile manifest is not an object')
  return value as ProfileManifest
}

it('installs into the booted profile through the application pnpm and reconciles it', async () => {
  const built = fixture()
  try {
    writeInstalled(built.profileDir, 'fixture-plugin', '1.0.0', true)
    const ctx = services(built)
    expect(ctx.get('desktopProfiles')).toEqual({ current: { name: 'desktop', dir: built.profileDir } })
    const pnpm = ctx.get('desktopPnpm')
    if (pnpm === undefined) throw new Error('desktopPnpm was not provided')

    const handle = pnpm.runPlugin(['add', 'fixture-plugin@1.0.0', '-w', '--reporter=ndjson'], built.profileDir)
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })

    // The registry, store, and user config are the Electron application's own,
    // and the install is pinned to an exact version.
    expect(JSON.parse(readFileSync(built.recorded, 'utf8'))).toEqual([
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${join(built.home, 'desktop', 'pnpm', 'store')}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${join(built.home, 'desktop', 'pnpm', 'config', 'npmrc')}`,
      'add', 'fixture-plugin@1.0.0', '-w', '--reporter=ndjson', '--save-exact',
    ])
    const written = manifest(built.profileDir)
    expect(written.dependencies).toEqual({ 'fixture-plugin': '1.0.0' })
    expect(written.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'fixture-plugin',
    ])
  } finally {
    rmSync(built.root, { recursive: true, force: true })
  }
})

it('refuses targets this profile cannot boot and runs no process for them', async () => {
  const built = fixture()
  try {
    const ctx = services(built)
    const pnpm = ctx.get('desktopPnpm')
    if (pnpm === undefined) throw new Error('desktopPnpm was not provided')
    for (const target of ['github:user/repo', 'file:/tmp/plugin', 'plugin@npm:other@1.0.0', 'plugin@']) {
      expect(() => pnpm.runPlugin(['add', target], built.profileDir)).toThrow(/installs npm-published plugins only/u)
    }
    expect(isRegistryTarget('dshmarket')).toBe(true)
    expect(isRegistryTarget('@scope/plugin@^1.2.3')).toBe(true)
    expect(isRegistryTarget('dshmarket@latest')).toBe(true)
    expect(isRegistryTarget('plugin@npm:other@1.0.0')).toBe(false)
    expect(isRegistryTarget('github:user/repo')).toBe(false)
  } finally {
    rmSync(built.root, { recursive: true, force: true })
  }
})

it('serializes package operations and only the first holds the slot', async () => {
  const built = fixture()
  try {
    writeInstalled(built.profileDir, 'fixture-plugin', '1.0.0', true)
    const ctx = services(built)
    const pnpm = ctx.get('desktopPnpm')
    if (pnpm === undefined) throw new Error('desktopPnpm was not provided')

    const first = pnpm.runPlugin(['add', 'fixture-plugin@1.0.0'], built.profileDir)
    expect(() => pnpm.runPlugin(['add', 'fixture-plugin@1.0.0'], built.profileDir))
      .toThrow(/another desktop pnpm operation is already running/u)
    expect(await first.done).toEqual({ exitCode: 0, signal: null })

    // Releasing the slot lets the next operation run; a removal drops the
    // package from the bundle list while it stays installed.
    const removal = pnpm.runPlugin(['remove', 'fixture-plugin'], built.profileDir)
    expect(await removal.done).toEqual({ exitCode: 0, signal: null })
    expect(manifest(built.profileDir).dsh.profile.bundles)
      .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  } finally {
    rmSync(built.root, { recursive: true, force: true })
  }
})

it('pins installed versions and keeps a package without a bundle patch inactive', () => {
  const built = fixture()
  try {
    writeInstalled(built.profileDir, 'fixture-plugin', '1.2.0', true)
    writeInstalled(built.profileDir, 'plain-plugin', '2.0.0', false)
    writeFileSync(join(built.profileDir, 'package.json'), JSON.stringify({
      name: 'desktop-profile',
      dependencies: { 'fixture-plugin': '^1.0.0', 'plain-plugin': '^2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'fixture-plugin', 'plain-plugin'] } },
    }))

    reconcileProfile(built.profileDir)

    const written = manifest(built.profileDir)
    expect(written.dependencies).toEqual({ 'fixture-plugin': '1.2.0', 'plain-plugin': '2.0.0' })
    expect(written.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'fixture-plugin',
    ])
  } finally {
    rmSync(built.root, { recursive: true, force: true })
  }
})

it('rolls a plugin back when the next start could not boot it', async () => {
  const built = fixture()
  try {
    // The plugin installs, but one dependency resolves from the shared profile
    // container above it, which this profile does not own.
    writeInstalled(built.profileDir, 'fixture-plugin', '1.0.0', true, { 'stray-dep': '1.0.0' })
    writeInstalled(join(built.profileDir, '..'), 'stray-dep', '1.0.0', false)
    const before = readFileSync(join(built.profileDir, 'package.json'), 'utf8')
    const lockBefore = readFileSync(join(built.profileDir, 'pnpm-lock.yaml'), 'utf8')
    const ctx = services(built)
    const pnpm = ctx.get('desktopPnpm')
    if (pnpm === undefined) throw new Error('desktopPnpm was not provided')

    const handle = pnpm.runPlugin(['add', 'fixture-plugin@1.0.0'], built.profileDir)
    const reported = new Promise<string>((settle) => {
      let text = ''
      handle.stderr.setEncoding('utf8')
      handle.stderr.on('data', (chunk: string) => { text += chunk })
      handle.stderr.on('end', () => { settle(text) })
    })
    expect(await handle.done).toEqual({ exitCode: 1, signal: null })
    const stderr = await reported

    // The market reports this text, so it names both the plugin and the profile.
    expect(stderr).toMatch(/resolves stray-dep outside its owned packages/u)
    expect(stderr).toMatch(/rolled back/u)
    expect(readFileSync(join(built.profileDir, 'package.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(built.profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(lockBefore)
    // Undoing the change is a pnpm run of its own, which drops what the restored
    // manifest no longer lists.
    expect(JSON.parse(readFileSync(built.recorded, 'utf8'))).toEqual([
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${join(built.home, 'desktop', 'pnpm', 'store')}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${join(built.home, 'desktop', 'pnpm', 'config', 'npmrc')}`,
      'install', '--ignore-scripts',
    ])
  } finally {
    rmSync(built.root, { recursive: true, force: true })
  }
})

it('accepts a dependency the profile owns and one the runtime supplies', () => {
  const built = fixture()
  try {
    writeInstalled(built.profileDir, 'fixture-plugin', '1.0.0', true, { 'inner-dep': '1.0.0' })
    writeInstalled(built.profileDir, 'inner-dep', '1.0.0', false)
    writeFileSync(join(built.profileDir, 'package.json'), JSON.stringify({
      name: 'desktop-profile',
      dependencies: { 'fixture-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'fixture-plugin'] } },
    }))
    expect(() => { validateProfileGraph(built.profileDir, built.runtimeDir) }).not.toThrow()

    // A package the runtime supplies belongs in peerDependencies, and a plugin
    // that depends on it directly is refused rather than started once.
    writeInstalled(built.profileDir, 'fixture-plugin', '1.0.0', true, { '@deepseek-ai/cordis': '4.0.2' })
    expect(() => { validateProfileGraph(built.profileDir, built.runtimeDir) })
      .toThrow(/must declare @deepseek-ai\/cordis as a peer dependency/u)
  } finally {
    rmSync(built.root, { recursive: true, force: true })
  }
})
