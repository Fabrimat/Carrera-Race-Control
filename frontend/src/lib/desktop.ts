// `window.carreraDesktop` is typed in src/carrera-desktop.d.ts (copied from desktop/types).

function openBrowserTv(): void {
  window.open('#/tv', 'carrera-tv')
}

/**
 * Open the TV view: a native second window in the desktop app, a named browser window otherwise
 * (also when the desktop shell refuses or fails).
 */
export function openTvWindow(): void {
  const desktop = window.carreraDesktop
  if (!desktop?.isDesktop) {
    openBrowserTv()
    return
  }
  try {
    desktop.openTvWindow().then(
      (res) => {
        if (!res?.ok) openBrowserTv()
      },
      openBrowserTv,
    )
  } catch {
    openBrowserTv()
  }
}
