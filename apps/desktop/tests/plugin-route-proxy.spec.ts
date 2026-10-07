/**
 * Carrier proxy for plugin-registered routes: Electron's `dsh-app://` handler
 * has no socket of its own, so a path a plugin route owns is replayed against
 * the loopback port. Both properties asserted here were field failures — the
 * replay must actually leave the non-special carrier scheme, and it must arrive
 * as the same-origin loopback request plugin guards compare Host against.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it } from 'vitest'
import { pluginRouteFetch } from '../../desktop-host/src/index.ts'

interface Observed {
  readonly method: string
  readonly url: string
  readonly host: string | undefined
  readonly origin: string | undefined
  readonly body: string
}

interface Probe {
  readonly server: Server
  readonly port: number
  readonly seen: Observed[]
  readonly owned: Set<string>
}

let probe: Probe | undefined

afterEach(async () => {
  if (probe !== undefined) await new Promise<void>((done) => { probe?.server.close(() => { done() }) })
  probe = undefined
})

/** A loopback server standing in for `webServer`, recording what one replay sent it. */
async function startProbe(owned: readonly string[]): Promise<Probe> {
  const seen: Observed[] = []
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        host: request.headers.host,
        origin: request.headers.origin,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  probe = { server, port, seen, owned: new Set(owned) }
  return probe
}

/** Host context whose `webServer` service is the probe above. */
function contextFor(current: Probe): Context {
  const ctx = new Context()
  ctx.provide('webServer', {
    port: current.port,
    hasRoute: (pathname: string) => current.owned.has(pathname),
  } as unknown as WebServer)
  return ctx
}

it('replays an owned plugin route as a same-origin loopback request', async () => {
  const current = await startProbe(['/dsh-market/install'])
  const request = new Request('dsh-app://app/dsh-market/install?probe=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'dsh-app://app' },
    body: JSON.stringify({ url: 'https://example.invalid/plugin' }),
  })
  const response = await pluginRouteFetch(contextFor(current), request)
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ ok: true })
  // Node owns the framing of the loopback hop; the framed pipe delimits the body.
  expect(response?.headers.get('transfer-encoding')).toBeNull()
  const authority = `127.0.0.1:${String(current.port)}`
  expect(current.seen).toEqual([{
    method: 'POST',
    url: '/dsh-market/install?probe=1',
    host: authority,
    origin: `http://${authority}`,
    body: JSON.stringify({ url: 'https://example.invalid/plugin' }),
  }])
})

it('leaves a pathname no plugin route owns to the asset handler', async () => {
  const current = await startProbe([])
  const request = new Request('dsh-app://app/index.html')
  expect(await pluginRouteFetch(contextFor(current), request)).toBeUndefined()
  expect(current.seen).toEqual([])
})
