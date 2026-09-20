/** Node-free constants and types shared by the Host and browser halves. */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-workbuddy-connect/status'

/**
 * Plugin-owned probe control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore
 * also requires the in-process key the browser half receives with the status
 * document.
 */
export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-workbuddy-connect/probe'

/**
 * The international (WorkBuddy AI) variant's own pair of routes.
 *
 * Kept as separate constants rather than a computed suffix so both halves
 * reference literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the desk asking a route the host never mounted.
 */
export const WORKBUDDY_AI_STATUS_PATH = '/plugins/dsh-workbuddy-connect/ai/status'
export const WORKBUDDY_AI_PROBE_PATH = '/plugins/dsh-workbuddy-connect/ai/probe'

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface WorkBuddyProbeAction {
  /**
   * `probe` spends credit on one model; `clear` drops recorded observations;
   * `refresh` re-reads the credential and re-fetches the model catalog;
   * `set-maximum-context-window` persists the international card preference;
   * `set-selected-models` persists this variant's model selection.
   *
   * All five are writes, which is why they share this route's in-process key
   * and loopback guards rather than the read-only status GET.
   */
  action: 'probe' | 'clear' | 'refresh' | 'set-maximum-context-window' | 'set-selected-models'
  /** Target model id; required for `probe`. */
  model?: string
  /** Requested value for `set-maximum-context-window`. */
  enabled?: boolean
  /**
   * Requested model selection for `set-selected-models`.
   *
   * An array replaces the selection outright; `null` clears the field and
   * restores "no preference" (expose every model). The two are deliberately
   * distinct — an empty array means the user deselected everything.
   *
   * The variant comes from the route the request arrived on, so the browser
   * cannot retarget one variant's selection at the other.
   */
  selectedModels?: readonly string[] | null
}

/**
 * Where the models a card is currently showing came from.
 *
 * The plan requires the card to distinguish a live catalog from the built-in
 * fallback, and to say when the last attempt failed — otherwise a stale list is
 * indistinguishable from an offline one, and a user cannot tell whether the
 * models they see still match the upstream.
 */
export interface WorkBuddyWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale" and
   * "offline with a saved list" are different situations for the user.
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch ms. */
  fetchedAt?: number
  /** App version used as the catalog User-Agent, when the variant needed one. */
  appVersion?: string
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
  unlimited?: true
  cycleResetTime?: string
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /**
   * Credits multiplier in display form, e.g. `x0.79`. Unlike the model
   * picker's copy, the card renders through the browser locale, so this value
   * may be interpolated into a localized sentence rather than shown bare.
   */
  credits?: string
  /**
   * The rate cannot be stated right now, and the card must say so.
   *
   * Set for a row whose price came from a promotion that has since ended: the
   * upstream bakes the discounted value into the cached row, and the original
   * price is not recoverable from it, so neither the old figure nor `free` may
   * be repeated. The card renders "refresh to see the price" instead.
   */
  rateUnknown?: true
  /**
   * Context capacity in tokens, taken verbatim from the upstream
   * `maxAllowedSize`/`maxInputTokens`, or from the international document's
   * `contextWindow.defaultLength` when it declares one.
   *
   * The international card can opt into the largest declared alternative. The
   * selected value is what DSH receives as its actual context budget.
   */
  contextWindow?: number
  /** The upstream default, when the card currently uses a selected maximum. */
  defaultContextWindow?: number
  /**
   * The international document's larger selectable window, when it declares
   * one, and the model's maximum input ceiling.
   *
   * Kept apart from {@link contextWindow} because they answer different
   * questions: `contextWindow` is the budget the plugin actually requests under,
   * while these are facts about what the upstream will accept. Showing the 1M
   * ceiling as though it were the working window would overstate the budget.
   */
  maxContextWindow?: number
  maxInputTokens?: number
}

/** One selectable model, as the selection UI lists it. */
export interface WorkBuddyWebSelectableModel {
  id: string
  name: string
  /** Whether this model currently passes the user's selection. */
  selected: boolean
}

/**
 * The model-selection section of the status document.
 *
 * The UI needs three things and no more: what the catalog offers, what the user
 * chose, and which choices the catalog can no longer satisfy. The last one is
 * the reason this is an object rather than a bare id list — a model the
 * upstream retired must stay visible as "selected but unavailable" instead of
 * vanishing, or the user cannot tell an expired choice from one never made.
 */
export interface WorkBuddyWebModelSelection {
  /**
   * Every model the catalog currently offers, with its selected flag.
   *
   * `undefined` selection is reported as every row `selected: true`, because
   * that is what the picker actually shows; {@link unconfigured} keeps the
   * "never configured" state distinguishable for the UI's copy.
   */
  models: readonly WorkBuddyWebSelectableModel[]
  /** True while the user has never chosen, so every model is shown by default. */
  unconfigured: boolean
  /**
   * Previously selected ids the current catalog no longer offers.
   *
   * Reported rather than dropped: the stored selection is left untouched, so
   * the choice survives a temporary catalog gap (an offline start serving the
   * fallback roster) instead of being destroyed by it.
   */
  unavailable: readonly string[]
}

/** The JSON document the plugin card renders. */
export type WorkBuddyWebStatus =
  | {
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in" — today a credential belonging to the other product.
     * The card renders it in place of the generic sign-in hint.
     */
    reason?: string
  }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /** Billing convenience facts for the models the plugin serves. */
    models?: readonly WorkBuddyWebModelBadge[]
    /** Where those models came from, and whether the last fetch failed. */
    catalog?: WorkBuddyWebCatalog
    /** Reasoning-effort probe state, consent, and recorded observations. */
    probe?: WorkBuddyWebProbeSection
    /**
     * Model selection: what the catalog offers and what the user picked.
     *
     * Present on every signed-in document so the selection UI works without a
     * second round trip.
     */
    selection?: WorkBuddyWebModelSelection
    /** International-card preference selecting larger declared context windows. */
    useMaximumContextWindow?: boolean
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
  }
  | { status: 'error'; message: string }
