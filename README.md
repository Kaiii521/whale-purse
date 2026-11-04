# whale-purse · 鲸鱼钱包

> 给 DSH 桌宠 [whale-girl](https://github.com/vlln/whale-girl) 加一层「钱」的信息：**余额 / 每步花费 / 峰谷**。
> 它不是第二只宠物 —— 钱包按钮长在鲸鱼娘自己的菜单里，铭牌和明细卡跟着她拖动、跟着她隐藏。

![预览](docs/screenshot.png)

装完并重启一次，你的桌面就和上图一模一样：点鲸鱼娘 → 菜单里多一格 `💰 钱包` → 浮出铭牌 → 再点开明细卡。

## 安装（两条命令）

前置：DSH Desktop（web profile）。第一行是桌宠本体，第二行是这个钱包层。

```sh
# 1) 桌宠本体（角色素材属画师 ZipZipPipe，不在本仓库分发）
dsh plugin --profile web add whale-girl

# 2) 钱包层，二选一：
dsh plugin --profile web add "github:Kaiii521/whale-purse"        # 从 GitHub
dsh plugin --profile web add "link:C:\path\to\whale-purse"        # 从本地 clone
```

装完**重启 DSH Desktop**（托盘退出再打开，不是关窗口），进聊天页按 **Ctrl+R**。

> 只装 whale-purse 是没有宠物的：它把界面挂到 whale-girl 的节点上，没有鲸鱼娘时退化成右下角一个小按钮。

### 验收

| 操作 | 期望 |
|---|---|
| 点鲸鱼娘 | `🍗 喂食 / 🎾 玩耍 / 🎭 更换 / 💰 钱包` |
| 点「💰 钱包」 | 上方浮出 `¥11.18 · 今 ¥0.71  谷 ▾` |
| 再点铭牌 | 明细卡：余额（充/赠拆分）· 今日已用 · 本轮花费 · 上一步 · 峰谷倒计时 · 近 7 天 |
| 发一句话 | 每跑完一步，宠物上方浮出 `+¥0.008`，约 3.5 秒淡出 |
| 点空白 / Esc / ✕ | 铭牌与卡片一起收起 |

## 它解决什么

原来的余额挂件（如 `dsh-whale-widget`）是**第二只宠物**：自己的鲸鱼图、自己的泡泡，和你养的桌宠各说各话。这个插件把同样的数据接到你已经在用的 whale-girl 身上：

- **余额**：DSH 凭据里的 `DEEPSEEK_API_KEY` 优先（`GET /user/balance`）；没有 key 时自动退回 DSH 账号登录态，令牌全程由 DSH 管，插件不接触。
- **花费**：① 当天余额**下降额**累计 =「今日已用」（账户口径，充值/赠金单独记，不会冲掉消费）；② `session/event` 的 usage 按 (session, step) 聚合 =「每步花费」（无余额接口时也用它兜底估算）。
- **峰谷**：北京时间**周一至周五 9:00–12:00、14:00–18:00 为峰时**，其余时段（夜间、周末、法定节假日全天）谷时，峰价 = 谷价 × 2。峰价前 10 分钟与峰/谷切换时，宠物会开口提醒。

## 配置

点明细卡的 ⚙ 就能改，写 `<DSH_HOME>/data/whale-purse/config.json`，改完即时生效：

```jsonc
{
  "enabled": true,          // 总开关（关掉不渲染界面，宿主仍记账）
  "showPlate": false,       // 铭牌常驻（默认关：改成菜单按钮按需唤出）
  "lowBalance": 5,          // 余额预警阈值（元，0=关）
  "dailyBudget": 0,         // 今日预算（元，0=不设）
  "notifyLowBalance": true, // 余额低时开口
  "notifyPeak": true,       // 峰谷切换提醒
  "peakWarnMin": 10,        // 峰价前几分钟预告
  "stepToast": true,        // 每步浮现花费
  "stepToastMs": 3500,      // 浮现停留
  "turnSayAbove": 0,        // 单轮 ≥ 该金额时开口（0=从不）
  "refreshMs": 4000,        // 客户端拉快照间隔
  "scale": 1                // 铭牌缩放 0.8–1.4
}
```

## 数据与隐私

- 余额只走两条官方路径：`DEEPSEEK_API_KEY` 或 DSH 账号服务。本插件**不存密钥**、不接触账号令牌。
- 账本只写本机：`<DSH_HOME>/data/whale-purse/ledger.json`（金额按 1e-8 定点记账，避免浮点累积误差）。
- 首次启动会把旧版挂件 `.dshw-usage.json` 的历史**只读迁移**过来，原文件不动。
- 路由（同源，写操作校验 `sec-fetch-site` / `origin`，body ≤ 8KB）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/whale-purse/state` | GET | 快照（余额 / 今日 / 本轮 / 上一步 / 峰谷 / 7 天 / 配置） |
| `/whale-purse/config` | GET·POST | 读 / 改配置 |
| `/whale-purse/refresh` | POST | 强制刷一次余额 |

## 结构

```
lib/index.mjs      宿主半（Cordis 插件）：取余额、记账、峰谷、每步花费、路由
lib/client.js      客户端半：菜单按钮 / 铭牌 / 明细卡 / 每步浮现（原生 DOM，无需打包）
lib/pricing.mjs    峰谷规则 + 价目表 + 成本换算（纯函数）
lib/accounting.mjs 余额观测记账（纯函数）
test/              单元测试（node:test）
```

```sh
node --test --test-isolation=none test/*.test.mjs   # 20 个用例：峰谷边界、周末/节假日、成本换算、记账、路由冒烟
```

## 常见坑与排错

装和用的时候最容易卡住的几处，先看这张表：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 菜单里没有「💰 钱包」 | bundle 层只在**启动时**合成，刷新页面不会加载新插件 | 托盘**退出** DSH Desktop 再打开（关窗口不算），然后聊天页 `Ctrl+R` |
| 有按钮但点了没反应 | 客户端半还是旧 bundle（页面缓存） | `Ctrl+R` 硬刷新；仍不行就再退一次 DSH |
| 铭牌显示 `¥—`，卡片写「未取到余额」 | 既没配 `DEEPSEEK_API_KEY`，也没登录 DSH 账号；或 `api.deepseek.com` 不通 | 配 key 或登录账号；确认 **DSH 进程**能出网（余额请求走 Node，不走浏览器代理） |
| 「今日已用」是 0 或明显偏小 | 按余额下降观测：**装上之前**花掉的不回溯，且每天从首次观测起算 | 正常现象，卡片副行有「HH:MM 起观测」；次日就是完整一天 |
| 充值后「今日已用」没变 | 充值/赠金不算消费 | 正常：单独显示在余额行（充 / 赠），不会冲掉已记的消费 |
| 每步 `+¥0.00x` 不出现 | 这一步还没跑完（没有 usage 事件）；`stepToast` 被关掉；或客户端是旧 bundle | 等这一步结束；⚙ 里确认「每步浮现花费」；`Ctrl+R` |
| 每步金额和官方账单对不上 | 每步是 token × 价目表的**估算**，还受缓存命中率影响 | 以「今日已用」（余额差）为准，每步数字只用来感知量级 |
| 余额更新慢半拍 | 25 秒缓存，防止把接口打爆 | 卡片里点「刷新」强制拉一次 |
| 峰谷判定和官网不一致 | 判定按北京时间，不吃本机时区；节假日表按年维护 | 先核对系统时钟；节假日需补 `lib/pricing.mjs` 的 `HOLIDAY_VALLEY`（2026 已全，2027 待补） |
| 看到两份余额 / 两套账 | 同时启用了 `dsh-whale-widget` | 关掉其中一个（建议留本插件） |
| 老版本 DSH 上只能读 API key | 老宿主没有 `deepseekAccount` 服务 | 升级 DSH，或只配 `DEEPSEEK_API_KEY` |

### 设计上的三个边界

- **今日已用是「账户口径」**：余额下降才叫消费，所以最接近官方账单，但需要至少一次成功观测。
- **每步花费是「估算口径」**：token 数来自会话事件，价格取内置峰谷价目表；自定义单价 / 中转站不在支持范围。
- **峰谷规则是「时间口径」**：以结算时刻判定峰/谷，不按 token 逐条分桶；节假日表每年补一次。

## English

A wallet layer for the DSH desktop pet [whale-girl](https://github.com/vlln/whale-girl): balance, per-step cost and peak/off-peak pricing hints, rendered into the pet's own menu and overlay. Install `whale-girl` first, then this plugin, restart DSH once and hard-refresh the page. Node-only, no bundler, no secrets stored.

## 许可与致谢

- 本仓库：MIT © 2026 Zekai Yu
- 桌宠本体 [whale-girl](https://github.com/vlln/whale-girl)：MIT © Sam Gao (vlln)
- 角色形象「鲸鱼娘」© [ZipZipPipe](https://space.bilibili.com/4168597)，素材**不在本仓库分发**
- 峰谷规则、价目表与账本口径参考 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）
