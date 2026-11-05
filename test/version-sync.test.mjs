// client 半是手写单文件、没有构建步骤，版本常量只能手写——用一个测试守住它别和 package.json 漂移，
// 否则 /state.diag 里报的「页面跑的哪一版」会骗人（排查时最容易误导人的那种 bug）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('lib/client.js 的 VERSION 与 package.json 版本一致', () => {
  const escaped = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(client, new RegExp(`const VERSION = '${escaped}'`))
})

test('宿主半通过 /state 下发实例标识 startedAt', () => {
  const host = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
  assert.match(host, /const startedAt = Date\.now\(\)/)
  assert.match(host, /startedAt,\s*\n\s*now,/)
})

test('客户端按宿主实例隔离基线（而不是只比数值大小）', () => {
  assert.match(client, /hints\.hostId !== hostId/)
})
