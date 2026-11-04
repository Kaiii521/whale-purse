import test from 'node:test'
import assert from 'node:assert/strict'
import { isPeakTime, nextPeakChangeAt, phaseInfo, costOfUsage, formatRemain, priceFor } from '../lib/pricing.mjs'

/** 北京时间 → epoch 秒（测试里一律用北京时间说话，免得被本机时区影响）。 */
const bjs = (y, m, d, hh, mm = 0) => Math.floor(Date.UTC(y, m - 1, d, hh - 8, mm) / 1000)

test('工作日高峰时段：9–12、14–18 为峰，边界右开', () => {
  const mon = (hh, mm = 0) => bjs(2026, 11, 2, hh, mm) // 2026-11-02 周一
  assert.equal(isPeakTime(mon(8, 59)), false)
  assert.equal(isPeakTime(mon(9, 0)), true)
  assert.equal(isPeakTime(mon(11, 59)), true)
  assert.equal(isPeakTime(mon(12, 0)), false) // 12:00 起谷
  assert.equal(isPeakTime(mon(13, 59)), false)
  assert.equal(isPeakTime(mon(14, 0)), true)
  assert.equal(isPeakTime(mon(17, 59)), true)
  assert.equal(isPeakTime(mon(18, 0)), false)
  assert.equal(isPeakTime(mon(23, 30)), false)
})

test('周末全天谷价（2026-08-23 起生效）', () => {
  assert.equal(isPeakTime(bjs(2026, 11, 7, 10, 0)), false) // 周六 10:00
  assert.equal(isPeakTime(bjs(2026, 11, 8, 15, 0)), false) // 周日 15:00
})

test('法定节假日全天谷价（2026-09-19 起生效）', () => {
  assert.equal(isPeakTime(bjs(2026, 10, 1, 10, 0)), false) // 国庆周四 10:00
  assert.equal(isPeakTime(bjs(2026, 9, 25, 15, 0)), false) // 中秋周五 15:00
  // 生效日之前的历史分桶按旧规则（那天确实是工作日高峰），别拿新规则改写旧账
  assert.equal(isPeakTime(bjs(2026, 2, 17, 15, 0)), true)
})

test('下一切换点：谷→峰、峰→谷、跨周末', () => {
  const mon = (hh, mm = 0) => bjs(2026, 11, 2, hh, mm)
  assert.equal(nextPeakChangeAt(mon(8, 30)), mon(9, 0))
  assert.equal(nextPeakChangeAt(mon(11, 30)), mon(12, 0))
  assert.equal(nextPeakChangeAt(mon(12, 30)), mon(14, 0))
  assert.equal(nextPeakChangeAt(mon(17, 30)), mon(18, 0))
  // 周五傍晚 → 下周一 09:00（周末整天谷价，中途没有切换）
  assert.equal(nextPeakChangeAt(bjs(2026, 11, 6, 18, 30)), bjs(2026, 11, 9, 9, 0))
})

test('phaseInfo：峰谷状态与倒计时同源', () => {
  const valley = bjs(2026, 11, 2, 8, 0) // 周一 08:00
  const info = phaseInfo(valley * 1000)
  assert.equal(info.peak, false)
  assert.equal(info.label, '谷时')
  assert.equal(info.priceScale, 1)
  assert.equal(info.nextAtMs, bjs(2026, 11, 2, 9, 0) * 1000)
  assert.equal(info.remainMs, 60 * 60 * 1000)
  assert.equal(info.nextIsPeak, true)

  const peak = phaseInfo(bjs(2026, 11, 2, 10, 0) * 1000)
  assert.equal(peak.peak, true)
  assert.equal(peak.priceScale, 2)
  assert.equal(peak.label, '峰时')
})

test('成本换算：峰价 = 谷价 ×2，缓存命中按 hit 档', () => {
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }
  const valley = costOfUsage(usage, 'deepseek-flash', false)
  const peak = costOfUsage(usage, 'deepseek-flash', true)
  assert.equal(valley.cost, 1) // 1M 未命中输入 = ¥1（谷价）
  assert.equal(peak.cost, 2)   // 峰价翻倍
  assert.equal(costOfUsage({ cacheReadTokens: 1_000_000 }, 'deepseek-flash', false).cost, 0.02)
  assert.equal(costOfUsage({ outputTokens: 1_000_000 }, 'deepseek-flash', true).cost, 8)

  // Pro 是 Flash 的 3 倍
  const pro = costOfUsage(usage, 'deepseek-v4-pro', false)
  assert.equal(pro.cost, 4.5)
})

test('模型名匹配：未知模型回退 Flash，pro 不被 flash 规则吃掉', () => {
  assert.equal(priceFor('deepseek-v4-pro').miss[0], 4.5)
  assert.equal(priceFor('deepseek-flash').miss[0], 1)
  assert.equal(priceFor('some-unknown-model').miss[0], 1)
  assert.equal(priceFor('').miss[0], 1)
})

test('倒计时格式化', () => {
  assert.equal(formatRemain(0), '0s')
  assert.equal(formatRemain(42_000), '42s')
  assert.equal(formatRemain(5 * 60_000 + 12_000), '5m12s')
  assert.equal(formatRemain(3600_000 + 23 * 60_000), '1h23m')
})
