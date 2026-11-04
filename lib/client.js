// whale-purse 客户端半：把「余额 / 花费 / 峰谷」接到 whale-girl 桌宠身上。
//
// 交互（v0.2）：
//   · 菜单里多一个「💰 钱包」按钮（和 🍗 喂食 / 🎾 玩耍 / 🎭 更换 同一排）；
//   · 按它才浮出铭牌（¥余额 · 今花费 · 峰/谷），再点铭牌展开明细卡；
//   · 每跑完一步（一次模型回合里的一次响应），宠物上方自动浮现「+ ¥0.0xx」这一步的消耗。
//
// 集成方式：铭牌/卡片/浮字都插进 whale-girl 自己的宿主节点（[data-whale-girl]），
// 所以跟着宠物拖动、跟着宠物隐藏；气泡提醒走 whale-girl 公开的 `whale-girl:say` 事件。
// whale-girl 缺席时降级成右下角的小按钮。数据全部来自宿主半 /whale-purse/*，本文件不接触密钥。
window.__ModuleLoader__.load({
  id: 'whale-purse',
  factory: () => {
    var module = { exports: {} }

    const STATE_PATH = '/whale-purse/state'
    const CONFIG_PATH = '/whale-purse/config'
    const REFRESH_PATH = '/whale-purse/refresh'
    const PET_SELECTOR = '[data-whale-girl]'
    const MENU_SELECTOR = '.pet-menu'
    const BTN_ATTR = 'data-whale-purse-btn'
    const MOUNT_ATTR = 'data-whale-purse'
    const HINT_LS_KEY = 'whale-purse:hints'

    const COLOR = {
      text: '#E8EBF2',
      muted: '#9AA4B6',
      dim: 'rgba(232,235,242,.55)',
      peak: '#FFB27A',
      valley: '#71D8A6',
      danger: '#FF8A8A',
      bg: 'rgba(24, 28, 38, .93)',
      bgSolid: 'rgba(20, 24, 33, .97)',
      border: 'rgba(255,255,255,.10)',
      divider: 'rgba(255,255,255,.07)',
      pill: 'rgba(255,255,255,.10)',
      shadow: '0 12px 32px rgba(0,0,0,.38), 0 3px 8px rgba(0,0,0,.28)',
    }
    const FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
    const RADIUS = '9px'
    // 与 whale-girl 菜单按钮同一套内联样式（宿主可能清理 CSS 注入，内联最稳）
    const BTN_CSS = 'flex:1; border:0; border-radius:6px; padding:4px 8px; font-size:11px; cursor:pointer; background:rgba(255,255,255,.14); color:#E8EBF2; font-family:system-ui,sans-serif;'

    // ---- 小工具 -----------------------------------------------------------------
    const h = (tag, css, text) => {
      const el = document.createElement(tag)
      if (css) el.style.cssText = css
      if (text !== undefined && text !== null) el.textContent = text
      return el
    }
    const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v))
    const money = (v, digits = 2) => (isNum(v) ? `¥${Number(v).toFixed(digits)}` : '¥—')
    // 小额保留更多位，免得每一步都显示 ¥0.00
    const tinyMoney = (v) => {
      if (!isNum(v)) return '¥—'
      const n = Number(v)
      if (n !== 0 && Math.abs(n) < 0.01) return `¥${n.toFixed(4)}`
      if (n !== 0 && Math.abs(n) < 0.1) return `¥${n.toFixed(3)}`
      return `¥${n.toFixed(2)}`
    }
    const clockOf = (ms) => {
      if (!isNum(ms)) return ''
      const d = new Date(Number(ms))
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
    const remainText = (ms) => {
      const total = Math.max(0, Math.round(Number(ms) / 1000))
      const hh = Math.floor(total / 3600)
      const mm = Math.floor((total % 3600) / 60)
      const ss = total % 60
      if (hh > 0) return `${hh} 小时 ${String(mm).padStart(2, '0')} 分`
      if (mm > 0) return `${mm} 分 ${String(ss).padStart(2, '0')} 秒`
      return `${ss} 秒`
    }
    const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const readHints = () => {
      try {
        const raw = JSON.parse(localStorage.getItem(HINT_LS_KEY) ?? 'null')
        if (raw && typeof raw === 'object') return raw
      } catch { /* 隐私模式：忽略 */ }
      return {}
    }
    const writeHints = (value) => {
      try { localStorage.setItem(HINT_LS_KEY, JSON.stringify(value)) } catch { /* 忽略 */ }
    }

    function apply() {
      if (document.querySelector(`[${MOUNT_ATTR}]`) !== null) {
        console.warn('[whale-purse] 已存在实例，跳过重复挂载')
        return () => {}
      }
      if (!document.body) return () => {}

      let snapshot = null
      let lastError = null
      let hints = readHints()
      let stripOpen = false     // 铭牌（按需浮出）
      let cardOpen = false      // 明细卡
      let settingsOpen = false
      let pollTimer = null
      let pollMs = 4000
      let toastTimer = null
      let followRaf = 0
      let eventSource = null
      let disposed = false
      let anchor = null

      const standalone = h('div', 'position: fixed; right: 16px; bottom: 16px; width: 0; height: 0; z-index: 2147483000; pointer-events: none;')
      standalone.setAttribute(MOUNT_ATTR, '')
      document.body.appendChild(standalone)
      anchor = standalone

      // ---- 铭牌（小条）----
      const strip = h('div', [
        'position: absolute; left: 0; top: -46px;',
        `background: ${COLOR.bg}; border: 1px solid ${COLOR.border}; border-radius: ${RADIUS};`,
        `box-shadow: ${COLOR.shadow}; backdrop-filter: blur(10px) saturate(1.15);`,
        `padding: 4px 9px; color: ${COLOR.text}; font: 11px ${FONT};`,
        'display: none; align-items: center; gap: 7px; white-space: nowrap;',
        'pointer-events: auto; cursor: pointer; user-select: none; z-index: 2147483001;',
      ].join(' '))
      strip.setAttribute('data-whale-purse-strip', '')
      strip.title = '点击看明细'
      const balText = h('span', `font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums;`, '¥—')
      const sep = h('span', `color: ${COLOR.dim};`, '·')
      const todayText = h('span', `font-size: 10.5px; font-variant-numeric: tabular-nums; color: ${COLOR.muted};`, '今 ¥0.00')
      const phasePill = h('span', [
        'font-size: 9.5px; font-weight: 600; line-height: 15px; padding: 0 5px; border-radius: 5px;',
        `background: ${COLOR.pill}; color: ${COLOR.valley};`,
      ].join(' '), '谷')
      const chevron = h('span', `color: ${COLOR.dim}; font-size: 9px;`, '▾')
      strip.append(balText, sep, todayText, phasePill, chevron)

      // ---- 明细卡 ----
      const card = h('div', [
        'position: absolute; left: 0; top: -240px; width: 238px;',
        `background: ${COLOR.bgSolid}; border: 1px solid ${COLOR.border}; border-radius: 12px;`,
        `box-shadow: ${COLOR.shadow}; backdrop-filter: blur(14px) saturate(1.2);`,
        `color: ${COLOR.text}; font: 11px ${FONT}; padding: 9px 10px 8px;`,
        'display: none; flex-direction: column; gap: 6px; pointer-events: auto;',
        'cursor: default; z-index: 2147483002; max-height: 60vh; overflow: auto;',
      ].join(' '))
      card.setAttribute('data-whale-purse-card', '')

      const head = h('div', 'display:flex; align-items:center; justify-content:space-between; gap:6px;')
      const title = h('div', 'display:flex; align-items:center; gap:5px; font-weight:650; font-size:12px;', '🐳 鲸鱼钱包')
      const headBtns = h('div', 'display:flex; align-items:center; gap:4px;')
      const smallBtn = `border:0; border-radius:5px; padding:2px 6px; font-size:10px; cursor:pointer; background:${COLOR.pill}; color:${COLOR.text}; font-family:${FONT};`
      const gearBtn = h('button', smallBtn, '⚙')
      const refreshBtn = h('button', smallBtn, '刷新')
      const closeBtn = h('button', smallBtn, '✕')
      headBtns.append(gearBtn, refreshBtn, closeBtn)
      head.append(title, headBtns)

      const rowCss = 'display: flex; align-items: baseline; justify-content: space-between; gap: 8px;'
      const labelCss = `color: ${COLOR.muted}; font-size: 11px;`
      const valueCss = 'font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600;'
      const subCss = `color: ${COLOR.dim}; font-size: 10px; line-height: 1.4;`
      const makeRow = (label) => {
        const wrap = h('div', 'display:flex; flex-direction:column; gap:1px;')
        const line = h('div', rowCss)
        const name = h('span', labelCss, label)
        const value = h('span', valueCss, '—')
        line.append(name, value)
        const sub = h('div', subCss, '')
        wrap.append(line, sub)
        return { wrap, value, sub }
      }
      const rows = {
        balance: makeRow('余额'),
        today: makeRow('今日已用'),
        turn: makeRow('本轮花费'),
        step: makeRow('上一步'),
        peak: makeRow('峰谷'),
      }

      const budgetWrap = h('div', 'display:none; flex-direction:column; gap:3px;')
      const budgetLine = h('div', rowCss)
      const budgetLabel = h('span', labelCss, '今日预算')
      const budgetValue = h('span', valueCss, '—')
      const budgetBarOuter = h('div', 'height:4px; border-radius:3px; background:rgba(255,255,255,.10); overflow:hidden;')
      const budgetBarInner = h('div', 'height:100%; width:0%; border-radius:3px; background:#71D8A6; transition: width .3s ease-out;')
      budgetBarOuter.appendChild(budgetBarInner)
      budgetLine.append(budgetLabel, budgetValue)
      budgetWrap.append(budgetLine, budgetBarOuter)

      const historyWrap = h('div', 'display:flex; align-items:flex-end; gap:3px; height:26px; padding-top:2px;')
      const footer = h('div', `color: ${COLOR.dim}; font-size: 9.5px; line-height: 1.4; margin-top: 1px;`, '余额 25 秒缓存 · 花费按余额观测差记账')

      // 设置区
      const settings = h('div', [
        'display: none; flex-direction: column; gap: 6px; padding-top: 6px;',
        `border-top: 1px solid ${COLOR.divider};`,
      ].join(' '))
      const inputCss = `width: 62px; border: 1px solid rgba(255,255,255,.14); border-radius: 5px; background: rgba(255,255,255,.06); color: ${COLOR.text}; font: 11px ${FONT}; padding: 2px 5px; text-align: right;`
      const makeField = (label, field, step = 1) => {
        const line = h('div', rowCss)
        const input = h('input', inputCss)
        input.type = 'number'
        input.step = String(step)
        input.min = '0'
        input.setAttribute('data-field', field)
        line.append(h('span', labelCss, label), input)
        settings.appendChild(line)
        return input
      }
      const lowInput = makeField('余额预警（元，0=关）', 'lowBalance', 1)
      const budgetInput = makeField('今日预算（元，0=不设）', 'dailyBudget', 1)
      const turnSayInput = makeField('单轮超过（元）就开口', 'turnSayAbove', 0.01)
      const makeToggle = (label, field) => {
        const line = h('div', rowCss)
        const btn = h('button', `${smallBtn} min-width: 42px;`, '开')
        btn.setAttribute('data-toggle', field)
        line.append(h('span', labelCss, label), btn)
        settings.appendChild(line)
        return btn
      }
      const lowToggle = makeToggle('余额提醒', 'notifyLowBalance')
      const peakToggle = makeToggle('峰谷提醒', 'notifyPeak')
      const stepToggle = makeToggle('每步浮现花费', 'stepToast')

      card.append(head, rows.balance.wrap, rows.today.wrap, rows.turn.wrap, rows.step.wrap, rows.peak.wrap,
        budgetWrap, historyWrap, settings, footer)

      // ---- 每步浮现的浮字 ----
      const toast = h('div', [
        'position: absolute; left: 0; top: -40px;',
        `background: rgba(24,28,38,.92); border: 1px solid ${COLOR.border}; border-radius: 999px;`,
        'padding: 2px 8px; color: #FFD9A8; font: 11px ' + FONT + '; font-weight: 600;',
        'white-space: nowrap; pointer-events: none; display: none; z-index: 2147483003;',
        'box-shadow: 0 6px 18px rgba(0,0,0,.35); opacity: 0;',
      ].join(' '))
      toast.setAttribute('data-whale-purse-toast', '')

      // ---- 挂载到宠物 ----
      const petRoot = () => document.querySelector(PET_SELECTOR)
      const mountInto = (root) => {
        if (root === anchor) return
        anchor = root
        for (const el of [strip, card, toast]) root.appendChild(el)
      }
      mountInto(petRoot() ?? standalone)

      // ---- 定位（相对宠物：默认贴上方，顶上放不下就翻到下方；横向收敛进视口）----
      const anchorPanel = (el, { gap = 8, extraAbove = 0 } = {}) => {
        const host = anchor === standalone
          ? { left: window.innerWidth - 16, top: window.innerHeight - 16, width: 0, height: 0 }
          : anchor.getBoundingClientRect()
        const w = el.offsetWidth || 180
        const hh = el.offsetHeight || 40
        const vw = window.innerWidth
        const centerX = host.left + host.width / 2
        const left = Math.min(Math.max(8, centerX - w / 2), Math.max(8, vw - w - 8))
        el.style.left = `${Math.round(left - host.left)}px`
        el.style.right = 'auto'
        el.style.transform = 'none'
        const up = host.top >= hh + gap + extraAbove + 6
        el.style.top = up
          ? `${Math.round(-hh - gap - extraAbove)}px`
          : `${Math.round(host.height + gap)}px`
        el.style.bottom = 'auto'
        return up
      }

      const placeAll = () => {
        if (strip.style.display !== 'none') anchorPanel(strip, { gap: 10 })
        const aboveStrip = strip.style.display !== 'none' ? (strip.offsetHeight || 22) + 6 : 0
        if (card.style.display !== 'none') anchorPanel(card, { gap: 10, extraAbove: aboveStrip })
        if (toast.style.display !== 'none') anchorPanel(toast, { gap: 8, extraAbove: aboveStrip })
      }

      const startFollow = () => {
        if (followRaf) return
        let lastKey = ''
        const tick = () => {
          followRaf = 0
          if (disposed) return
          const visible = strip.style.display !== 'none'
            || card.style.display !== 'none' || toast.style.display !== 'none'
          if (!visible) return
          // 只有宠物真的动了才重排（拖拽/窗口变化），避免每帧都强制布局
          const rect = anchor === standalone ? null : anchor.getBoundingClientRect()
          const key = rect === null ? 'standalone' : `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}`
          if (key !== lastKey) {
            lastKey = key
            placeAll()
          }
          followRaf = requestAnimationFrame(tick)
        }
        followRaf = requestAnimationFrame(tick)
      }

      // ---- 开关 ----
      const enabled = () => (snapshot?.config ?? {}).enabled !== false
      const showStrip = () => {
        if (!enabled() || !snapshot) return
        stripOpen = true
        strip.style.display = 'flex'
        placeAll()
        startFollow()
      }
      const hideStrip = () => {
        stripOpen = false
        strip.style.display = 'none'
        hideCard()
      }
      const toggleStrip = () => { stripOpen ? hideStrip() : showStrip() }
      const showCard = () => {
        if (!enabled() || !snapshot) return
        showStrip()
        cardOpen = true
        card.style.display = 'flex'
        render()
        placeAll()
        startFollow()
      }
      const hideCard = () => {
        cardOpen = false
        card.style.display = 'none'
      }

      // ---- 渲染 ----
      const config = () => snapshot?.config ?? {}
      const renderSettings = () => {
        const cfg = config()
        lowInput.value = String(cfg.lowBalance ?? 0)
        budgetInput.value = String(cfg.dailyBudget ?? 0)
        turnSayInput.value = String(cfg.turnSayAbove ?? 0)
        const toggle = (btn, on) => {
          btn.textContent = on ? '开' : '关'
          btn.style.color = on ? COLOR.valley : COLOR.dim
        }
        toggle(lowToggle, cfg.notifyLowBalance !== false)
        toggle(peakToggle, cfg.notifyPeak !== false)
        toggle(stepToggle, cfg.stepToast !== false)
        settings.style.display = settingsOpen ? 'flex' : 'none'
        gearBtn.style.color = settingsOpen ? COLOR.text : COLOR.dim
      }

      const render = () => {
        const cfg = config()
        if (!enabled()) {
          strip.style.display = 'none'
          card.style.display = 'none'
          toast.style.display = 'none'
          return
        }
        const permanent = cfg.showPlate === true
        strip.style.display = (permanent || (stripOpen && snapshot)) ? 'flex' : 'none'
        card.style.display = (cardOpen && snapshot) ? 'flex' : 'none'
        strip.style.fontSize = `${11 * (cfg.scale ?? 1)}px`

        const balance = snapshot?.balance ?? null
        const total = balance && !balance.error ? balance.total : null
        balText.textContent = total === null ? '¥—' : money(total)
        todayText.textContent = `今 ${tinyMoney(snapshot?.today?.amount ?? 0)}`

        const phase = snapshot?.peak
        const isPeak = phase?.peak === true
        phasePill.textContent = isPeak ? '峰 ×2' : '谷'
        phasePill.style.color = isPeak ? COLOR.peak : COLOR.valley
        phasePill.style.background = isPeak ? 'rgba(255,178,122,.16)' : 'rgba(113,216,166,.16)'

        // 余额
        rows.balance.value.textContent = total === null ? '—' : money(total)
        const lowHit = isNum(total) && isNum(cfg.lowBalance) && cfg.lowBalance > 0 && total < cfg.lowBalance
        rows.balance.value.style.color = lowHit ? COLOR.danger : COLOR.text
        if (balance && !balance.error) {
          const parts = []
          if (isNum(balance.recharge)) parts.push(`充 ${money(balance.recharge)}`)
          if (isNum(balance.bonus)) parts.push(`赠 ${money(balance.bonus)}`)
          parts.push(balance.source === 'account' ? '账号登录态' : 'API key')
          parts.push(`${Math.max(0, Math.round((balance.ageMs ?? 0) / 1000))} 秒前`)
          rows.balance.sub.textContent = parts.join(' · ')
        } else {
          rows.balance.sub.textContent = snapshot?.balanceError || lastError || '未取到余额（点「刷新」重试）'
        }

        // 今日已用
        const today = snapshot?.today
        rows.today.value.textContent = today ? tinyMoney(today.amount) : '—'
        if (today) {
          const bits = [today.label]
          if (today.partialDay && today.observedFromMs) bits.push(`${clockOf(today.observedFromMs)} 起观测`)
          else if (today.observedFromMs) bits.push(`${clockOf(today.observedFromMs)}–${clockOf(today.observedToMs)}`)
          if (today.source === 'events') bits.push('按 token 估算')
          rows.today.sub.textContent = bits.join(' · ')
        }

        // 本轮 / 上一步
        const turn = snapshot?.turn
        if (turn && turn.cost > 0) {
          rows.turn.value.textContent = tinyMoney(turn.cost)
          rows.turn.sub.textContent = [turn.tokens ? `${(turn.tokens / 1000).toFixed(1)}k tokens` : '',
            turn.model, turn.peak ? '峰价' : '谷价', clockOf(turn.ts)].filter(Boolean).join(' · ')
        } else {
          rows.turn.value.textContent = '—'
          rows.turn.sub.textContent = '完成一轮对话后显示'
        }
        const step = snapshot?.step
        if (step && step.cost > 0) {
          rows.step.value.textContent = tinyMoney(step.cost)
          rows.step.sub.textContent = [step.tokens ? `${(step.tokens / 1000).toFixed(1)}k tokens` : '',
            step.peak ? '峰价' : '谷价', clockOf(step.ts)].filter(Boolean).join(' · ')
        } else {
          rows.step.value.textContent = '—'
          rows.step.sub.textContent = '每跑完一步自动浮现'
        }

        // 峰谷
        if (phase) {
          rows.peak.value.textContent = phase.label
          rows.peak.value.style.color = phase.peak ? COLOR.peak : COLOR.valley
          const reason = phase.reason === 'weekend' ? '周末全天谷价'
            : phase.reason === 'holiday' ? '法定节假日全天谷价'
            : phase.peak ? '工作日高峰 9–12 / 14–18' : '非高峰时段'
          rows.peak.sub.textContent = `${reason} · ${remainText(phase.remainMs)}后${phase.nextIsPeak ? '转峰' : '转谷'}价`
        }

        // 预算
        const budget = Number(cfg.dailyBudget) || 0
        if (budget > 0 && today) {
          budgetWrap.style.display = 'flex'
          const ratio = Math.max(0, Math.min(1.6, today.amount / budget))
          budgetValue.textContent = `${money(today.amount)} / ${money(budget)}`
          budgetValue.style.color = ratio >= 1 ? COLOR.danger : ratio >= 0.8 ? COLOR.peak : COLOR.text
          budgetBarInner.style.width = `${Math.min(100, ratio * 100)}%`
          budgetBarInner.style.background = ratio >= 1 ? COLOR.danger : ratio >= 0.8 ? COLOR.peak : COLOR.valley
        } else {
          budgetWrap.style.display = 'none'
        }

        // 近 7 天
        const history = Array.isArray(snapshot?.history) ? snapshot.history : []
        historyWrap.replaceChildren()
        if (history.length > 0) {
          const max = Math.max(0.01, ...history.map((d) => Number(d.amount) || 0))
          for (const day of history) {
            const amount = Math.max(0, Number(day.amount) || 0)
            const bar = h('div', [
              'flex:1; min-width:0; border-radius:2px 2px 1px 1px;',
              `height:${Math.max(2, Math.round((amount / max) * 22))}px;`,
              `background:${amount > 0 ? 'rgba(113,216,166,.75)' : 'rgba(255,255,255,.10)'};`,
            ].join(' '))
            bar.title = `${day.day} · ${tinyMoney(amount)}`
            historyWrap.appendChild(bar)
          }
        }

        renderSettings()
        placeAll()
      }

      // ---- 每步浮现 ----
      const showToast = (cost, peak) => {
        const duration = Number(config().stepToastMs) || 3500
        toast.textContent = `${peak ? '峰 ' : ''}+${tinyMoney(cost)}`
        toast.style.display = 'block'
        placeAll()
        toast.style.opacity = '1'
        if (typeof toast.animate === 'function') {
          toast.animate(
            [
              { opacity: 0, transform: 'translateY(8px) scale(.96)' },
              { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.12 },
              { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.7 },
              { opacity: 0, transform: 'translateY(-10px) scale(.98)' },
            ],
            { duration, easing: 'ease-out', fill: 'forwards' },
          )
        }
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => {
          toast.style.display = 'none'
          toast.style.opacity = '0'
        }, duration)
      }

      // ---- 气泡提醒（走 whale-girl 公开事件）----
      const say = (text) => {
        if (document.querySelector(PET_SELECTOR) === null) return
        try {
          document.dispatchEvent(new CustomEvent('whale-girl:say', { detail: { text } }))
        } catch { /* 通道不可用就安静 */ }
      }

      const speakHints = () => {
        const cfg = config()
        if (!snapshot || cfg.enabled === false) return
        const today = todayKey()
        const total = snapshot.balance && !snapshot.balance.error ? snapshot.balance.total : null
        let dirty = false

        const threshold = Number(cfg.lowBalance) || 0
        if (cfg.notifyLowBalance !== false && threshold > 0 && isNum(total)) {
          if (total < threshold && hints.lowDay !== today) {
            say(`余额只剩 ${money(total)} 了，记得续一点，不然我就要停工了…`)
            hints.lowDay = today
            dirty = true
          } else if (total >= threshold * 1.5 && hints.lowDay === today) {
            hints.lowDay = null
            dirty = true
          }
        }

        const budget = Number(cfg.dailyBudget) || 0
        const spent = Number(snapshot.today?.amount) || 0
        if (budget > 0 && spent >= budget * 0.8 && hints.budgetDay !== today) {
          say(`今天已经花了 ${money(spent)}，预算 ${money(budget)} ${spent >= budget ? '已经用完了' : '快用完了'}`)
          hints.budgetDay = today
          dirty = true
        }

        const phase = snapshot.peak
        if (cfg.notifyPeak !== false && phase) {
          const prev = hints.phase
          if ((prev === 'peak' || prev === 'valley') && prev !== (phase.peak ? 'peak' : 'valley')) {
            say(phase.peak ? '峰价开始了（贵一倍），不急的活儿可以先放放' : '谷价开始了，现在最便宜～')
            dirty = true
          }
          if (hints.phase !== (phase.peak ? 'peak' : 'valley')) {
            hints.phase = phase.peak ? 'peak' : 'valley'
            dirty = true
          }
          const warnMin = Number(cfg.peakWarnMin) || 0
          if (!phase.peak && warnMin > 0 && isNum(phase.nextAtMs) && phase.remainMs <= warnMin * 60000
            && hints.warnAt !== phase.nextAtMs) {
            say(`还有 ${Math.max(1, Math.round(phase.remainMs / 60000))} 分钟进峰价，贵一倍，急的活儿现在发更划算`)
            hints.warnAt = phase.nextAtMs
            dirty = true
          }
        }

        // 单轮超阈值时开口（每步的浮现由 showToast 负责，不占气泡）
        const turn = snapshot.turn
        if (turn && isNum(turn.seq) && turn.seq > (Number(hints.turnSeq) || 0)) {
          hints.turnSeq = turn.seq
          dirty = true
          const sayAbove = Number(cfg.turnSayAbove) || 0
          if (sayAbove > 0 && turn.cost >= sayAbove) {
            say(`这一轮花了 ${tinyMoney(turn.cost)}${turn.peak ? '（峰价）' : ''}`)
          }
        }

        // 每步浮现
        const step = snapshot.step
        if (step && isNum(step.seq)) {
          if (hints.stepSeq === undefined) {
            hints.stepSeq = step.seq
            dirty = true
          } else if (step.seq > Number(hints.stepSeq)) {
            hints.stepSeq = step.seq
            dirty = true
            if (cfg.stepToast !== false) showToast(step.cost, step.peak)
          }
        }

        if (dirty) writeHints(hints)
      }

      // ---- 数据 ----
      const pull = async ({ force = false } = {}) => {
        if (disposed) return
        try {
          const res = force
            ? await fetch(REFRESH_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              cache: 'no-store',
            })
            : await fetch(STATE_PATH, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          snapshot = await res.json()
          lastError = null
          // 首次加载：把历史轮次/步数当基线，不重播旧浮字
          if (hints.turnSeq === undefined) hints.turnSeq = snapshot?.turn?.seq ?? 0
          if (hints.stepSeq === undefined) hints.stepSeq = snapshot?.step?.seq ?? 0
          render()
          speakHints()
          const nextPoll = Number(snapshot?.config?.refreshMs) || 4000
          if (force || nextPoll !== pollMs) {
            pollMs = nextPoll
            startPolling()
          }
        } catch (error) {
          lastError = String(error?.message ?? error)
          if (snapshot === null) {
            strip.style.display = 'none'
            card.style.display = 'none'
          } else {
            render()
          }
        }
      }

      const startPolling = () => {
        clearInterval(pollTimer)
        pollTimer = setInterval(() => { void pull() }, Math.max(2000, pollMs))
      }

      // 借 whale-girl 的 SSE：事件一来立刻补一次（每步花费的浮现更跟手）
      const startEventBridge = () => {
        if (typeof EventSource !== 'function') return
        let pending = null
        try {
          eventSource = new EventSource('/whale-girl/events')
          eventSource.onmessage = () => {
            clearTimeout(pending)
            pending = setTimeout(() => { void pull() }, 300)
          }
          eventSource.onerror = () => {
            try { eventSource?.close() } catch { /* 忽略 */ }
            eventSource = null
          }
        } catch {
          eventSource = null
        }
      }

      // ---- 菜单按钮 ----
      const injectMenuButton = () => {
        const pet = petRoot()
        const menu = pet?.querySelector(MENU_SELECTOR)
        if (!menu) return false
        if (menu.querySelector(`[${BTN_ATTR}]`) !== null) return true
        const btn = document.createElement('button')
        btn.setAttribute(BTN_ATTR, '')
        btn.type = 'button'
        btn.textContent = '💰 钱包'
        btn.style.cssText = BTN_CSS
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          // 与 whale-girl 的 feed/play 一致：点完收起它自己的菜单
          menu.classList.remove('open')
          menu.style.display = 'none'
          toggleStrip()
        })
        menu.appendChild(btn)
        return true
      }

      // ---- 交互 ----
      strip.addEventListener('click', (event) => {
        event.stopPropagation()
        cardOpen ? hideCard() : showCard()
      })
      card.addEventListener('click', (event) => event.stopPropagation())
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation()
        hideCard()
        hideStrip()
      })
      gearBtn.addEventListener('click', (event) => {
        event.stopPropagation()
        settingsOpen = !settingsOpen
        renderSettings()
        placeAll()
        startFollow()
      })
      refreshBtn.addEventListener('click', async (event) => {
        event.stopPropagation()
        refreshBtn.disabled = true
        refreshBtn.textContent = '…'
        await pull({ force: true })
        refreshBtn.disabled = false
        refreshBtn.textContent = '刷新'
      })

      const saveConfig = async (patch) => {
        try {
          const res = await fetch(CONFIG_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
            cache: 'no-store',
          })
          if (!res.ok) return
          const body = await res.json().catch(() => null)
          if (body?.config && snapshot) snapshot.config = body.config
          render()
          if (!enabled()) { hideStrip(); hideCard() }
        } catch { /* 写失败：保持旧值，下次刷新回读 */ }
      }

      for (const input of [lowInput, budgetInput, turnSayInput]) {
        const commit = () => {
          const field = input.getAttribute('data-field')
          const value = Number(input.value)
          if (!Number.isFinite(value) || value < 0) { renderSettings(); return }
          void saveConfig({ [field]: value })
        }
        input.addEventListener('change', commit)
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); input.blur() }
        })
      }
      for (const btn of [lowToggle, peakToggle, stepToggle]) {
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          const field = btn.getAttribute('data-toggle')
          void saveConfig({ [field]: config()[field] !== false ? false : true })
        })
      }

      // 点空白处 / Esc 收起
      const onDocClick = (event) => {
        if (strip.contains(event.target) || card.contains(event.target)) return
        hideCard()
        hideStrip()
      }
      const onKey = (event) => {
        if (event.key !== 'Escape') return
        hideCard()
        hideStrip()
      }
      document.addEventListener('click', onDocClick)
      document.addEventListener('keydown', onKey)
      const onResize = () => { placeAll() }
      window.addEventListener('resize', onResize)

      // 宠物节点出现/被重建：搬进去 + 补按钮
      const observer = new MutationObserver(() => {
        if (disposed) return
        const pet = petRoot()
        if (pet !== null && pet !== anchor) {
          mountInto(pet)
          placeAll()
        }
        injectMenuButton()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      injectMenuButton()
      // 菜单可能是 whale-girl 在挂载后异步补的，稍后再试几次
      let tries = 0
      const retry = setInterval(() => {
        tries += 1
        if (injectMenuButton() || tries > 20 || disposed) clearInterval(retry)
      }, 500)

      startPolling()
      startEventBridge()
      void pull()

      return () => {
        disposed = true
        clearInterval(pollTimer)
        clearInterval(retry)
        clearTimeout(toastTimer)
        cancelAnimationFrame(followRaf)
        followRaf = 0
        try { eventSource?.close() } catch { /* 忽略 */ }
        document.removeEventListener('click', onDocClick)
        document.removeEventListener('keydown', onKey)
        window.removeEventListener('resize', onResize)
        observer.disconnect()
        strip.remove()
        card.remove()
        toast.remove()
        standalone.remove()
      }
    }

    module.exports = {
      name: 'whale-purse',
      inject: [],
      apply,
    }
    return module.exports
  },
})
