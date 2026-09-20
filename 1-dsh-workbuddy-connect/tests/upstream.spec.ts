import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { normalizeCredits, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Offline unit tests for WorkBuddyUpstreamClient, mocking the global `fetch`
 * so the multi-layer response parsing and the credit-remain selection logic in
 * `fetchCredits` are covered without a real account or network. This closes a
 * gap that previously relied solely on `scripts/live-e2e.mjs`.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

/** Build the nested upstream billing document that `fetchCredits` unwraps. */
function billingEnvelope(accounts: unknown[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      Response: {
        Data: {
          Accounts: accounts,
        },
      },
    },
  })
}

/** Minimal Response-like object satisfying `readEnvelope` (which calls `.text()`). */
function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  /** Build the models-catalog envelope that `fetchModels` unwraps. */
  function modelsEnvelope(models: unknown[], cliIds: string[]): string {
    return JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        models,
        agents: [{ name: 'cli', models: cliIds }],
      },
    })
  }

  it('propagates supportsImages per model, treating unknown or disabled as text-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-img', name: 'Image Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
      { id: 'm-muted', name: 'Multimodal Switched Off', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true, disabledMultimodal: true },
      { id: 'm-text', name: 'Text Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: false },
      { id: 'm-unknown', name: 'No Modality Field', maxInputTokens: 100_000, maxOutputTokens: 32_000 },
      { id: 'm-noncli', name: 'Not A CLI Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-img', 'm-muted', 'm-text', 'm-unknown']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(models).toHaveLength(4)
    expect(byId.get('m-img')?.supportsImages).toBe(true)
    expect(byId.get('m-muted')?.supportsImages).toBe(false)
    expect(byId.get('m-text')?.supportsImages).toBe(false)
    // Absent field means unknown capability; the conservative answer is text-only.
    expect(byId.get('m-unknown')?.supportsImages).toBe(false)
  })

  it('keeps the catalog shape (name, contextWindow, maxTokens) alongside the flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-1', name: 'Model One', maxInputTokens: 168_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-1']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'm-1',
      name: 'Model One',
      contextWindow: 168_000,
      maxTokens: 32_000,
      supportsImages: true,
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
      billing: { free: false },
    })
  })

  it('parses reasoning and billing metadata from the upstream fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      {
        id: 'm-reason',
        name: 'Reasoner',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        reasoning: { supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true },
      },
      {
        id: 'm-free',
        name: 'Freebie',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        onlyReasoning: true,
        reasoning: { canDisableThinking: false },
        credits: 'x0.00',
        tags: ['craft', 'badge:限时免费:#FF0000'],
      },
      {
        id: 'm-plain',
        name: 'Plain',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
      },
    ], ['m-reason', 'm-free', 'm-plain']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(byId.get('m-reason')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: false,
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(byId.get('m-free')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: true,
      canDisableThinking: false,
    })
    expect(byId.get('m-free')?.billing).toEqual({ credits: 'x0.00', badges: ['限时免费'], free: true })
    // A model with no reasoning or billing fields is explicitly non-reasoning
    // (supports: false) and carries no free/badge facts.
    expect(byId.get('m-plain')?.reasoning).toEqual({
      supports: false,
      onlyReasoning: false,
      canDisableThinking: true,
    })
    expect(byId.get('m-plain')?.billing).toEqual({ free: false })
  })
})

describe('WorkBuddyUpstreamClient.fetchCredits', () => {
  it('unwraps the nested envelope and aggregates total across accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg-a', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
      { PackageName: 'pkg-b', CycleCapacitySize: 200, CycleCapacityRemain: 60 },
    ]))))

    const client = new WorkBuddyUpstreamClient()
    const credits = await client.fetchCredits(CREDENTIAL)

    expect(credits.total).toBe(100)
    expect(credits.accounts).toHaveLength(2)
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg-a', remain: 40, size: 100 })
    expect(credits.accounts[1]).toEqual({ packageName: 'pkg-b', remain: 60, size: 200 })
  })

  it('selects cycle remain when size > 0 (first branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 30, CapacityRemain: 999 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // First branch: size>0 → cycleRemain, ignoring the larger CapacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 30, size: 100 })
  })

  it('selects cycle remain when there is cycle usage even without size (second branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 0, CycleCapacityRemain: 20, CycleCapacityUsed: 5, CapacityRemain: 1 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Second branch: size<=0 but cycleUsed>0 → cycleRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 20, size: 0 })
  })

  it('falls back to capacity remain when no cycle fields (third branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacityRemain: 77 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Third branch: no size, no cycle → capacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 77, size: 0 })
  })

  it('clamps a negative remain to zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: -50 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.remain).toBe(0)
    expect(credits.total).toBe(0)
  })

  it('falls back to CapacitySize for size when cycle size is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacitySize: 500, CapacityRemain: 120 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // size falls back to CapacitySize=500; remain from third branch = 120.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 120, size: 500 })
  })

  it('labels a missing package name as (unnamed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { CycleCapacitySize: 10, CycleCapacityRemain: 5 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.packageName).toBe('(unnamed)')
  })

  it('returns an empty list for an empty Accounts array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([])
  })

  it('skips non-object account entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      null,
      'not-an-object',
      42,
      { PackageName: 'valid', CycleCapacitySize: 10, CycleCapacityRemain: 7 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts).toHaveLength(1)
    expect(credits.accounts[0]!.packageName).toBe('valid')
  })

  it('throws when the upstream business code is non-zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      JSON.stringify({ code: 1, msg: 'billing error' }),
    )))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/billing error/)
  })

  it('throws when the upstream returns non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('not json')))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/non-JSON/)
  })
})

/**
 * CN enterprise accounts are served by a different endpoint than personal
 * ones; asking the personal endpoint for an enterprise account answers with an
 * empty `Accounts` list, which renders as a confident "0 credit" (issue #31).
 *
 * The personal-path expectations above double as the zero-regression guard:
 * they run on `CREDENTIAL`, which carries no `enterpriseId`.
 */
describe('WorkBuddyUpstreamClient.fetchCredits (CN enterprise)', () => {
  const ENTERPRISE: WorkBuddyCredential = { ...CREDENTIAL, enterpriseId: 'ent-1' }

  /** The enterprise answer: a single cycle quota, not a package list. */
  function enterpriseEnvelope(fields: Record<string, unknown>): string {
    return JSON.stringify({ code: 0, msg: 'OK', data: fields })
  }

  it('requests the enterprise endpoint instead of the personal one', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 })))
    vi.stubGlobal('fetch', fetchMock)

    await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toBe('https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage')
    expect(url).not.toContain('get-user-resource')
  })

  it('sends the enterprise identity headers and an empty body', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 })))
    vi.stubGlobal('fetch', fetchMock)

    await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string>; body: string }
    expect(init.headers['X-Enterprise-Id']).toBe('ent-1')
    expect(init.headers['X-Tenant-Id']).toBe('ent-1')
    // Identity travels in the headers only; the body stays an empty object.
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('reads camelCase quota fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(380)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 380, size: 500 }])
    expect(credits.unlimited).toBeUndefined()
  })

  it('reads snake_case quota fields (the app has both spellings)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limit_num: 500, used_num: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(380)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 380, size: 500 }])
  })

  it('marks limitNum -1 as unlimited rather than a negative balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: -1, credit: 120 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.unlimited).toBe(true)
    // Never a negative number, and never a zero that reads as "exhausted".
    expect(credits.total).toBe(0)
    expect(credits.accounts[0]!.remain).toBe(0)
  })

  it('clamps remaining quota to zero when usage exceeds limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 600 }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([{ packageName: 'enterprise', remain: 0, size: 500 }])
  })

  it('parses cycleResetTime when present in the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({
      limitNum: 500, credit: 120, cycleResetTime: '2026-10-01T00:00:00Z',
    }))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.cycleResetTime).toBe('2026-10-01T00:00:00Z')
  })

  it('throws a diagnosable error when no quota field is recognised', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ unexpected: 'shape' }))))

    // Must be a hard error: silently returning 0 is what hid issue #31.
    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised quota field/)
  })

  it('throws when a limit arrives without any recognised usage field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500 }))))

    // Defaulting the missing usage to 0 would render a confident "500 remaining"
    // from a half-read response: the same wrong-but-plausible number the
    // enterprise branch exists to prevent.
    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised usage field/)
  })

  it('throws when the usage field is present but not a number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: '120' }))))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE))
      .rejects.toThrow(/no recognised usage field/)
  })

  it('reports the received fields when the usage field is missing, without values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      enterpriseEnvelope({ limitNum: 500, secretUsed: 4242 }),
    )))

    const error = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)
      .then(() => undefined, (reason: unknown) => reason as Error)

    expect(error?.message).toContain('secretUsed:number')
    expect(error?.message).not.toContain('4242')
  })

  it('still accepts an explicit zero usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: 500, credit: 0 }))))

    // Zero used is a real reading and must not be mistaken for a missing field.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.total).toBe(500)
    expect(credits.unlimited).toBeUndefined()
  })

  it('does not require a usage field when the quota is uncapped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(enterpriseEnvelope({ limitNum: -1 }))))

    // An uncapped reading has no balance to subtract, so a missing used amount
    // is not a parse failure here.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)

    expect(credits.unlimited).toBe(true)
  })

  it('names the received fields in that error, without their values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      enterpriseEnvelope({ secretQuota: 998877, accountLabel: 'should-not-leak' }),
    )))

    const error = await new WorkBuddyUpstreamClient().fetchCredits(ENTERPRISE)
      .then(() => undefined, (reason: unknown) => reason as Error)

    // Field names and types are the diagnostic; values must not travel, since
    // this message reaches the browser and describes the account's usage.
    expect(error?.message).toContain('secretQuota:number')
    expect(error?.message).not.toContain('998877')
    expect(error?.message).not.toContain('should-not-leak')
  })

  it('keeps a personal credential on the personal endpoint', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
    ])))
    vi.stubGlobal('fetch', fetchMock)

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)

    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('get-user-resource')
    expect(credits.total).toBe(40)
  })

  it('keeps an international credential on the personal endpoint even with an enterpriseId', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
    ])))
    vi.stubGlobal('fetch', fetchMock)

    // The global enterprise endpoint is unverified, so the region gate must
    // hold: an international credential stays on the measured personal path.
    const credits = await new WorkBuddyUpstreamClient().fetchCredits({
      ...CREDENTIAL,
      domain: 'www.workbuddy.ai',
      enterpriseId: 'ent-global',
    })

    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    expect(url).toContain('workbuddy.ai')
    expect(url).toContain('get-user-resource')
    expect(url).not.toContain('get-enterprise-user-usage')
    expect(credits.total).toBe(40)
  })
})

describe('normalizeCredits', () => {
  it('keeps a bare multiplier untouched', () => {
    expect(normalizeCredits('x0.79')).toBe('x0.79')
    expect(normalizeCredits('x0.00')).toBe('x0.00')
  })

  it('strips a trailing credits unit word', () => {
    expect(normalizeCredits('x0.79 credits')).toBe('x0.79')
    expect(normalizeCredits('x1.62 credits')).toBe('x1.62')
    expect(normalizeCredits('x0.79 CREDITS')).toBe('x0.79')
    expect(normalizeCredits('x0.79 credit')).toBe('x0.79')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeCredits('  x0.79 credits  ')).toBe('x0.79')
  })

  it('returns undefined for absent or empty values', () => {
    expect(normalizeCredits(undefined)).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('   ')).toBeUndefined()
    expect(normalizeCredits('credits')).toBeUndefined()
  })
})
