# 当前项目数据口径与取数方式梳理

> 2026-08-20 更新：本文记录的是早期静态包时代的项目状态。当前页面已经改为 `/api/metrics` API-first，并按 PostHog「业务核心指标」看板对齐：总览 / 内容发布类指标走 `postgres.game_tasks`，客户端模板漏斗带 App release / TestFlight / internal 过滤并用 `usr_id` 去重。当前实现请以 `posthog-live-metrics.mjs`、`docs/posthog-live-api.md` 和 `docs/non-tcs-data-risk-audit.md` 为准。

## 1. 结论先说

- 当前这个打包目录里的页面，**运行时不直连 PostHog**。
- 页面实际吃的是 **静态打包数据**，主要来自：
  - `assets/charts-data.js`
  - `assets/template-lifecycle-0818.js`
  - `assets/template-scratchpad-summary-0818.js`
  - `index.html` 内部硬编码的窗口常量
- `docs/posthog_website_data_runbook.md` 和 `docs/template-content-score-tcs.md` 提供的是：
  - 数据拉取规则
  - 指标定义规则
  - 不是页面运行时直接请求的接口

---

## 2. 页面实际怎么拿数据

### 2.1 主入口

页面初始化时，`index.html` 通过 `loadSourceData()` 读取全局变量 `window.__TEMPLATE_METRICS_SOURCE__`，再构建当前页面所需的两个时间窗数据集。

对应代码：

- `index.html` 中 `loadSourceData()`：读取 `globalThis.__TEMPLATE_METRICS_SOURCE__`
- `index.html` 中 `init()`：`loadSourceData() -> buildWindowSources() -> enrichDataset()`

这意味着当前页面的数据入口不是接口请求，而是**前面先由静态 JS 挂到 `window` 上，再被页面消费**。

### 2.2 主看板数据源

`assets/charts-data.js` 暴露：

- `window.__TEMPLATE_METRICS_SOURCE__.HEADLINE`
- `window.__TEMPLATE_METRICS_SOURCE__.rows`
- `window.__TEMPLATE_METRICS_SOURCE__.POST_OVERVIEW_ROWS`
- `window.__TEMPLATE_METRICS_SOURCE__.OVERVIEW_TOTALS`
- `window.__TEMPLATE_METRICS_SOURCE__.PUBLISHED_TEMPLATE_META`
- `window.__TEMPLATE_METRICS_SOURCE__.TEMPLATE_NAMES`

这些字段被 `index.html` 用于：

- 总览页 KPI
- 模板榜 / 用户榜 / 总榜
- TCS 排序的基础数据
- 模板名、图片和元信息映射

### 2.3 模板详情生命周期数据源

`assets/template-lifecycle-0818.js` 暴露两组全局 CSV：

- `window.TEMPLATE_LIFETIME_SUMMARY_CSV`
- `window.TEMPLATE_LIFETIME_DAILY_CSV`

`index.html` 里会把它们解析成 map：

- `getTemplateLifetimeSummaryMap()`
- `getTemplateLifetimeDailyMap()`

用途：

- 模板详情累计指标
- 生命周期天数
- 模板详情逐日折线

### 2.4 ScratchPad 汇总数据源

`assets/template-scratchpad-summary-0818.js` 暴露：

- `window.SCRATCHPAD_TEMPLATE_SUMMARY_CSV`

`index.html` 通过 `getScratchpadTemplateSummaryMap()` 解析后，优先覆盖模板详情里的部分指标，主要用于：

- `usage_count`
- `user_count`
- `success_count`
- `failure_count`
- `success_rate`
- `publish_conversion_rate`

### 2.5 页面内硬编码窗口常量

`index.html` 内部还写死了一批窗口数据：

- `PREVIOUS_17_TEMPLATE_ROWS_CSV`
- `PREVIOUS_17_HEATMAP_CSV`
- `PREVIOUS_17_USER_ROWS_CSV`
- `WINDOW_CONVERSION_STATS`
- `WINDOW_SITE_TOTALS`
- `WINDOW_RETENTION_STATS`

这部分的作用：

- 给上一时间窗补历史数据
- 给总览 KPI 里的部分分母和转化率提供直接数值
- 当前窗的全站提交量分母 `content_creation_submit = 961` 也来自这里

这意味着当前页面并不是所有指标都从同一份原始表里推导出来，存在“静态汇总值 + 明细行聚合值”混用的情况。

---

## 3. 各页面 / 模块的数据来源

| 模块 | 实际来源 | 取数方式 | 备注 |
| --- | --- | --- | --- |
| 总览页 KPI | `assets/charts-data.js` + `WINDOW_CONVERSION_STATS` + `WINDOW_SITE_TOTALS` | 页面启动后直接读 `window` 和常量 | 非实时 |
| 模板榜 / 用户榜 / 总榜 | `assets/charts-data.js` | `loadSourceData()` 读 `window.__TEMPLATE_METRICS_SOURCE__` | 非实时 |
| 活跃热区 | 当前窗：页面内常量；上一窗：`PREVIOUS_17_HEATMAP_CSV` | 直接解析 CSV 常量 | 非实时 |
| 模板详情顶部指标 | `template-lifecycle-0818.js` + `template-scratchpad-summary-0818.js` | 读 `window.*_CSV` 后解析 | 非实时 |
| 模板详情折线 | `TEMPLATE_LIFETIME_DAILY_CSV` | 按日解析 `days_csv/remix_csv` | 当前已改成逐日值 |
| TCS 区域 | `charts-data.js` 明细行二次计算 | 前端 `enrichDataset()` 里现算 | 当前仍是替代值，不是正式 TCS |

---

## 4. 关键指标口径

## 4.1 TCS 正式定义

正式定义来自 `docs/template-content-score-tcs.md`。

符号定义：

- `E` = 曝光用户
- `U` = 使用用户，即成功生成内容的去重用户
- `P` = 发布用户
- `S` = 分享用户

正式公式：

```text
TCS = 20 × U/E + 40 × P/E + 40 × S/E
```

等价写法：

```text
TCS = (U + 2P + 2S) ÷ (5E) × 100
```

### 当前页面状态

- 当前页面**没有正式落地 E**。
- 所以当前页面并没有计算正式 TCS，只是在前端先算了一个替代排序值：

```text
value_output = U + 2P + 2S
```

这只是一个**未除以曝光分母 E 的价值产出值**，适合内部排序参考，不等于正式 TCS。

---

## 4.2 U / P / S 的当前映射

在 `index.html` 的 `enrichDataset()` 里，当前页面的映射是：

- `usage_users = success_users`
- `publish_users = successful_post_users`
- `share_users = successful_share_users`

也就是：

- `U = success_users`
- `P = successful_post_users`
- `S = successful_share_users`

这是当前页面最关键的口径前提。

---

## 4.3 模板带来的创作总量

总览卡里的“模板带来的创作总量”来自：

```text
template_total = OVERVIEW_TOTALS.template_total
```

当前页面展示为：

- 主值：`template_total`
- 说明：`当前窗口模板侧累计`

它是总览层面的静态汇总，不是现场按明细重新加总出来的。

---

## 4.4 模板占比

总览卡里的“模板占比”口径：

```text
templateShareOfCreation = CONTENT_PUBLISH_STATS.template_contents / CONTENT_PUBLISH_STATS.total_contents
```

对应字段：

- 分子：`CONTENT_PUBLISH_STATS.template_contents`，即 `postgres.game_tasks` 中 `source = 'content_template'` 的内容数
- 分母：`CONTENT_PUBLISH_STATS.total_contents`，即同时间窗内全部有效 `postgres.game_tasks` 内容数

当前页面文案写的是：

- `content_template / 全部 game_tasks`
- `模板内容数 / 全部内容数`

---

## 4.5 模板总使用量

总览卡里的“模板总使用量”不是 `template_total`，而是：

```text
templateUsageTotal = Σ rows[].template_remix_events
```

即：

- 对所有模板明细行的 `template_remix_events` 做求和

它的分母优先来自：

```text
WINDOW_SITE_TOTALS[state.windowKey].content_creation_submit
```

当前窗即：

- `模板总使用量 / 全站创作提交量`

如果该分母缺失，页面会退回成：

- `模板总使用量 / 总创作量`

---

## 4.6 总成功率

总览卡里的“总成功率”口径：

```text
totalSuccessRate = Σ success_users / Σ template_remix_users
```

即：

- 分子：所有模板的 `success_users` 之和
- 分母：所有模板的 `template_remix_users` 之和

页面文案解释为：

- `模板使用用户里成功生成的占比`

注意这里是**用户口径**，不是事件口径。

---

## 4.7 成功生成后发帖率

总览卡里的“成功生成后发帖率”当前直接读窗口常量：

```text
WINDOW_CONVERSION_STATS[state.windowKey].post_rate_pct
```

并展示为：

- 分子：`successful_post_users`
- 分母：`success_users`

也就是：

```text
successful_post_users / success_users
```

页面文案为：

- `成功生成用户里继续发帖`

---

## 4.8 成功分享率

当前项目里这项存在两套口径，必须区分。

### 总览卡口径

总览卡“成功分享率”读取：

```text
WINDOW_CONVERSION_STATS[state.windowKey].share_rate_pct
```

展示分式：

```text
successful_share_users / success_users
```

也就是：

- 成功生成用户里完成有效主动分享的占比

### TCS 正式口径

文档里的正式 TCS 分享率是：

```text
S / P
```

即：

- `share_users / publish_users`

这两者不是同一个东西，不能混着说。

---

## 4.9 成功复玩率

当前页面的成功复玩率在 `enrichDataset()` 里是：

```text
replay_rate_7d = repeat_success_extra_events / success_events_for_replay
```

对应字段：

- 分子：`repeat_success_extra_events`，同一 `usr_id + template_id` 下第 2 次及以后的成功生成次数
- 分母：`success_events_for_replay`，该模板成功生成次数
- 辅助字段：`repeat_success_users` / `replay_users` 只表示发生过成功复玩的用户数，不作为概率分子

失败生成不进入分母，也不进入分子；旧的 `repeat_click_users` 只作为 legacy 字段保留，不再派生成成功复玩率。

---

## 4.10 速度榜

速度榜按下面字段排序：

```text
template_remix_events_per_day
```

当前模板详情里这个值的口径是：

```text
template_remix_events_per_day = template_remix_events / active_days_to_0818
```

即：

- 分子：模板累计使用量
- 分母：模板从上线到 `2026-08-18` 的生命周期天数

所以速度榜本质上是：

- `remix / 生命周期天`

不是时间窗内活跃天数，也不是当天趋势值。

---

## 4.11 模板详情折线

模板详情折线当前已经改成**逐日值**，不是累计值。

数据来源：

- `TEMPLATE_LIFETIME_DAILY_CSV`

解析逻辑：

- `days_csv` 解析成日期数组
- `remix_csv` 解析成对应日期的日 remix 数
- `buildDailyTimeline()` 同时构造：
  - `window_remix`
  - `cumulative_remix`

当前图表实际使用的是：

```text
series.data = lifetime.timeline[].window_remix
```

也就是：

- 模板详情折线 = 上线以来逐日 remix 趋势

---

## 5. PostHog 文档里的事件口径

虽然当前页面不直连 PostHog，但当前目录已经把 PostHog 拉数规则写进 `docs/posthog_website_data_runbook.md`，后续重拉数据应以它为准。

### 5.1 remix 事件

推荐口径：

```sql
event = 'ai_content_action'
AND properties.action_type = 'click_remix'
```

### 5.2 分享成功事件

推荐口径：

```sql
event = 'share_result'
AND properties.is_success = true
```

### 5.3 internal user 过滤

推荐过滤：

```sql
AND NOT coalesce(person.properties['$internal_or_test_user'], false)
```

这部分是“上游数据生成规则”，不是当前静态页运行时逻辑。

---

## 6. 当前项目里的口径风险

### 6.1 TCS 还不是正式 TCS

- 当前页面缺少 `E=曝光用户`
- 所以页面里展示和排序用的是 `value_output = U + 2P + 2S`
- 如果对外说成“TCS”，会口径不准

### 6.2 分享率有两套定义

- 总览卡：`successful_share_users / success_users`
- TCS 正式定义：`share_users / publish_users`

这两套必须在文案里明确区分。

### 6.3 成功率也有两套定义

- 总览“总成功率”：用户口径，`success_users / template_remix_users`
- 模板详情 `success_rate`：事件口径，来自 `usage_count / success_count / failure_count` 那条数据源

不能直接横向比较。

### 6.4 上一窗和当前窗来源不完全一致

- 当前窗主体来自 `charts-data.js`
- 上一窗大量依赖 `PREVIOUS_17_*` 常量
- 所以两个时间窗并不是完全同构的原始数据链路

---

## 7. 如果后面要重拉数据，建议顺序

1. 先看 `docs/template-content-score-tcs.md`，确定指标定义
2. 再看 `docs/posthog_website_data_runbook.md`，确认事件和过滤
3. 先重拉上游明细
4. 再生成新的静态 `js/csv` 文件
5. 最后让页面消费新的静态包

不要直接在页面里改展示值，否则很容易把“静态常量口径”和“明细聚合口径”混在一起。

---

## 8. 本次梳理涉及的核心文件

- `index.html`
- `assets/charts-data.js`
- `assets/template-lifecycle-0818.js`
- `assets/template-scratchpad-summary-0818.js`
- `docs/template-content-score-tcs.md`
- `docs/posthog_website_data_runbook.md`
