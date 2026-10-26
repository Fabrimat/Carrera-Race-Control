import { useEffect } from 'react'
import { runShortcutAction } from './shortcutActions'
import { actionById, comboFromEvent, comboMap, effectiveBindings } from './shortcuts'
import { useStore } from './store'

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
/** Space / Enter on these belong to the element itself (it activates on that key). */
const ACTIVATES = 'button, a[href], [role="button"], summary'
/** Open modals block shortcuts; the shortcut help overlay (`data-shortcut-help`) does not. */
const MODAL = '[role="dialog"][aria-modal="true"]:not([data-shortcut-help]), [role="alertdialog"]'

function isTyping(el: Element | null): boolean {
  if (!el) return false
  if (TEXT_TAGS.has(el.tagName)) return true
  if ((el as HTMLElement).isContentEditable) return true
  const editable = el.closest('[contenteditable]')
  return editable !== null && editable.getAttribute('contenteditable') !== 'false'
}

/**
 * The one global key handler. Returns true when the key was handled (and `preventDefault` was
 * called). Ignored: events another handler already consumed, typing in fields, open modals,
 * recording a new combo, and Space / Enter on a focused button or link.
 */
export function handleShortcutKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false
  const target = e.target instanceof Element ? e.target : null
  if (isTyping(target) || isTyping(document.activeElement)) return false
  if (document.querySelector(MODAL) || document.querySelector('[data-shortcut-recording]')) return false

  const combo = comboFromEvent(e)
  if (!combo) return false
  const id = comboMap(effectiveBindings(useStore.getState().settings?.shortcuts)).get(combo)
  if (!id) return false
  if ((combo.endsWith('Space') || combo.endsWith('Enter')) && target?.closest(ACTIVATES)) return false

  e.preventDefault()
  if (e.repeat && !actionById(id)?.repeatable) return true
  void runShortcutAction(id)
  return true
}

/** Install the global shortcut listener (once, from App). */
export function useShortcuts(): void {
  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [])
}
