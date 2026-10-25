// Configuration window logic (desktop-owned page). Stored secrets are never sent here: for
// secrets only a "configured" flag arrives, and only what the user types travels to the main
// process, which validates and encrypts it. The form is generated from the schema payload.
;(() => {
  interface Field {
    env: string
    type: 'secret' | 'text' | 'enum' | 'int' | 'float' | 'list' | 'path'
    label: string
    help: string
    default: string
    enumValues?: string[]
    configured: boolean
    value?: string
  }
  interface State {
    lang: 'en' | 'it'
    encryptionAvailable: boolean
    dataDir: string
    strings: Record<string, string>
    groups: Array<{ id: string; title: string; fields: Field[] }>
  }
  interface SaveResult {
    ok: boolean
    error?: string
    errors?: Array<{ env: string; message: string }>
  }
  interface ConfigApi {
    load(): Promise<State | null>
    save(req: { values: Record<string, string>; secrets: Record<string, string>; clear: string[] }): Promise<SaveResult>
    close(): Promise<void>
    openDataFolder(): Promise<void>
    importEnv(): Promise<{ ok: boolean; canceled?: boolean; imported?: number; skipped?: string[]; error?: string }>
    onRestartState(cb: (state: 'restarting' | 'ready' | 'failed') => void): void
  }
  const api = (window as unknown as { configApi: ConfigApi }).configApi

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const form = $<HTMLFormElement>('form')
  const message = $<HTMLElement>('message')
  const saveBtn = $<HTMLButtonElement>('save')
  const importBtn = $<HTMLButtonElement>('import')
  const cancelBtn = $<HTMLButtonElement>('cancel')
  let strings: Record<string, string> = {}
  let busy = false
  let reloadOnReady = false

  const setMessage = (text: string, cls: '' | 'ok' | 'error') => {
    message.textContent = text
    message.className = cls
  }
  const setBusy = (value: boolean) => {
    busy = value
    form.querySelectorAll<HTMLElement>('input, select, button').forEach((el) => {
      ;(el as HTMLInputElement).disabled = value
    })
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  void api.load().then((state) => {
    if (!state) return
    strings = state.strings
    const s = strings
    document.documentElement.lang = state.lang
    document.title = s.configTitle
    $('heading').textContent = s.configTitle
    $('intro').textContent = s.configIntro
    saveBtn.textContent = s.configSave
    cancelBtn.textContent = s.configCancel
    importBtn.textContent = s.configImport
    if (!state.encryptionAvailable) setMessage(s.configUnavailable, 'error')

    const groups = $('groups')
    const clearIds = new Set<string>()
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
    const errorBoxes = new Map<string, HTMLElement>()
    const fieldsByEnv = new Map<string, Field>()

    for (const g of state.groups) {
      const set = el('fieldset')
      set.append(el('legend', '', g.title))
      for (const f of g.fields) {
        fieldsByEnv.set(f.env, f)
        const row = el('div', 'row')
        const label = el('label', '', f.label)
        label.htmlFor = `f-${f.env}`
        const defText = f.default || s.configDefaultNone

        let input: HTMLInputElement | HTMLSelectElement
        if (f.type === 'enum') {
          const sel = el('select')
          const none = el('option', '', `${s.configDefault}: ${defText}`)
          none.value = ''
          sel.append(none)
          for (const v of f.enumValues ?? []) {
            const o = el('option', '', v)
            o.value = v
            sel.append(o)
          }
          sel.value = f.value ?? ''
          input = sel
        } else {
          const inp = el('input')
          inp.autocomplete = 'off'
          inp.spellcheck = false
          if (f.type === 'secret') {
            inp.type = 'password'
            inp.placeholder = f.configured ? s.configReplace : ''
          } else {
            inp.type = 'text'
            inp.value = f.value ?? ''
            inp.placeholder = `${s.configDefault}: ${defText}`
          }
          input = inp
        }
        input.id = `f-${f.env}`
        input.name = f.env
        inputs.set(f.env, input)

        const meta = el('div', 'meta')
        if (f.type === 'secret') {
          const status = el('span', f.configured ? 'ok' : 'unset', f.configured ? s.configSecretSet : s.configSecretUnset)
          meta.append(status)
          if (f.configured) {
            const clear = el('button', 'link', s.configClear)
            clear.type = 'button'
            clear.addEventListener('click', () => {
              clearIds.add(f.env)
              status.textContent = s.configSecretUnset
              status.className = 'unset'
              ;(input as HTMLInputElement).value = ''
              ;(input as HTMLInputElement).placeholder = ''
              clear.remove()
            })
            meta.append(clear)
          }
        } else {
          const reset = el('button', 'link', s.configReset)
          reset.type = 'button'
          reset.addEventListener('click', () => {
            input.value = ''
            input.classList.remove('invalid')
          })
          meta.append(reset)
        }
        const help = el('div', 'help', f.help)
        const err = el('div', 'field-error')
        errorBoxes.set(f.env, err)
        row.append(label, input, meta, help, err)
        set.append(row)
      }
      groups.append(set)
    }

    // Managed data folder (read-only)
    const dataSet = el('fieldset')
    dataSet.append(el('legend', '', s.configDataDir))
    const dataRow = el('div', 'row inline')
    const path = el('code', '', state.dataDir)
    path.style.flex = '1'
    const open = el('button', '', s.configOpenFolder)
    open.type = 'button'
    open.addEventListener('click', () => void api.openDataFolder())
    dataRow.append(path, open)
    dataSet.append(dataRow, el('div', 'help', s.configDataDirHelp))
    groups.append(dataSet)

    const clearErrors = () => {
      errorBoxes.forEach((b) => (b.textContent = ''))
      inputs.forEach((i) => i.classList.remove('invalid'))
    }

    api.onRestartState((st) => {
      if (st === 'restarting') {
        setBusy(true)
        setMessage(s.configRestarting, '')
      } else if (st === 'ready' && busy) {
        if (reloadOnReady) return location.reload() // show the imported values
        setBusy(false)
        setMessage(s.configRestarted, 'ok')
      } else if (st === 'failed' && busy) {
        setBusy(false)
        setMessage(s.configRestartFailed, 'error')
      }
    })

    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      clearErrors()
      const values: Record<string, string> = {}
      const secrets: Record<string, string> = {}
      for (const [env, input] of inputs) {
        const f = fieldsByEnv.get(env)
        if (!f) continue
        if (f.type === 'secret') {
          if (input.value.trim()) secrets[env] = input.value
        } else values[env] = input.value
      }
      void api.save({ values, secrets, clear: [...clearIds] }).then((res) => {
        if (res.ok) {
          // Do not keep typed secrets in the DOM.
          for (const [env, input] of inputs) if (fieldsByEnv.get(env)?.type === 'secret') input.value = ''
          setBusy(true)
          setMessage(s.configRestarting, '')
        } else if (res.error === 'invalid') {
          for (const e of res.errors ?? []) {
            const box = errorBoxes.get(e.env)
            if (box) box.textContent = e.message
            inputs.get(e.env)?.classList.add('invalid')
          }
          setMessage(s.configInvalid, 'error')
        } else if (res.error === 'encryption_unavailable') setMessage(s.configUnavailable, 'error')
        else setMessage(s.configWriteFailed, 'error')
      })
    })

    importBtn.addEventListener('click', () => {
      void api.importEnv().then((res) => {
        if (res.canceled) return
        if (!res.ok) return setMessage(res.error ?? s.importFailed, 'error')
        const parts = [res.imported ? s.importDone.replace('{n}', String(res.imported)) : s.importNone]
        if (res.skipped?.length) parts.push(s.importSkipped.replace('{list}', res.skipped.join(', ')))
        setMessage(parts.join(' '), res.imported ? 'ok' : '')
        if (res.imported) {
          setBusy(true) // the main process restarts the backend; the page reloads when it is up
          reloadOnReady = true
        }
      })
    })
    cancelBtn.addEventListener('click', () => void api.close())
  })
})()
