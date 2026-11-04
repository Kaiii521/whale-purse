import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blankLedger, observeBalance, daySummary, normalizeLedger, appendEvent, recentDays, beijingDay,
} from '../lib/accounting.mjs'

const T0 = Date.UTC(2026, 10, 4, 2, 0, 0) // 北京时间 2026-11-04 10:00

test('余额观测差 = 今日已用', () => {
  const ledger = blankLedger()
  observeBalance(ledger, { balance: 20, at: T0, scope: 'abc' })
  const after = observeBalance(ledger, { balance: 17.5, at: T0 + 60_000, scope: 'abc' })
  assert.equal(after.amount, 2.5)
  assert.equal(after.source, 'observed')
  assert.equal(after.openingBalance, 20)
  assert.equal(after.currentBalance, 17.5)
  assert.equal(ledger.history[beijingDay(T0)], 2.5)
})

test('充值/赠金单独记，不冲掉已发生的消费', () => {
  const ledger = blankLedger()
  observeBalance(ledger, { balance: 10, at: T0, scope: 'abc' })
  observeBalance(ledger, { balance: 8, at: T0 + 60_000, scope: 'abc' })   // 花 2
  const after = observeBalance(ledger, { balance: 30, at: T0 + 120_000, scope: 'abc' }) // 充 22
  assert.equal(after.amount, 2)
  assert.equal(after.observedIncrease, 22)
})

test('重复/乱序样本被忽略', () => {
  const ledger = blankLedger()
  observeBalance(ledger, { balance: 10, at: T0 + 120_000, scope: 'abc' })
  const late = observeBalance(ledger, { balance: 1, at: T0, scope: 'abc' })
  assert.equal(late.amount, 0)
})

test('跨零点：新的一天从「此刻余额」重新起算', () => {
  const ledger = blankLedger()
  observeBalance(ledger, { balance: 10, at: T0, scope: 'abc' })
  const nextDay = Date.UTC(2026, 10, 4, 16, 30, 0) // 北京时间 11-05 00:30
  const after = observeBalance(ledger, { balance: 9, at: nextDay, scope: 'abc' })
  assert.equal(beijingDay(nextDay), '2026-11-05')
  assert.equal(after.amount, 0) // 昨天的下降算在昨天
  assert.equal(after.openingBalance, 9)
})

test('没有余额观测时退回每轮明细估算', () => {
  const ledger = blankLedger()
  const day = beijingDay(T0)
  appendEvent(ledger, { ts: T0, day, model: 'deepseek-flash', cost: 0.02, tokens: 1000 })
  appendEvent(ledger, { ts: T0 + 1000, day, model: 'deepseek-flash', cost: 0.03, tokens: 2000 })
  const summary = daySummary(ledger, day, T0)
  assert.equal(summary.source, 'events')
  assert.equal(summary.amount, 0.05)
  assert.equal(summary.label, '本地估算')
})

test('normalizeLedger 能吃下旧版 .dshw-usage.json 结构', () => {
  const legacy = {
    date: '2026-11-03',
    lastBalance: 13.24,
    todayUsage: 0.06,
    history: { '2026-11-02': 0.43, '2026-11-03': 0.06, bad: 1 },
    events: [{ ts: 1, day: '2026-11-02', model: 'deepseek-flash', cost: 0.43, tokens: 711095 }],
    accounting: {
      version: 1,
      active: '962da151fff798838ccc694b-CNY',
      books: {
        '962da151fff798838ccc694b-CNY': {
          currency: 'CNY',
          days: {
            '2026-11-03': {
              day: '2026-11-03', firstAt: T0, lastAt: T0 + 1000,
              openingUnits: 1330000000, lastUnits: 1324000000, debitUnits: 6000000, creditUnits: 0,
              revision: 0, correction: null,
            },
          },
        },
      },
    },
  }
  const ledger = normalizeLedger(legacy)
  assert.ok(ledger)
  assert.equal(ledger.history['2026-11-02'], 0.43)
  assert.equal(ledger.history.bad, undefined)
  assert.equal(ledger.accounting.active, '962da151fff798838ccc694b-CNY')
  const summary = daySummary(ledger, '2026-11-03', T0 + 2000)
  assert.equal(summary.amount, 0.06)
  assert.equal(summary.source, 'observed')
})

test('坏数据不炸：normalizeLedger 返回 null', () => {
  assert.equal(normalizeLedger(null), null)
  assert.equal(normalizeLedger('nope'), null)
  assert.equal(normalizeLedger([]), null)
})

test('recentDays 补齐缺失日期', () => {
  const ledger = blankLedger()
  appendEvent(ledger, { ts: T0, day: beijingDay(T0), model: 'deepseek-flash', cost: 0.5, tokens: 1 })
  const days = recentDays(ledger, 7, T0)
  assert.equal(days.length, 7)
  assert.equal(days[6].amount, 0.5)
  assert.equal(days[0].amount, 0)
})
