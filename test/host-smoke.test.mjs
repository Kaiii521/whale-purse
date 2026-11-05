// 宿主半冒烟测试：用假 ctx 跑通「注册路由 → /state → /config 写入」，
// 不联网（mock ctx 没有凭据/账号服务，余额必然走失败分支，正好验证降级路径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'whale-purse-'))
process.env.WHALE_PURSE_DATA_DIR = dataDir
// 迁移源指向不存在的路径，避免读到这台机器上真实的历史账本
process.env.DSH_HOME = join(dataDir, 'fake-home')

const { apply, readConfig, DEFAULTS } = await import('../lib/index.mjs')

function fakeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    get: () => undefined,
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(callback) { return callback() },
  }
  return {
    ctx,
    routes,
    listeners,
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.status = status; res.headers = headers ?? {} },
    end(chunk) { res.body = chunk ?? '' },
  }
  return res
}

const getJson = (res) => JSON.parse(res.body)

test('注册三条路由并返回健康快照', async () => {
  const harness = fakeCtx()
  harness.ctx.get = (name) => (name === 'webServer' ? harness.webServer : undefined)
  apply(harness.ctx)
  assert.ok(harness.routes.has('/whale-purse/state'))
  assert.ok(harness.routes.has('/whale-purse/config'))
  assert.ok(harness.routes.has('/whale-purse/refresh'))

  const res = fakeRes()
  await harness.routes.get('/whale-purse/state').handler({ method: 'GET', headers: {} }, res)
  assert.equal(res.status, 200)
  const body = getJson(res)
  assert.equal(body.ok, true)
  assert.equal(typeof body.startedAt, 'number') // 宿主实例标识（客户端据此隔离基线）
  assert.equal(body.config.refreshMs, DEFAULTS.refreshMs)
  assert.equal(typeof body.peak.peak, 'boolean')
  assert.equal(body.history.length, 7)
  assert.equal(body.step, null) // 还没有跑过任何一步
  assert.equal(body.turn, null)
  assert.equal(body.today.day, new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10))
  // 没有凭据服务时余额降级为「拿不到」，不是 500
  assert.ok(body.balance.error)
  assert.match(body.balanceError, /凭据|账号/)
})

test('客户端自报诊断：查询串被回显到 diag', async () => {
  const harness = fakeCtx()
  harness.ctx.get = (name) => (name === 'webServer' ? harness.webServer : undefined)
  apply(harness.ctx)
  const res = fakeRes()
  await harness.routes.get('/whale-purse/state').handler({
    method: 'GET',
    headers: {},
    url: '/whale-purse/state?v=0.2.2&host=1793878000000&seen=3&seq=4&toast=1&err=toast:boom',
  }, res)
  assert.equal(res.status, 200)
  const body = getJson(res)
  assert.equal(body.diag.v, '0.2.2')
  assert.equal(body.diag.host, '1793878000000')
  assert.equal(body.diag.seen, '3')
  assert.equal(body.diag.seq, '4')
  assert.equal(body.diag.toast, '1')
  assert.equal(body.diag.err, 'toast:boom')
  // 第二次不带查询串时，diag 保留上一次上报
  const res2 = fakeRes()
  await harness.routes.get('/whale-purse/state').handler({ method: 'GET', headers: {} }, res2)
  assert.equal(getJson(res2).diag.v, '0.2.2')
})

test('POST /config 收敛越界值并落盘', async () => {
  const harness = fakeCtx()
  harness.ctx.get = (name) => (name === 'webServer' ? harness.webServer : undefined)
  apply(harness.ctx)
  const res = fakeRes()
  await harness.routes.get('/whale-purse/config').handler({
    method: 'POST',
    headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify({ lowBalance: 12.5, dailyBudget: -3, peakWarnMin: 999 }) },
  }, res)
  assert.equal(res.status, 200)
  const body = getJson(res)
  assert.equal(body.config.lowBalance, 12.5)
  assert.equal(body.config.dailyBudget, 0)     // 负数收敛到 0
  assert.equal(body.config.peakWarnMin, 120)   // 上限 120
  assert.ok(existsSync(join(dataDir, 'config.json')))
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')).lowBalance, 12.5)
})

test('跨源写请求被拒绝', async () => {
  const harness = fakeCtx()
  harness.ctx.get = (name) => (name === 'webServer' ? harness.webServer : undefined)
  apply(harness.ctx)
  const res = fakeRes()
  await harness.routes.get('/whale-purse/config').handler({
    method: 'POST',
    headers: { host: '127.0.0.1:1', origin: 'https://evil.example' },
    async *[Symbol.asyncIterator]() { yield '{}' },
  }, res)
  assert.equal(res.status, 403)
})

test('readConfig 对脏数据兜底', () => {
  assert.deepEqual(readConfig(null), readConfig({}))
  const cfg = readConfig({ refreshMs: 'abc', scale: 9, enabled: 'no' })
  assert.equal(cfg.refreshMs, DEFAULTS.refreshMs)
  assert.equal(cfg.scale, 1.4)
  assert.equal(cfg.enabled, true) // 非布尔脏值不当作「关闭」
  assert.equal(readConfig({ enabled: false }).enabled, false)
})

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})
