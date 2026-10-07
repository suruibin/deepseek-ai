import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyDevelopmentProjectPlugins,
  developmentPluginRegistry,
  inspectDevelopmentPlugin,
  mutateDevelopmentPlugins,
  readDevelopmentPlugins,
  seedDevelopmentPlugins,
  writeDevelopmentPlugins,
} from '../src/development-plugins.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-plugins-test-'))
  roots.push(root)
  return root
}

function pluginDirectory(root: string, name: string, version = '0.1.0', patch = './cordis.patch.yml'): string {
  const directory = join(root, 'plugins', ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name,
    version,
    dsh: { bundle: { patch } },
  })}\n`)
  writeFileSync(join(directory, 'cordis.patch.yml'), '')
  return directory
}

function projectDirectory(root: string): string {
  const project = join(root, 'development', 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-runtime',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': '1.2.3', '@deepseek-ai/dsh-desktop-host': '1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  })}\n`)
  return project
}

function manifestOf(project: string): {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
} {
  return JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop development plugins', () => {
  it('seeds the inventory once and keeps later activation changes', () => {
    const root = temporaryRoot()
    const registry = developmentPluginRegistry(join(root, 'development', 'project'))
    const glass = pluginDirectory(root, 'dsh-glass-theme')
    expect(readDevelopmentPlugins(registry)).toEqual([])

    const seeded = seedDevelopmentPlugins(registry, [glass])
    expect(seeded).toMatchObject([{ name: 'dsh-glass-theme', version: '0.1.0', enabled: true }])
    writeDevelopmentPlugins(registry, seeded.map(plugin => ({ ...plugin, enabled: false })))
    expect(seedDevelopmentPlugins(registry, [glass])).toMatchObject([{ enabled: false }])
  })

  it('rejects a checkout without a bundle patch or with an inexact version', () => {
    const root = temporaryRoot()
    const directory = join(root, 'plugins', 'missing-patch')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{"name":"missing-patch","version":"1.0.0"}\n')
    expect(() => inspectDevelopmentPlugin(directory)).toThrow(/dsh\.bundle\.patch/u)
    expect(() => inspectDevelopmentPlugin(pluginDirectory(root, 'loose-version', '1.0'))).toThrow(/exact npm package name/u)
    expect(() => inspectDevelopmentPlugin(pluginDirectory(root, 'absent-patch', '1.0.0', './missing.yml')))
      .toThrow(/dsh\.bundle\.patch/u)
  })

  it('writes installed plugins into the generated project and links their checkouts', () => {
    const root = temporaryRoot()
    const project = projectDirectory(root)
    const glass = inspectDevelopmentPlugin(pluginDirectory(root, 'dsh-glass-theme'))
    const disabled = { ...inspectDevelopmentPlugin(pluginDirectory(root, 'dsh-other')), enabled: false }
    applyDevelopmentProjectPlugins(project, [glass, disabled])

    const manifest = manifestOf(project)
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh': '1.2.3',
      '@deepseek-ai/dsh-desktop-host': '1.2.3',
      'dsh-glass-theme': '0.1.0',
      'dsh-other': '0.1.0',
    })
    expect(manifest.dsh.profile.bundles)
      .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-glass-theme'])
    expect(realpathSync(join(project, 'node_modules', 'dsh-glass-theme'))).toBe(realpathSync(glass.directory))
    expect(lstatSync(join(project, 'node_modules', 'dsh-other')).isSymbolicLink()).toBe(true)

    applyDevelopmentProjectPlugins(project, [glass], ['dsh-glass-theme', 'dsh-other'])
    expect(existsSync(join(project, 'node_modules', 'dsh-other'))).toBe(false)
    expect(manifestOf(project).dependencies).toEqual({
      '@deepseek-ai/dsh': '1.2.3',
      '@deepseek-ai/dsh-desktop-host': '1.2.3',
      'dsh-glass-theme': '0.1.0',
    })
  })

  it('installs, toggles, refreshes and removes local plugin checkouts', () => {
    const root = temporaryRoot()
    const glass = pluginDirectory(root, 'dsh-glass-theme')
    const installed = mutateDevelopmentPlugins([], { type: 'plugin-add', spec: `file:${glass}` })
    expect(installed).toMatchObject([{ name: 'dsh-glass-theme', version: '0.1.0', enabled: true }])
    expect(() => mutateDevelopmentPlugins([], { type: 'plugin-add', spec: 'dsh-glass-theme' }))
      .toThrow(/absolute plugin directory/u)

    const disabled = mutateDevelopmentPlugins(installed, {
      type: 'plugin-toggle', name: 'dsh-glass-theme', enabled: false,
    })
    expect(disabled).toMatchObject([{ enabled: false }])

    writeFileSync(join(glass, 'package.json'), `${JSON.stringify({
      name: 'dsh-glass-theme',
      version: '0.2.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })}\n`)
    expect(mutateDevelopmentPlugins(disabled, { type: 'plugin-update', name: 'dsh-glass-theme', version: '9.9.9' }))
      .toMatchObject([{ version: '0.2.0', enabled: true }])
    expect(mutateDevelopmentPlugins(disabled, { type: 'plugin-remove', name: 'dsh-glass-theme' })).toEqual([])
    expect(mutateDevelopmentPlugins(installed, { type: 'plugins-disable-all' })).toMatchObject([{ enabled: false }])
    expect(() => mutateDevelopmentPlugins(disabled, { type: 'plugin-update', name: 'absent', version: '1.0.0' }))
      .toThrow(/is not installed/u)
  })
})
