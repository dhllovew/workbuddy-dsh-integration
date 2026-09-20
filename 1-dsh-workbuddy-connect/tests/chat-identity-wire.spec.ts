import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { ChatIdentity } from '../src/client-identity.ts'

/**
 * Outbound wire pin for the phase-1 chat identity (plan §3, 阶段一离线检查):
 * capture the exact `(url, init)` the client hands to `fetch` and assert that
 * chat and probe present the desktop UA while everything else — the shared
 * header family, the body shapes, refresh, catalog, and billing — stays
 * byte-for-byte what it has always been.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

/** Deterministic identity so assertions never depend on the machine's Apps. */
const IDENTITY: ChatIdentity = { clientVersion: '5.5.6', cliVersion: '2.137.1' }

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({
    resolveChatIdentity: async () => IDENTITY,
    resolveAppVersion: async () => ({ version: '5.5.6', source: 'installed', bundle: '/x' }),
  })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub fetch and return probes for the (url, init) pairs it received. */
function captureFetch(body: string, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => fakeResponse(body, ok, status))
  vi.stubGlobal('fetch', fetchMock)
  const calls = (): [string, RequestInit][] =>
    fetchMock.mock.calls as unknown as [string, RequestInit][]
  return {
    last: () => {
      expect(fetchMock).toHaveBeenCalled()
      const captured = calls()
      const last = captured[captured.length - 1]
      if (last === undefined) throw new Error('no fetch call captured')
      return last
    },
    /** Every captured call — the catalog paths now issue one per route. */
    all: () => {
      expect(fetchMock).toHaveBeenCalled()
      return calls()
    },
  }
}

describe('chatStream identity', () => {
  it('presents the CN desktop identity and the official client header family', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    // The shared family.
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest')
    expect(headers['X-CodeBuddy-Request']).toBe('1')
    expect(headers['Accept-Language']).toBe('zh-CN')
    expect(headers['Accept']).toBe('application/json, text/event-stream')
    expect(headers['Origin']).toBe('https://www.codebuddy.cn')
    expect(headers['Referer']).toBe('https://www.codebuddy.cn/')
    expect(headers['X-User-Id']).toBe('uid-1')
    expect(headers['Authorization']).toBe('Bearer at')
    // Usage attribution: the desktop client names itself and its purpose, so the
    // upstream ledger never records the empty client a gateway shows. The version
    // quotes the same identity as the UA, so the two cannot name different builds.
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe('5.5.6')
    expect(headers['X-Product']).toBe('WorkBuddy')
    expect(headers['X-Refresh-Token']).toBeUndefined()
    expect(init.body).toBe(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
  })

  it('names the international product in the UA and still prepends the first system message', async () => {
    const wire = captureFetch('{}')
    const result = await client().chatStream(GLOBAL, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(result.ok).toBe(true)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
    expect(headers['Accept-Language']).toBe('en-US')
    expect(headers['X-Product']).toBe('WorkBuddy')
    const body = JSON.parse(init.body as string) as { messages: { role: string }[] }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[1]?.role).toBe('user')
  })
})

describe('probeEffort identity', () => {
  it('shares the chat identity rule — same UA family, CN probe shape', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(CN, 'model-x', 'low', new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    const body = JSON.parse(init.body as string) as {
      messages: { role: string }[]; max_tokens: number; reasoning_effort: string
    }
    expect(body.messages[0]?.role).toBe('user')
    expect(body.max_tokens).toBe(1)
    expect(body.reasoning_effort).toBe('low')
  })

  it('uses the international UA with the probe-only system and token floor', async () => {
    const wire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    await client().probeEffort(GLOBAL, 'model-x', undefined, new AbortController().signal)
    const [, init] = wire.last()
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
    const body = JSON.parse(init.body as string) as { messages: { role: string }[]; max_tokens: number }
    expect(body.messages[0]?.role).toBe('system')
    expect(body.max_tokens).toBe(16)
    expect('reasoning_effort' in body).toBe(false)
  })

  it('still constructs chat and probe requests, in the desktop fallback form, when the resolver throws', async () => {
    const throwing = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => {
        throw new Error('boom')
      },
    })
    const chatWire = captureFetch('{}')
    const chat = await throwing.chatStream(CN, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(chat.ok).toBe(true)
    expect((chatWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6')

    const probeWire = captureFetch('{"code":11150,"msg":"no"}', false, 400)
    const probe = await throwing.probeEffort(GLOBAL, 'model-x', 'low', new AbortController().signal)
    expect(probe.status).toBe(400)
    expect((probeWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('WorkBuddy/5.5.2 WorkBuddy AI/5.5.2')
  })
})

describe('the rest of the wire (alignment pin)', () => {
  it('presents the desktop identity on refresh and reports the plugin channel', async () => {
    const wire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await client().refreshToken(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
    // The refresh channel the official client reports on this endpoint.
    expect(headers['X-Auth-Refresh-Source']).toBe('plugin')
    expect(headers['X-Refresh-Token']).toBe('rt')
    expect(headers['X-CodeBuddy-Request']).toBe('1')
    expect(headers['Accept-Language']).toBe('zh-CN')
    expect(headers['Origin']).toBe('https://www.codebuddy.cn')
  })

  it('probes both catalog routes for a CN account', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        models: [
          { id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 },
          { id: 'v3-only', name: 'V3', maxInputTokens: 100, maxOutputTokens: 10 },
        ],
        agents: [{ name: 'cli', models: ['m', 'v3-only'] }],
      },
    }))
    const models = await client().fetchModels(CN)
    expect(wire.all().map(([url]) => url).sort()).toEqual([
      'https://copilot.tencent.com/console/enterprises/personal/models',
      'https://copilot.tencent.com/v3/config',
    ])
    for (const [, init] of wire.all()) {
      const headers = init.headers as Record<string, string>
      expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1')
      expect(headers['X-CodeBuddy-Request']).toBe('1')
      expect(headers['Accept-Language']).toBe('zh-CN')
    }
    expect(models.map(model => model.id)).toEqual(['m', 'v3-only'])
  })

  it('probes the international enterprise route alongside the product document', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }], agents: [{ name: 'cli', models: ['m'] }] },
    }))
    const models = await client().fetchModels(GLOBAL)
    expect(wire.all().map(([url]) => url).sort()).toEqual([
      'https://www.workbuddy.ai/v2/enterprises/personal/models',
      'https://www.workbuddy.ai/v3/config',
    ])
    for (const [, init] of wire.all()) {
      const headers = init.headers as Record<string, string>
      // The product document's UA gate accepts the desktop identity, so the
      // App-shaped UA is no longer needed on any path.
      expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6 WorkBuddy AI/5.5.6 CLI/2.137.1')
      expect(headers['Accept-Language']).toBe('en-US')
    }
    expect(models.map(model => model.id)).toEqual(['m'])
  })

  it('bills on the personal path with the billing UA and the account headers', async () => {
    const wire = captureFetch(JSON.stringify({
      code: 0, msg: 'ok',
      data: { Response: { Data: { Accounts: [] } } },
    }))
    await client().fetchCredits(CN)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-user-resource')
    const headers = init.headers as Record<string, string>
    // The single-segment desktop form: the billing family overrides the UA
    // explicitly, so the agent-CLI segment the conversation path adds is absent.
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.6')
    expect(headers['X-CodeBuddy-Request']).toBe('1')
    expect(headers['Accept-Language']).toBe('zh-CN')
    expect(headers['X-User-Id']).toBe('uid-1')
  })

  it('falls back to the prefixed international billing path only on a 404', async () => {
    const fetchMock = vi.fn(async (url: unknown) => url === 'https://www.workbuddy.ai/billing/meter/get-user-resource'
      ? fakeResponse('not found', false, 404)
      : fakeResponse(JSON.stringify({ code: 0, msg: 'ok', data: { Response: { Data: { Accounts: [] } } } })))
    vi.stubGlobal('fetch', fetchMock)
    await client().fetchCredits(GLOBAL)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://www.workbuddy.ai/billing/meter/get-user-resource',
      'https://www.workbuddy.ai/v2/billing/meter/get-user-resource',
    ])
  })
})
