/**
 * Model selection: the picker filter must never become a routing gate.
 *
 * These cases pin the three semantics the feature rests on — `undefined` means
 * "never configured" (expose everything), an empty array means "selected
 * nothing", and a deselected model stays resolvable so existing sessions and
 * defaults keep working.
 */
import { describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { Config as WorkBuddyConfig } from '../src/index.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'

/** The three models, named so a refresh can restore them individually. */
const ALPHA: WorkBuddyModelInfo = { id: 'alpha', name: 'Alpha', contextWindow: 1_000, maxTokens: 100, supportsImages: false, billing: { free: false } }
const BETA: WorkBuddyModelInfo = { id: 'beta', name: 'Beta', contextWindow: 2_000, maxTokens: 200, supportsImages: true, billing: { free: false } }
const GAMMA: WorkBuddyModelInfo = { id: 'gamma', name: 'Gamma', contextWindow: 3_000, maxTokens: 300, supportsImages: false, billing: { free: false } }

/** Three models is enough to tell "filtered" from "unfiltered" apart. */
const MODELS: readonly WorkBuddyModelInfo[] = [ALPHA, BETA, GAMMA]

/** A catalog carrying all three models and no selection. */
function catalogOf(): WorkBuddyCatalog {
  return new WorkBuddyCatalog(MODELS)
}

/**
 * An adapter over the given catalog.
 *
 * `listModels`/`resolveModel` are reached through the registered adapter, which
 * is the same surface DSH's model picker reads.
 */
function adapterOf(catalog: WorkBuddyCatalog) {
  return createWorkBuddyAdapter({
    catalog,
    store: {} as WorkBuddyCredentialStore,
    shim: {
      ready: Promise.resolve(),
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'test-token',
      close: async () => {},
    } as WorkBuddyShim,
  }).adapter
}

describe('WorkBuddy model selection', () => {
  it('exposes every model while no selection has been made', () => {
    const catalog = catalogOf()
    expect(catalog.selection()).toBeUndefined()
    expect(catalog.current().map(model => model.id)).toEqual(['alpha', 'beta', 'gamma'])
    // The distinction the UI renders: "no preference" is not "selected all".
    expect(catalog.missingSelection()).toEqual([])
  })

  it('narrows the visible catalog to the selection', () => {
    const catalog = catalogOf()
    expect(catalog.setSelection(['beta'])).toBe(true)
    expect(catalog.current().map(model => model.id)).toEqual(['beta'])
    // The unfiltered list stays available so a user can re-select a turned-off
    // model; filtering it here would make deselection irreversible.
    expect(catalog.available().map(model => model.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('treats an empty selection as "nothing selected", not "never configured"', () => {
    const catalog = catalogOf()
    catalog.setSelection([])
    expect(catalog.current()).toEqual([])
    expect(catalog.selection()).toEqual([])
    // Clearing the field restores the unconfigured state rather than emptying it.
    catalog.setSelection(undefined)
    expect(catalog.current().map(model => model.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('reports a changed selection only once, so callers can skip redundant invalidations', () => {
    const catalog = catalogOf()
    expect(catalog.setSelection(['alpha'])).toBe(true)
    expect(catalog.setSelection(['alpha'])).toBe(false)
    // Order must not count as a change: the id set is what the picker shows.
    expect(catalog.setSelection(['alpha', 'beta'])).toBe(true)
    expect(catalog.setSelection(['beta', 'alpha'])).toBe(false)
    expect(catalog.setSelection(undefined)).toBe(true)
    expect(catalog.setSelection(undefined)).toBe(false)
  })

  it('keeps a deselected model resolvable so existing sessions keep working', async () => {
    const catalog = catalogOf()
    catalog.setSelection(['alpha'])
    const adapter = adapterOf(catalog)

    const listed = await adapter.listModels('workbuddy')
    expect(listed.map(model => model.id)).toEqual(['alpha'])

    // The routing half must ignore the filter. `dsh-llm-pi-ai` resolves an id
    // against the provider's model collection and throws `UNKNOWN_MODEL` when
    // it is absent, so narrowing the collection itself would break every saved
    // session and stored default naming an unselected model.
    const resolved = await adapter.resolveModel('workbuddy', 'beta')
    expect(resolved.id).toBe('beta')
    expect(resolved.name).toBe('Beta')
    expect(catalog.resolve('beta')?.name).toBe('Beta')

    // The deselected-but-routable model is still streamable, which is what
    // makes the guarantee meaningful rather than cosmetic.
    await expect(adapter.prepareCall('workbuddy', 'beta')).resolves.toBeDefined()
  })

  it('reports selected models the catalog no longer offers instead of dropping them', () => {
    const catalog = catalogOf()
    catalog.setSelection(['alpha', 'retired-model'])
    expect(catalog.missingSelection()).toEqual(['retired-model'])

    // Drop both selected ids from the catalog: the stored choice must survive
    // the refresh untouched, and both become reportable as unavailable.
    catalog.set([BETA])
    expect(catalog.selection()).toEqual(expect.arrayContaining(['alpha', 'retired-model']))
    expect(catalog.missingSelection()).toEqual(['alpha', 'retired-model'])
    // Neither is visible, because the catalog cannot serve them.
    expect(catalog.current()).toEqual([])
    expect(catalog.available().map(model => model.id)).toEqual(['beta'])

    // A refresh that restores a model clears it from the report without the
    // user having to re-select it.
    catalog.set([ALPHA, BETA])
    expect(catalog.missingSelection()).toEqual(['retired-model'])
    expect(catalog.current().map(model => model.id)).toEqual(['alpha'])
  })

  it('applies the selection on top of catalog visibility rather than replacing it', () => {
    const catalog = catalogOf()
    catalog.setSelection(['beta'])
    expect(catalog.current().map(model => model.id)).toEqual(['beta'])
    // A signed-out variant exposes nothing at all, whatever is selected.
    catalog.setVisible(false)
    expect(catalog.current()).toEqual([])
    expect(catalog.selection()).toEqual(['beta'])
  })

  /**
   * The schema must keep "never configured" distinguishable from "selected
   * nothing".
   *
   * This is the trap the feature is most likely to fall into: schemastery
   * materializes a plain `z.array()` field as `[]` when it is absent, which
   * would silently turn every existing user's absent selection into an empty
   * one and empty their model picker on upgrade. The field therefore uses a
   * `z.union([z.array(...), z.const(undefined)])` arm, and this test is what
   * stops a future simplification back to `z.array()` from going unnoticed.
   */
  it('keeps an absent selection distinct from an empty one through the schema', () => {
    const absent = WorkBuddyConfig({})
    expect(absent.selectedModels).toBeUndefined()
    expect(absent.selectedModelsAI).toBeUndefined()

    // An explicit empty array must survive as an empty array, not collapse to
    // `undefined` — that is the user's deliberate "show nothing".
    const cleared = WorkBuddyConfig({ selectedModels: [], selectedModelsAI: [] })
    expect(cleared.selectedModels).toEqual([])
    expect(cleared.selectedModelsAI).toEqual([])

    // And a real selection round-trips verbatim.
    const chosen = WorkBuddyConfig({ selectedModels: ['alpha', 'beta'] })
    expect(chosen.selectedModels).toEqual(['alpha', 'beta'])
  })

  /**
   * The routing surface must keep every model, *with* the projections the
   * picker list applies.
   *
   * `available()` feeds the provider's model collection, which
   * `dsh-llm-pi-ai` resolves ids against. It must therefore be unfiltered (or
   * unselected models become `UNKNOWN_MODEL`) but otherwise identical to
   * `current()` — dropping the context-window projection here silently changed
   * a resolved model's `contextWindow`.
   */
  it('keeps the routing surface unfiltered but still projected', () => {
    const catalog = new WorkBuddyCatalog([
      { ...ALPHA, supportedContextWindows: [1_000, 4_000] },
      BETA,
    ])
    catalog.setSelection(['alpha'])
    catalog.setUseMaximumContextWindow(true)

    // Unfiltered: both models remain routable although only one is selected.
    expect(catalog.available().map(model => model.id)).toEqual(['alpha', 'beta'])
    expect(catalog.current().map(model => model.id)).toEqual(['alpha'])

    // Projected: the maximum-window preference applies to the routing surface
    // too, so a resolved model reports the same window the picker advertises.
    expect(catalog.available().find(model => model.id === 'alpha')?.contextWindow).toBe(4_000)
    expect(catalog.current().find(model => model.id === 'alpha')?.contextWindow).toBe(4_000)
  })
})
