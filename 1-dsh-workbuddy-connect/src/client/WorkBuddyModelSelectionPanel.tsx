/**
 * Model selection panel: choose which WorkBuddy models DSH's model selector
 * offers.
 *
 * The plugin registers every catalog model with the Harness, and this panel is
 * what narrows that to the ones a user actually wants in the picker. It is
 * deliberately its own component rather than a section of the status card: the
 * selection is a list-management task (search, filter, bulk toggle) whose state
 * is mostly local, while the card is a status readout.
 *
 * Three facts drive the interaction, and each has a visible consequence:
 *
 * 1. **Unset is not empty.** An unconfigured plugin shows everything, so the
 *    header says "all models" instead of a count of zero, and the reset action
 *    is labelled as returning to that state rather than selecting none.
 * 2. **Deselecting only hides.** A deselected model stays routable, so a saved
 *    session naming one keeps working. The copy says "hidden from the picker"
 *    rather than implying the model is gone.
 * 3. **A selection can outlive its models.** If the upstream retires a chosen
 *    model, the id stays in the stored selection and is reported separately, so
 *    the user can see the choice was kept rather than silently dropped.
 *
 * @module dsh-workbuddy-connect/client/model-selection-panel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { WorkBuddyWebModelSelection, WorkBuddyWebStatus } from '../status-paths.ts'
import { isWorkBuddyWebStatus } from './status-document.ts'
import type { WorkBuddyCardVariant, WorkBuddyPluginCardInjected } from './WorkBuddyPluginCard.tsx'

/** Injected props: the variant whose routes and selection this panel owns. */
export interface WorkBuddyModelSelectionPanelProps extends WorkBuddyPluginCardInjected {
  variant: WorkBuddyCardVariant
}

/** How often the panel re-reads status while it is open. */
const POLL_INTERVAL_MS = 60_000

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const summaryStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
}

const summaryTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const summaryHintStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const toolbarStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  flexWrap: 'wrap',
}

const searchStyle: CSSProperties = {
  flex: '1 1 180px',
  minWidth: 140,
  boxSizing: 'border-box',
  minHeight: 32,
  padding: '5px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
}

const buttonStyle: CSSProperties = {
  boxSizing: 'border-box',
  minHeight: 32,
  padding: '5px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}

const listStyle: CSSProperties = {
  maxHeight: 340,
  overflowY: 'auto',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  padding: '4px 0',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 12px',
  cursor: 'pointer',
}

const rowNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13.5,
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const rowIdStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
}

const noticeStyle: CSSProperties = {
  margin: 0,
  padding: '9px 12px',
  borderRadius: 8,
  fontSize: 12.5,
  lineHeight: '18px',
  background: 'var(--dsw-alias-state-warning-subtle, rgba(214, 158, 46, 0.12))',
  color: 'var(--dsw-alias-state-warning-primary, #b7791f)',
}

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--dsw-alias-state-error-primary)',
}

const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary)',
}

/** Read the status document for this variant. */
async function readStatus(path: string): Promise<WorkBuddyWebStatus | undefined> {
  try {
    const response = await fetch(path, { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const parsed: unknown = await response.json()
    return isWorkBuddyWebStatus(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Choose which catalog models the Harness model selector offers.
 *
 * @param props - the variant to manage plus its localized copy.
 * @returns the selection panel.
 */
export function WorkBuddyModelSelectionPanel(props: WorkBuddyModelSelectionPanelProps): React.ReactNode {
  const { variant, t } = props
  const [status, setStatus] = useState<WorkBuddyWebStatus | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await readStatus(variant.statusPath))
  }, [variant.statusPath])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  const selection = status?.status === 'signed-in' ? status.selection : undefined
  const key = status?.status === 'signed-in' ? status.probeKey : undefined

  /**
   * Persist a selection.
   *
   * `models === undefined` clears the field, restoring "no preference" (every
   * model is offered). An empty array is sent as `[]` and means the user
   * deliberately wants nothing shown; the two must not be conflated.
   */
  const write = useCallback(async (models: readonly string[] | undefined): Promise<void> => {
    if (key === undefined) {
      setError(t('selectionNoKey'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch(variant.probePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': key },
        body: JSON.stringify({ action: 'set-selected-models', selectedModels: models ?? null }),
      })
      if (!response.ok) {
        setError(`${t('selectionWriteFailed')} (${response.status})`)
        return
      }
      // The host applies the change and invalidates its adapter, so a re-read
      // reflects what DSH will actually serve rather than what we hoped.
      await refresh()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [key, refresh, t, variant.probePath])

  const models = selection?.models ?? []
  const selectedIds = useMemo(
    () => new Set(models.filter(model => model.selected).map(model => model.id)),
    [models],
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return models
    return models.filter(model =>
      model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))
  }, [models, query])

  const toggle = useCallback((id: string, on: boolean): void => {
    const next = new Set(selectedIds)
    if (on) next.add(id)
    else next.delete(id)
    // Materialize the current effective set on the first edit: while the field
    // is unset the picker shows every model, so the user's first click means
    // "everything except this one".
    void write([...next])
  }, [selectedIds, write])

  if (status === undefined) {
    return <p style={bodyStyle}>{t('selectionLoading')}</p>
  }
  if (status.status !== 'signed-in') {
    return <p style={bodyStyle}>{t('selectionSignedOut')}</p>
  }
  if (selection === undefined) {
    return <p style={bodyStyle}>{t('selectionUnavailable')}</p>
  }

  const heading = selection.unconfigured
    ? t('selectionAll', { count: String(models.length) })
    : t('selectionCount', { selected: String(selectedIds.size), total: String(models.length) })

  return (
    <div style={panelStyle}>
      <div style={summaryStyle}>
        <div>
          <p style={summaryTextStyle}>{heading}</p>
          <p style={summaryHintStyle}>
            {selection.unconfigured ? t('selectionUnconfiguredHint') : t('selectionHint')}
          </p>
        </div>
        <div style={toolbarStyle}>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={() => { void write(models.map(model => model.id)) }}
          >
            {t('selectionSelectAll')}
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy}
            onClick={() => { void write([]) }}
          >
            {t('selectionSelectNone')}
          </button>
          {/* Clearing the field is a distinct action from selecting none: it
              returns the plugin to "no preference" rather than "show nothing". */}
          <button
            type="button"
            style={buttonStyle}
            disabled={busy || selection.unconfigured}
            onClick={() => { void write(undefined) }}
          >
            {t('selectionReset')}
          </button>
        </div>
      </div>

      {selection.unavailable.length > 0 && (
        <p style={noticeStyle}>
          {t('selectionUnavailableModels', { models: selection.unavailable.join('、') })}
        </p>
      )}

      <div style={toolbarStyle}>
        <input
          style={searchStyle}
          value={query}
          placeholder={t('selectionSearchPlaceholder')}
          onChange={event => { setQuery(event.target.value) }}
        />
      </div>

      <div style={listStyle}>
        {filtered.length === 0 && <p style={{ ...bodyStyle, padding: '6px 12px' }}>{t('selectionNoMatch')}</p>}
        {filtered.map(model => (
          <label key={model.id} style={rowStyle}>
            <input
              type="checkbox"
              checked={model.selected}
              disabled={busy}
              onChange={event => { toggle(model.id, event.target.checked) }}
            />
            <span style={rowNameStyle}>{model.name}</span>
            <span style={rowIdStyle}>{model.id}</span>
          </label>
        ))}
      </div>

      {error !== undefined && <p style={errorStyle}>{error}</p>}
    </div>
  )
}
