// 记账内核（纯函数，零宿主依赖，可单测）。
//
// 为什么是「余额观测」而不是「调用流水」：DeepSeek 的 /user/balance 只给余额快照，
// 没有流水接口。所以「今日已用」= 当天观测到的余额下降累计；充值/赠金单独记，
// 不会把已有消费冲掉（这也是 dsh-whale-widget 的口径，两边账本可以互相迁移）。
//
// 账本结构（与 .dshw-usage.json 兼容，便于一键迁移历史）：
//   {
//     version: 1,
//     date: 'YYYY-MM-DD',                 // 最近观测日
//     history: { 'YYYY-MM-DD': 金额 },     // 每日已用（展示/迷你柱状图）
//     events: [{ ts, day, model, cost, tokens }],   // 每轮明细（估算兜底）
//     accounting: {
//       version: 1,
//       active: 'scope-CURRENCY',
//       books: { 'scope-CURRENCY': { currency, days: { 'YYYY-MM-DD': row } } },
//     },
//   }
// 金额一律按 1e-8 定点整数记账（避免浮点累计误差），展示时保留两位。

export const ACCOUNTING_VERSION = 1
export const SCALE = 100000000

/** 元 → 定点整数（非有限数/超范围直接抛错，不静默写坏账）。 */
export function moneyUnits(value) {
  const n = Number(value)
  const units = Math.round(n * SCALE)
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围')
  return units
}

const PARTIAL_GAP_MS = 10 * 60 * 1000 // 观测缺口的容忍度：超过就当「部分数据」

export function beijingDay(timeMs = Date.now()) {
  const d = new Date(Number(timeMs) + 8 * 3600 * 1000)
  if (!Number.isFinite(d.getTime())) throw new Error('无效的观测时间')
  return d.toISOString().slice(0, 10)
}

/** 空账本。 */
export function blankLedger(day = beijingDay()) {
  return {
    version: 1,
    date: day,
    history: {},
    events: [],
    accounting: { version: ACCOUNTING_VERSION, active: null, books: {} },
  }
}

/** 把外部（含旧版 whale-widget）账本收敛成可用结构；坏数据返回 null 交给调用方决定。 */
export function normalizeLedger(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const ledger = blankLedger()
  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) ledger.date = raw.date
  if (raw.history !== null && typeof raw.history === 'object') {
    for (const [day, amount] of Object.entries(raw.history)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const n = Number(amount)
      if (Number.isFinite(n) && n >= 0) ledger.history[day] = n
    }
  }
  if (Array.isArray(raw.events)) {
    ledger.events = raw.events
      .filter((e) => e !== null && typeof e === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(e.day)))
      .slice(-500)
      .map((e) => ({
        ts: Number(e.ts) || 0,
        day: String(e.day),
        model: String(e.model ?? '未知'),
        cost: Number(e.cost) || 0,
        tokens: Number(e.tokens) || 0,
      }))
  }
  const acc = raw.accounting
  if (acc !== null && typeof acc === 'object' && acc.version === ACCOUNTING_VERSION
    && acc.books !== null && typeof acc.books === 'object') {
    const books = {}
    for (const [scope, book] of Object.entries(acc.books)) {
      if (book === null || typeof book !== 'object' || book.days === null || typeof book.days !== 'object') continue
      const days = {}
      for (const [day, row] of Object.entries(book.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || row === null || typeof row !== 'object') continue
        days[day] = {
          day,
          firstAt: Number(row.firstAt) || 0,
          lastAt: Number(row.lastAt) || 0,
          openingUnits: Number(row.openingUnits) || 0,
          lastUnits: Number(row.lastUnits) || 0,
          debitUnits: Number(row.debitUnits) || 0,
          creditUnits: Number(row.creditUnits) || 0,
          revision: Number(row.revision) || 0,
          correction: null,
        }
      }
      books[scope] = { currency: String(book.currency || 'CNY').toUpperCase(), days }
    }
    ledger.accounting = { version: ACCOUNTING_VERSION, active: typeof acc.active === 'string' ? acc.active : null, books }
  }
  return ledger
}

function currentBook(ledger) {
  const a = ledger.accounting
  return a && a.version === ACCOUNTING_VERSION && a.books ? a.books[a.active] : undefined
}

function partialDayInfo(day, row, now) {
  const start = Date.parse(String(day) + 'T00:00:00+08:00')
  const first = Number(row?.firstAt)
  const last = Number(row?.lastAt)
  if (!Number.isFinite(start) || !Number.isFinite(first) || !Number.isFinite(last)) {
    return { partialDay: true, observedFromMs: null, observedToMs: null }
  }
  const beforeGap = first - start
  const afterGap = now >= start + 86400000 ? start + 86400000 - last : 0
  return {
    partialDay: beforeGap > PARTIAL_GAP_MS || afterGap > PARTIAL_GAP_MS,
    observedFromMs: first,
    observedToMs: last,
  }
}

function observedAmount(row) {
  return row.debitUnits / SCALE
}

/**
 * 记一次余额观测。ledger 由调用方持有（本模块不读写文件）。
 * @param {object} ledger
 * @param {{balance: number, currency?: string, scope?: string, at?: number}} snapshot
 * @returns {object} 当天的日汇总
 */
export function observeBalance(ledger, snapshot) {
  const at = Number(snapshot?.at ?? Date.now())
  const day = beijingDay(at)
  const units = moneyUnits(snapshot?.balance)
  const currency = String(snapshot?.currency || 'CNY').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('余额币种无效')
  const scope = String(snapshot?.scope || 'default')
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scope)) throw new Error('账户标识无效')
  const context = scope + '-' + currency

  let a = ledger.accounting
  if (!a || a.version !== ACCOUNTING_VERSION || a.books === null || typeof a.books !== 'object') {
    a = ledger.accounting = { version: ACCOUNTING_VERSION, active: context, books: {} }
  }
  let book = a.books[context]
  if (!book) book = a.books[context] = { currency, days: {} }
  // 重复/乱序样本直接忽略（含跨零点迟到的样本）。
  if (book.lastAt != null && at <= book.lastAt) return daySummary(ledger, ledger.date, at)
  a.active = context

  let row = book.days[day]
  if (!row) {
    row = book.days[day] = {
      day, firstAt: at, lastAt: at, openingUnits: units, lastUnits: units,
      debitUnits: 0, creditUnits: 0, revision: 0, correction: null,
    }
  } else {
    const delta = row.lastUnits - units
    if (delta > 0) row.debitUnits += delta      // 余额下降 = 消费
    if (delta < 0) row.creditUnits -= delta     // 余额上升 = 充值/赠金（单独记）
    row.lastUnits = units
    row.lastAt = at
  }
  book.lastAt = at
  ledger.date = day
  const summary = daySummary(ledger, day, at)
  ledger.history[day] = summary.amount
  return summary
}

/** 追加一条每轮明细（估算兜底，同时给「每轮花费」做历史）。 */
export function appendEvent(ledger, event) {
  const day = event?.day || beijingDay(event?.ts ?? Date.now())
  const row = {
    ts: Number(event?.ts) || Date.now(),
    day,
    model: String(event?.model ?? '未知'),
    cost: Number(event?.cost) || 0,
    tokens: Number(event?.tokens) || 0,
  }
  ledger.events.push(row)
  if (ledger.events.length > 500) ledger.events.splice(0, ledger.events.length - 500)
  return row
}

/** 当天由明细估算的金额（没有余额观测时兜底）。 */
export function eventEstimate(ledger, day) {
  let sum = 0
  for (const e of Array.isArray(ledger.events) ? ledger.events : []) {
    if (e.day === day) sum += Number(e.cost) || 0
  }
  return sum
}

/**
 * 某天的消费汇总。
 * @param {object} ledger
 * @param {string} [day]
 * @param {number} [now]
 * @returns {{day: string, amount: number, currency: string, source: string, label: string,
 *            partialDay: boolean, observedFromMs: number|null, observedToMs: number|null,
 *            openingBalance: number|null, currentBalance: number|null,
 *            observedDecrease: number, observedIncrease: number, eventEstimate: number}}
 */
export function daySummary(ledger, day = beijingDay(), now = Date.now()) {
  const book = currentBook(ledger)
  const row = book?.days?.[day]
  const estimate = eventEstimate(ledger, day)
  if (row) {
    const partial = partialDayInfo(day, row, now)
    return {
      day,
      amount: observedAmount(row),
      currency: book.currency,
      source: 'observed',
      label: '已观测消费',
      openingBalance: row.openingUnits / SCALE,
      currentBalance: row.lastUnits / SCALE,
      observedDecrease: row.debitUnits / SCALE,
      observedIncrease: row.creditUnits / SCALE,
      eventEstimate: estimate,
      ...partial,
    }
  }
  const legacy = ledger.history?.[day]
  const hasLegacy = typeof legacy === 'number' && Number.isFinite(legacy)
  return {
    day,
    amount: hasLegacy ? legacy : estimate,
    currency: 'CNY',
    source: hasLegacy ? 'legacy' : 'events',
    label: hasLegacy ? '旧版记录' : '本地估算',
    openingBalance: null,
    currentBalance: ledger.lastBalance ?? null,
    observedDecrease: 0,
    observedIncrease: 0,
    eventEstimate: estimate,
    partialDay: !hasLegacy,
    observedFromMs: null,
    observedToMs: null,
  }
}

/** 最近 N 天（含今天）的每日消费，缺失日补 0，供迷你柱状图。 */
export function recentDays(ledger, days = 7, now = Date.now()) {
  const out = []
  const todayStart = Date.parse(beijingDay(now) + 'T00:00:00+08:00')
  for (let i = days - 1; i >= 0; i--) {
    const day = beijingDay(todayStart - i * 86400000 + 12 * 3600000)
    const summary = daySummary(ledger, day, now)
    out.push({ day, amount: summary.amount, source: summary.source })
  }
  return out
}
