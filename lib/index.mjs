// whale-purse 宿主半（Node / Cordis 插件）。
//
// 职责：把「余额 / 花费 / 峰谷」三件事算成一个只读快照，交给客户端半画在 whale-girl 桌宠身上。
//   · 余额：DSH 凭据里的 DEEPSEEK_API_KEY 优先（GET https://api.deepseek.com/user/balance）；
//           没有 key 时退回 DSH 账号登录态（ctx.deepseekAccount，token 全程由 DSH 管，本插件不碰）。
//   · 花费：① 余额观测差 = 今日已用（账户口径，最准）；② session/event 的 assistant/message
//           usage 按 (session, turn) 聚合 = 每轮花费与本地估算（无余额接口时兜底）。
//   · 峰谷：北京时间周一至周五 9–12、14–18 为峰时，其余（夜间/周末/法定节假日）谷时，峰价 = 谷价 ×2。
//
// 数据落点（都在 <DSH_HOME>/data/whale-purse/ 下，卸载插件不会删）：
//   ledger.json —— 记账账本（结构兼容 .dshw-usage.json，首次启动自动迁移历史）
//   config.json —— 阈值/开关/轮询间隔
//
// 安全面：所有写路由校验跨源（sec-fetch-site / origin），body 上限 8KB，余额接口 8s 超时。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  blankLedger, normalizeLedger, observeBalance, daySummary, appendEvent, recentDays, beijingDay,
} from './accounting.mjs'
import { costOfUsage, phaseInfo, formatRemain } from './pricing.mjs'

export const name = 'whale-purse'
export const inject = ['webServer']

export const ROUTE_PREFIX = '/whale-purse'
export const STATE_PATH = `${ROUTE_PREFIX}/state`
export const CONFIG_PATH = `${ROUTE_PREFIX}/config`
export const REFRESH_PATH = `${ROUTE_PREFIX}/refresh`
export const BODY_LIMIT = 8192

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000      // 余额缓存时长（客户端轮询再密也不会打爆接口）
const BALANCE_TIMEOUT_MS = 8000   // 单次余额请求超时
const ACCOUNT_TIMEOUT_MS = 5000   // 账号路兜底超时（DSH 自身默认 30s，太长）

const DSH_HOME = process.env.DSH_HOME ?? resolve(import.meta.dirname, '../../..')
// 数据目录可用 WHALE_PURSE_DATA_DIR 覆盖（单测用；正常运行时就是 <DSH_HOME>/data/whale-purse）。
const DATA_DIR = process.env.WHALE_PURSE_DATA_DIR ?? join(DSH_HOME, 'data', 'whale-purse')
const LEDGER_FILE = join(DATA_DIR, 'ledger.json')
const CONFIG_FILE = join(DATA_DIR, 'config.json')
// 旧版挂件（dsh-whale-widget）的账本：只读迁移，不改动原文件。
const LEGACY_LEDGER_CANDIDATES = [
  join(DSH_HOME, '.dshw-usage.json'),
  join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
]

/** 配置默认值（用户可在明细卡里改，写 config.json）。 */
export const DEFAULTS = Object.freeze({
  enabled: true,          // 总开关（关掉不渲染任何界面；宿主仍记账）
  showPlate: false,       // 常驻铭牌（默认关：铭牌改成菜单里的「💰 钱包」按钮，按了才出）
  lowBalance: 5,          // 余额预警阈值（元，0 = 不预警）
  dailyBudget: 0,         // 今日预算（元，0 = 不设）
  notifyLowBalance: true, // 余额低于阈值时宠物开口
  notifyPeak: true,       // 峰谷切换前/后宠物开口
  peakWarnMin: 10,        // 峰价开始前几分钟提醒
  stepToast: true,        // 每跑完一步自动浮现该步花费
  stepToastMs: 3500,      // 浮现停留时长
  turnSayAbove: 0,        // 单轮花费 ≥ 该金额时开口（0 = 从不开口）
  refreshMs: 4000,        // 客户端拉快照间隔（每步浮现要跟手，别太长）
  scale: 1,               // 铭牌缩放（0.8–1.4）
})

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 只有真正的布尔值才算数；配置文件被手改成 "no"/1 之类时回退默认。 */
function flag(value, fallback = true) {
  return typeof value === 'boolean' ? value : fallback
}

/** 合并 + 收敛配置（外部 JSON 可能被手改坏）。 */
export function readConfig(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const merge = { ...DEFAULTS, ...src }
  return {
    enabled: flag(merge.enabled, DEFAULTS.enabled),
    showPlate: flag(merge.showPlate, DEFAULTS.showPlate),
    lowBalance: clampNumber(merge.lowBalance, 0, 100000, DEFAULTS.lowBalance),
    dailyBudget: clampNumber(merge.dailyBudget, 0, 100000, DEFAULTS.dailyBudget),
    notifyLowBalance: flag(merge.notifyLowBalance, DEFAULTS.notifyLowBalance),
    notifyPeak: flag(merge.notifyPeak, DEFAULTS.notifyPeak),
    peakWarnMin: clampNumber(merge.peakWarnMin, 0, 120, DEFAULTS.peakWarnMin),
    stepToast: flag(merge.stepToast, DEFAULTS.stepToast),
    stepToastMs: clampNumber(merge.stepToastMs, 800, 30000, DEFAULTS.stepToastMs),
    turnSayAbove: clampNumber(merge.turnSayAbove, 0, 100000, DEFAULTS.turnSayAbove),
    refreshMs: clampNumber(merge.refreshMs, 3000, 300000, DEFAULTS.refreshMs),
    scale: clampNumber(merge.scale, 0.8, 1.4, DEFAULTS.scale),
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写（同目录 .tmp + rename）；失败不阻塞插件。 */
function writeJsonAtomic(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

function isCrossOrigin(headers, host) {
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      return new URL(origin).host !== host
    } catch {
      return true
    }
  }
  return false
}

async function readBody(req, limit = BODY_LIMIT) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > limit) return null
  }
  return data
}

function sha24(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

/** 从 /user/balance 的 balance_infos 里挑一条（CNY 且非零优先）。 */
function pickBalanceInfo(infos) {
  if (!Array.isArray(infos)) return null
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)
  const usable = infos.filter((x) => x && num(x.total_balance) !== null)
  if (usable.length === 0) return null
  return usable.find((x) => x.currency === 'CNY' && num(x.total_balance) > 0)
    || usable.find((x) => num(x.total_balance) > 0)
    || usable.find((x) => x.currency === 'CNY')
    || usable[0]
}

export function apply(ctx) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer === undefined) return

  // ---- 持久化：配置 + 账本 ----------------------------------------------------
  let config = readConfig(readJson(CONFIG_FILE))

  function loadLedger() {
    const own = readJson(LEDGER_FILE)
    const normalized = normalizeLedger(own)
    if (normalized !== null && (normalized.accounting.active !== null || Object.keys(normalized.history).length > 0)) {
      return normalized
    }
    // 首次启动：迁移旧账本（whale-widget 的今日已用历史与每轮明细），原文件保持不动。
    for (const legacyPath of LEGACY_LEDGER_CANDIDATES) {
      if (!existsSync(legacyPath)) continue
      const legacy = normalizeLedger(readJson(legacyPath))
      if (legacy !== null && (legacy.accounting.active !== null || Object.keys(legacy.history).length > 0)) {
        return legacy
      }
    }
    return blankLedger()
  }

  let ledger = loadLedger()
  let saveTimer = null
  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => writeJsonAtomic(LEDGER_FILE, ledger), 800)
  }

  // ---- 运行时状态 --------------------------------------------------------------
  let revision = 0
  const bump = () => { revision += 1 }
  // 宿主实例标识：进程重启即变化。客户端据此隔离「已看过的步/轮」基线——
  // 计数器是进程内的，重启归零；基线若只按数值比较，重启后会永久错位（静默不提示）。
  const startedAt = Date.now()
  let balanceCache = null        // { total, recharge, bonus, currency, source, scope, at }
  let balanceError = null        // 最近一次取数失败原因（界面显示「—」+ 悬停看原因）
  let balanceInFlight = null

  let turnSeq = 0
  let lastTurn = null            // { seq, turn, cost, tokens, model, peak, ts }
  let stepSeq = 0
  let lastStep = null            // { seq, turn, cost, tokens, model, peak, ts } —— 每「步」一条
  const turnAggs = new Map()     // sessionId -> { turn, cost, tokens, byModel, byModelTokens, lastTs }
  // 客户端自报诊断（排查用）：客户端每次拉 /state 时把「它自己的基线/看到的步/有没有弹浮字」
  // 塞在查询串里带上来，这里只存最后一次，随 /state 的 diag 字段下发。
  let clientDiag = null

  const nowMs = () => Date.now()

  // ---- 余额取数 ----------------------------------------------------------------
  const credentialsOf = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('credentials') : undefined } catch { return undefined }
  }
  const accountOf = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined } catch { return undefined }
  }

  async function fetchByApiKey(key) {
    const res = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`余额接口 HTTP ${res.status}`)
    const data = await res.json().catch(() => null)
    const info = pickBalanceInfo(data?.balance_infos)
    if (!info) throw new Error('余额接口结构异常')
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)
    return {
      total: Number(info.total_balance),
      recharge: num(info.topped_up_balance),
      bonus: num(info.granted_balance),
      currency: String(info.currency || 'CNY').toUpperCase(),
      source: 'apikey',
      scope: sha24(key),
    }
  }

  async function fetchByAccount() {
    const account = accountOf()
    if (!account || typeof account.getBalance !== 'function') throw new Error('当前 DSH 没有账号服务')
    let accountId = null
    try {
      const state = await account.getState?.()
      accountId = state?.userId ?? state?.profile?.userId ?? null
    } catch { accountId = null }
    const result = await Promise.race([
      account.getBalance({
        version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
        locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('账号余额请求超时')), ACCOUNT_TIMEOUT_MS)),
    ])
    if (!result) throw new Error('未登录 DeepSeek 账号')
    if (result.status !== 'ready') throw new Error(`账号余额未就绪（${result.status || 'unknown'}）`)
    const wallets = [...(Array.isArray(result.value) ? result.value : []),
      ...(Array.isArray(result.bonusWallets) ? result.bonusWallets : [])]
      .filter((w) => w && Number.isFinite(Number(w.balance)))
    if (wallets.length === 0) throw new Error('账号没有余额钱包')
    const curOf = (w) => String(w.currency || 'CNY').toUpperCase()
    const nonzero = wallets.filter((w) => Number(w.balance) > 0)
    const pick = nonzero.find((w) => curOf(w) === 'CNY') || nonzero[0]
      || wallets.find((w) => curOf(w) === 'CNY') || wallets[0]
    const currency = curOf(pick)
    const sumOf = (list) => list
      .filter((w) => curOf(w) === currency)
      .reduce((s, w) => s + Number(w.balance), 0)
    const recharge = sumOf(Array.isArray(result.value) ? result.value : [])
    const bonus = sumOf(Array.isArray(result.bonusWallets) ? result.bonusWallets : [])
    return {
      total: Number((recharge + bonus).toFixed(6)),
      recharge: Number(recharge.toFixed(6)),
      bonus: Number(bonus.toFixed(6)),
      currency,
      source: 'account',
      scope: sha24('dsh-account:' + (accountId ?? 'default')),
    }
  }

  async function collectBalance() {
    const reasons = []
    const cred = credentialsOf()
    if (cred && typeof cred.resolve === 'function') {
      try {
        const resolved = await cred.resolve('DEEPSEEK_API_KEY')
        if (resolved && typeof resolved.value === 'string' && resolved.value !== '') {
          try {
            return await fetchByApiKey(resolved.value)
          } catch (error) {
            reasons.push('API key 路：' + String(error?.message ?? error))
          }
        } else {
          reasons.push('未配置 DEEPSEEK_API_KEY')
        }
      } catch (error) {
        reasons.push('凭据读取失败：' + String(error?.message ?? error))
      }
    } else {
      reasons.push('当前 DSH 没有凭据服务')
    }
    try {
      return await fetchByAccount()
    } catch (error) {
      reasons.push('账号登录路：' + String(error?.message ?? error))
    }
    throw new Error(reasons.join('；'))
  }

  /** 刷一次余额（TTL 内直接用缓存）。成功时顺手记一笔余额观测。 */
  async function refreshBalance({ force = false } = {}) {
    if (!force && balanceCache !== null && nowMs() - balanceCache.at < BALANCE_TTL_MS) return balanceCache
    if (balanceInFlight !== null) return balanceInFlight
    balanceInFlight = (async () => {
      try {
        const snap = await collectBalance()
        const at = nowMs()
        const summary = observeBalance(ledger, {
          balance: snap.total, currency: snap.currency, scope: snap.scope, at,
        })
        balanceCache = { ...snap, at, today: summary }
        balanceError = null
        scheduleSave()
        bump()
        return balanceCache
      } catch (error) {
        balanceError = String(error?.message ?? error)
        bump()
        return balanceCache
      } finally {
        balanceInFlight = null
      }
    })()
    return balanceInFlight
  }

  // 有缓存就先给旧的、后台补新的（界面不转圈）；完全没数据时才等一次。
  async function balanceSnapshot() {
    if (balanceCache === null) return await refreshBalance()
    if (nowMs() - balanceCache.at >= BALANCE_TTL_MS) void refreshBalance()
    return balanceCache
  }

  // ---- 每轮花费（session/event 的 usage）--------------------------------------
  function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    if (!agg || agg.cost <= 0) {
      turnAggs.delete(sessionId)
      return
    }
    turnSeq += 1
    lastTurn = {
      seq: turnSeq,
      turn: agg.turn,
      cost: agg.cost,
      tokens: agg.tokens,
      model: agg.model,
      peak: agg.peak,
      ts: agg.lastTs,
    }
    for (const [model, cost] of Object.entries(agg.byModel)) {
      appendEvent(ledger, { ts: agg.lastTs, model, cost, tokens: agg.byModelTokens[model] || 0 })
    }
    scheduleSave()
    bump()
    turnAggs.delete(sessionId)
  }

  function handleSessionEvent(session, event) {
    try {
      const type = event?.type
      const data = event?.data
      if (!data || typeof data !== 'object') return
      const id = typeof session?.id === 'string' ? session.id : 'unknown'
      if (type === 'turn/end') {
        finalizeTurn(id)
        return
      }
      if (type !== 'assistant/message') return
      const turn = Number(data.turn)
      const usage = data.usage
      if (!usage || typeof usage !== 'object' || !Number.isFinite(turn)) return
      let agg = turnAggs.get(id)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(id)
        agg = { turn, cost: 0, tokens: 0, model: '', peak: false, byModel: {}, byModelTokens: {}, lastTs: nowMs() }
        turnAggs.set(id, agg)
      }
      const model = String(data.message?.source?.model ?? '')
      const at = nowMs()
      const priced = costOfUsage(usage, model, phaseInfo(at).peak)
      agg.cost += priced.cost
      agg.tokens += priced.tokens
      agg.model = model || agg.model
      agg.peak = priced.peak
      agg.lastTs = at
      // 每「步」一条：界面在每步跑完时浮现这一步的消耗（一轮里可能有多个 step）。
      if (priced.cost > 0) {
        stepSeq += 1
        lastStep = {
          seq: stepSeq,
          turn,
          cost: priced.cost,
          tokens: priced.tokens,
          model: model || '',
          peak: priced.peak,
          ts: at,
        }
        bump()
      }
      if (model) {
        agg.byModel[model] = (agg.byModel[model] || 0) + priced.cost
        agg.byModelTokens[model] = (agg.byModelTokens[model] || 0) + priced.tokens
      }
    } catch {
      // 事件结构异常绝不影响宠物本体
    }
  }

  // ---- 快照 --------------------------------------------------------------------
  function statePayload() {
    const now = nowMs()
    const today = daySummary(ledger, beijingDay(now), now)
    const phase = phaseInfo(now)
    return {
      ok: true,
      revision,
      startedAt,
      now,
      config,
      balance: balanceCache === null
        ? { error: balanceError ?? '余额还没取到' }
        : {
            total: balanceCache.total,
            recharge: balanceCache.recharge,
            bonus: balanceCache.bonus,
            currency: balanceCache.currency,
            source: balanceCache.source,
            at: balanceCache.at,
            ageMs: now - balanceCache.at,
            error: balanceCache.error ?? null,
          },
      balanceError,
      today,
      turn: lastTurn,
      step: lastStep,
      peak: { ...phase, remainText: formatRemain(phase.remainMs) },
      history: recentDays(ledger, 7, now),
      diag: clientDiag,
    }
  }

  // ---- 路由 --------------------------------------------------------------------
  ctx.effect(() => {
    const disposers = [
      ctx.on('session/event', handleSessionEvent),
      webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET' })
              return
            }
            // 客户端自报诊断：?v=版本&seen=基线&seq=看到的步&toast=0/1&err=异常
            try {
              const q = new URL(req.url ?? '/', 'http://dsh.internal').searchParams
              if (q.has('v')) {
                clientDiag = {
                  at: nowMs(),
                  v: String(q.get('v') ?? '').slice(0, 24),
                  host: String(q.get('host') ?? '').slice(0, 24),
                  seen: String(q.get('seen') ?? '').slice(0, 24),
                  seq: String(q.get('seq') ?? '').slice(0, 24),
                  toast: String(q.get('toast') ?? '').slice(0, 4),
                  err: String(q.get('err') ?? '').slice(0, 160),
                }
              }
            } catch { /* 查询串异常不影响快照 */ }
            await balanceSnapshot()
            json(res, 200, statePayload())
          } catch (error) {
            json(res, 500, { error: String(error?.message ?? error) })
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              json(res, 200, { config, revision })
              return
            }
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed; use GET or POST' }, { allow: 'GET, POST' })
              return
            }
            if (isCrossOrigin(req.headers, req.headers.host)) {
              json(res, 403, { error: 'cross-origin request rejected' })
              return
            }
            const raw = await readBody(req)
            if (raw === null) {
              json(res, 413, { error: 'request body too large' })
              return
            }
            let patch
            try {
              patch = JSON.parse(raw || '{}')
            } catch {
              json(res, 400, { error: 'invalid JSON body' })
              return
            }
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
              json(res, 400, { error: 'body must be a JSON object' })
              return
            }
            config = readConfig({ ...config, ...patch })
            writeJsonAtomic(CONFIG_FILE, config)
            bump()
            json(res, 200, { config, revision })
          } catch (error) {
            json(res, 500, { error: String(error?.message ?? error) })
          }
        },
      }),
      webServer.register({
        kind: 'exact',
        path: REFRESH_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed; use POST' }, { allow: 'POST' })
              return
            }
            if (isCrossOrigin(req.headers, req.headers.host)) {
              json(res, 403, { error: 'cross-origin request rejected' })
              return
            }
            await readBody(req)
            await refreshBalance({ force: true })
            json(res, 200, statePayload())
          } catch (error) {
            json(res, 500, { error: String(error?.message ?? error) })
          }
        },
      }),
    ]
    // 启动后先取一次余额（不阻塞加载），这样铭牌一出现就是真实数字。
    void refreshBalance()
    return () => {
      clearTimeout(saveTimer)
      writeJsonAtomic(LEDGER_FILE, ledger)
      for (const dispose of disposers) dispose()
    }
  }, 'whale-purse: state/config/refresh 路由 + 每轮花费记账')
}
