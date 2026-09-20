/**
 * Model selection through the real plugin: settings write → catalog → picker.
 *
 * The catalog-level cases live in `model-selection.spec.ts`; these drive the
 * full `apply()` wiring, because the behaviour that can silently break is the
 * plumbing between them — the settings section's schema, the merge into the
 * variant config, and the adapter invalidation that makes DSH re-read the list.
 *
 * They also pin the two failure modes that are invisible at the catalog layer:
 * a schema that materializes an unset selection as `[]` (which would empty
 * every existing user's picker on upgrade), and a selection that fails to
 * survive a restart.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
let root: string | undefined

/** A desktop-shaped CN credential document. */
function credentialDocument(domain: string): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
  })
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/**
 * Boot the real plugin with a CN credential and an offline upstream.
 *
 * Offline is deliberate: the variant then serves the built-in fallback roster,
 * which is a fixed, known list — a stubbed live catalog would make it ambiguous
 * whether a changed list came from the selection or from the fetch.
 */
async function boot(settingsFile?: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'workbuddy-selection-'))
  const cnFile = join(root, 'cn.info')
  const resolvedRoot = root
  await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
  vi.stubEnv('DSH_HOME', resolvedRoot)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
  vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(resolvedRoot, 'absent.info'))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

  class FileSettings extends SettingsProvider {
    readonly writable = true
    protected async load(): Promise<Record<string, unknown>> {
      if (settingsFile === undefined) return {}
      return JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
    }
    protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
      if (settingsFile === undefined) return
      const document = await this.load()
      document[ns] = section
      await writeFile(settingsFile, JSON.stringify(document))
    }
  }

  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(settingsFile === undefined ? MemorySettings : FileSettings)
  await ctx.plugin(WorkBuddy, {})
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
  })
  return ctx
}

describe('WorkBuddy model selection integration', () => {
  it('offers every catalog model before any selection is made', async () => {
    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })
    // The upgrade case: an absent selection must not hide anything, or every
    // existing user would open DSH to an empty model picker.
    const listed = await ctx.llm.listModels('workbuddy')
    expect(listed.map(model => model.id)).toContain('deepseek-v4.1-flash')
    expect(listed.map(model => model.id)).toContain('glm-5.3')
  })

  it('narrows the picker to a written selection and keeps the rest routable', async () => {
    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(1)
    })

    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { selectedModels: ['glm-5.3'] })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['glm-5.3'])
    })

    // A deselected model must still resolve: the user may already have a
    // conversation or a default model pointing at it, and `dsh-llm-pi-ai`
    // throws UNKNOWN_MODEL when the provider collection omits an id.
    const resolved = await ctx.llm.resolveModelInfo('workbuddy', 'deepseek-v4.1-flash')
    expect(resolved.id).toBe('deepseek-v4.1-flash')
  })

  it('shows nothing when the user deliberately selects none, and restores on clear', async () => {
    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })

    // An explicit empty array is the user's real instruction, distinct from
    // "never configured" — it must empty the picker rather than fall back.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { selectedModels: [] })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })

    // Clearing the field returns to "no preference", not to "none".
    //
    // This goes through `mutate`+`unset` rather than `update`, because a merge
    // patch carrying `undefined` leaves the stored array in place: the write
    // would succeed while changing nothing, and the picker would stay empty.
    await ctx.settings.mutate(WorkBuddy.WORKBUDDY_SETTINGS_NS, [{ op: 'unset', path: ['selectedModels'] }])
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })
  })

  /**
   * The clear path must actually clear, not no-op.
   *
   * `update({ selectedModels: undefined })` is a silent trap here: the patch
   * merges, an undefined value is not a merge instruction, and the stored array
   * survives — so a "show all" button implemented that way would appear to work
   * while leaving the model list filtered.
   */
  it('clears the stored selection rather than leaving it in place', async () => {
    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { selectedModels: ['glm-5.3'] })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['glm-5.3'])
    })

    await ctx.settings.mutate(WorkBuddy.WORKBUDDY_SETTINGS_NS, [{ op: 'unset', path: ['selectedModels'] }])
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(1)
    })
    // The field is genuinely gone from the stored section, so a later restart
    // reads back "no preference" rather than the stale ids.
    const described = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((described?.value as Record<string, unknown> | undefined)?.['selectedModels']).toBeUndefined()
  })

  it('keeps the CN and international selections independent', async () => {
    const ctx = await boot()
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })

    // Writing the CN section must not touch the international variant, whose
    // catalog uses different ids entirely.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { selectedModels: ['glm-5.3'] })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['glm-5.3'])
    })
    const ai = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_AI_SETTINGS_NS)
    expect((ai?.value as Record<string, unknown> | undefined)?.['selectedModelsAI']).toBeUndefined()
  })

  it('survives a restart by reading the selection back from settings', async () => {
    const settingsRoot = await mkdtemp(join(tmpdir(), 'workbuddy-selection-persist-'))
    const settingsFile = join(settingsRoot, 'settings.json')
    await writeFile(settingsFile, '{}')
    try {
      const first = await boot(settingsFile)
      await vi.waitFor(async () => {
        expect((await first.llm.listModels('workbuddy')).length).toBeGreaterThan(1)
      })
      await first.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { selectedModels: ['glm-5.3'] })
      await vi.waitFor(async () => {
        expect((await first.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['glm-5.3'])
      })
      await first.fiber.dispose()
      context = undefined

      // A fresh process must apply the stored selection without the user
      // re-entering it; the persisted document is the only carrier.
      const second = await boot(settingsFile)
      await vi.waitFor(async () => {
        expect((await second.llm.listModels('workbuddy')).map(model => model.id)).toEqual(['glm-5.3'])
      })
    } finally {
      await rm(settingsRoot, { recursive: true, force: true })
    }
  })
})
