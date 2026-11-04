// 峰谷定价 + 成本换算（纯函数，零宿主依赖，可单测）。
// 规则与价目表来自 DeepSeek API 官方计费说明（2026-09-19 版）：
//   高峰 = 北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；高峰价 = 谷价 × 2。
//   其余时段一律谷价：夜间、周末、调休上班的周末、以及法定节假日全天。
//
// 口径备注（与 dsh-whale-widget 0.4.2 一致，方便两边账本对得上）：
//   - 缓存命中按输入档计费（hit），未命中输入按 miss，输出按 out；
//   - 价格单位是「元 / 百万 token」；
//   - 峰谷以**结算时刻**判定（每轮结束那一秒），不是按 token 逐条分桶。

/** 高峰时段（北京时间，[起, 止) 小时）。 */
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

// Flash（deepseek-flash ≈ DeepSeek-V4.1-Flash）：[谷价, 峰价]
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
// Pro 为 Flash 的 3 倍价。
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}

/** 周末全天谷价的生效时刻（北京时间 2026-08-23 00:00）。之前的历史按旧规则。 */
export const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
/** 法定节假日全天谷价的生效时刻（北京时间 2026-09-19 00:00）。 */
export const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000)

// 只列「放假」的日期（调休上班日都落在周末，按周末规则本来就是谷价）。
// ⚠️ 每年 11 月国务院公布次年安排后要在这里补下一年。
export const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
  // 2027（国务院 2026-11 才公布，先留空占位，公布后补）
}

/** 北京日历日（YYYY-MM-DD）。 */
export function beijingDay(timeMs = Date.now()) {
  const d = new Date(Number(timeMs) + 8 * 3600 * 1000)
  if (!Number.isFinite(d.getTime())) throw new Error('无效时间')
  return d.toISOString().slice(0, 10)
}

function isHolidayValley(bjDate) {
  try {
    return HOLIDAY_VALLEY[bjDate.toISOString().slice(0, 10)] === 1
  } catch {
    return false
  }
}

/**
 * 某时刻是否高峰（epoch 秒）。
 * @param {number} timeSec epoch 秒
 * @returns {boolean}
 */
export function isPeakTime(timeSec) {
  const n = Number(timeSec)
  if (!Number.isFinite(n)) return false
  const bj = new Date(n * 1000 + 8 * 3600 * 1000) // 用 UTC 读法读北京日历
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  if (n >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(bj)) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

/**
 * 下一个峰谷切换时刻（epoch 秒）。与 isPeakTime 完全同源（含周末与节假日）。
 * 返回 null 表示 12 天内没有切换点（现行规则下不会发生）。
 */
export function nextPeakChangeAt(timeSec) {
  const n = Number(timeSec)
  if (!Number.isFinite(n)) return null
  const cur = isPeakTime(n)
  const day0 = Math.floor((n + 8 * 3600) / 86400) * 86400 // 北京当日 00:00（+8h 平移坐标系）
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * 86400 + edge * 3600 - 8 * 3600
      if (cand <= n + 1) continue
      if (isPeakTime(cand) !== cur) return cand
    }
  }
  return null
}

/** 该日为什么是谷价（周末/节假日/普通工作日），给界面文案用。 */
export function valleyReason(timeMs = Date.now()) {
  const bj = new Date(Number(timeMs) + 8 * 3600 * 1000)
  const dow = bj.getUTCDay()
  if (isHolidayValley(bj)) return 'holiday'
  if (dow === 0 || dow === 6) return 'weekend'
  return 'offhours'
}

/**
 * 当前时段快照（界面直接可用）。
 * @param {number} [timeMs]
 * @returns {{peak: boolean, label: string, remainMs: number, nextAtMs: number|null,
 *            nextIsPeak: boolean, priceScale: number, reason: string}}
 */
export function phaseInfo(timeMs = Date.now()) {
  const sec = Math.floor(Number(timeMs) / 1000)
  const peak = isPeakTime(sec)
  const nextAt = nextPeakChangeAt(sec)
  return {
    peak,
    label: peak ? '峰时' : '谷时',
    remainMs: nextAt === null ? 0 : Math.max(0, nextAt * 1000 - timeMs),
    nextAtMs: nextAt === null ? null : nextAt * 1000,
    nextIsPeak: !peak,
    priceScale: peak ? 2 : 1,
    reason: peak ? 'workday' : valleyReason(timeMs),
  }
}

/** 模型名 → 价目表（子串匹配，最长键优先，未知模型按 Flash）。 */
export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  let best = null
  let bestLen = 0
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) === -1) continue
    if (key.length > bestLen) { best = PRICING[key]; bestLen = key.length }
  }
  return best ?? PRICING._default
}

/**
 * 一轮对话的花费（元）：缓存命中 / 未命中输入 / 输出三档。
 * @param {{inputTokens?: number, cacheReadTokens?: number, outputTokens?: number}} usage
 * @param {string} model
 * @param {boolean} peak
 * @returns {{cost: number, tokens: number, price: object, peak: boolean}}
 */
export function costOfUsage(usage, model, peak) {
  const input = Number(usage?.inputTokens) || 0
  const cache = Number(usage?.cacheReadTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  // DSH 的 outputTokens 已含 reasoningTokens，不能再加一次。
  const p = priceFor(model)
  const idx = peak ? 1 : 0
  const cost = (cache / 1e6) * p.hit[idx] + (input / 1e6) * p.miss[idx] + (output / 1e6) * p.out[idx]
  return { cost, tokens: input + cache + output, price: p, peak }
}

/** 把毫秒变成「1h23m」「5m12s」「42s」这种紧凑倒计时。 */
export function formatRemain(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}
