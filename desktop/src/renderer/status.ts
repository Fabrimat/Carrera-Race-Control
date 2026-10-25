// Loading / error page of the main window (desktop-owned, no network access).
;(() => {
  const dict = {
    en: {
      starting: ['Starting...', 'Starting the race server.'],
      error: ['The race server is not running', 'It stopped unexpectedly. Restarting automatically...'],
      failed: ['The race server could not be started', 'Check the logs folder (File menu).'],
    },
    it: {
      starting: ['Avvio in corso...', 'Avvio del server di gara.'],
      error: ['Il server di gara non è attivo', 'Si è fermato in modo imprevisto. Riavvio automatico...'],
      failed: ['Impossibile avviare il server di gara', 'Controlla la cartella dei log (menu File).'],
    },
  } as const
  const q = new URLSearchParams(location.search)
  const lang = q.get('lang') === 'it' ? 'it' : 'en'
  const state = (q.get('state') as 'starting' | 'error' | 'failed') ?? 'starting'
  const [title, text] = dict[lang][state] ?? dict[lang].starting
  document.documentElement.lang = lang
  document.documentElement.dataset.state = state
  document.title = title
  const h = document.getElementById('title')
  const p = document.getElementById('text')
  const d = document.getElementById('detail')
  if (h) h.textContent = title
  if (p) p.textContent = text
  if (d) d.textContent = q.get('detail') ?? ''
})()
