# 网页看板外显指标与实时数据口径

> 最后核对：2026-08-25
>
> 适用页面：模板总览、模板详情与模板榜单。
>
> 不包含 TCS。本文以当前网页代码和实际 API 返回为准，不沿用已经下线的复玩指标或旧版说明。

## 1. 当前数据链路

网页同时请求两条只读接口：

| 接口 | 用途 | 时间范围 |
| --- | --- | --- |
| `GET /api/metrics?start=<ISO>&end=<ISO>` | 总览、窗口内模板数据、分享、在线时长、模板发布时间点 | 大部分指标跟随顶部日期窗；`end` 为所选结束日的次日 00:00，查询采用 `[start, end)` |
| `GET /api/template-metrics` | 模板详情和模板榜单的使用、用户、终态成功率、发布转化率 | 模板发布至今的生命周期累计，不受顶部日期窗影响 |

API 通过 PostHog project `425273` 的 HogQL 查询读取 `events` 和 `postgres.*` 数仓表。响应均为 `Cache-Control: no-store`，网页请求也使用 `cache: 'no-store'`。

2026-08-25 18:15（Asia/Shanghai）按修正后查询本地实时抽样结果：

- 顶部窗口：`2026-08-01` 至 `2026-08-25`。
- `content_templates` 中符合页面展示条件的已发布模板：56 个。
- `/api/template-metrics` 返回 198 条模板记录，其中已发布且有 `published_at` 的记录为 56 条。网页只展示这 56 条。
- 当前窗口用户创作来源白名单内容：3,312 条；模板系血缘内容 1,017 条，其中模板创建 982 条、模板 Remix 35 条。
- 当前窗口模板系已发布内容 159 条，模板发布率约 15.63%。
- 在线时长有 96 个有效记录日。该曲线按需求从最早有效记录开始，不受顶部开始日截断，只受结束日上限约束。

Markdown 是口径快照，不会自行刷新；网页上的数字仍由上述 API 实时重算。

## 2. 通用过滤与时间规则

### 2.1 App 事件过滤

所有用于网页的客户端事件查询统一要求：

```sql
properties.$lib IN ('posthog-ios', 'posthog-android')
AND properties.app_env = 'ppe'
AND properties.build_configuration = 'release'
AND ifNull(toString(properties.channel_name), '') != 'testflight'
```

不使用 `person_id` 计算用户数。客户端用户去重使用 `properties.usr_id`，服务端用户去重使用 `user_id`。

### 2.2 内部用户过滤

客户端事件取以下三类内部身份的并集后排除：

1. PostHog Cohort `Internal users`，当前代码中的 `cohort_id=310528`。
2. `postgres.app_user.is_internal=true` 或 `is_internal_virtual_user=true` 对应的 `usr_id`。
3. 上述内部账号经 `postgres.user_devices` 映射出的 `device_id`。

所有客户端 `usr_id` / `device_id` 与数仓字段的关联都必须对两侧执行 `lower(toString(...))`。iOS 上报 UUID 大多包含大写字符，Postgres 保存小写；缺少 `lower()` 不会报错，但会使权威内部账号过滤静默失效。

服务端 `game_tasks`、模板内容归因和模板生命周期查询排除：

```sql
NOT app_user.is_internal
AND NOT app_user.is_internal_virtual_user
```

其中模板生命周期采用 `content_template_runs INNER JOIN app_user`，因此没有有效 `app_user` 记录的 run 也不会进入模板详情累计值。

### 2.3 顶部日期窗

- 最早可选日期固定为 `2026-08-01`。
- 默认结束日为访问当天，并会随自然日自动前移。
- 选择 `2026-08-01` 至 `2026-08-24` 时，API 实际查询为 `>= 2026-08-01T00:00:00Z` 且 `< 2026-08-25T00:00:00Z`。
- 总览指标、热区、分享率和总览榜单跟随日期窗。
- 模板详情的使用、用户、成功率和发布转化不跟随日期窗。
- 模板详情里的作者分享率、内容分享率目前仍跟随顶部日期窗。
- 用户在线时长忽略顶部开始日，只查询所有历史记录至所选结束日。

### 2.4 服务端内容基础过滤

总览中基于 `postgres.game_tasks` 的内容指标要求：

```sql
g.created_at >= start
AND g.created_at < end
AND g.deleted_at IS NULL
AND g.source IN ('user_app','content_template','user_remix_app','user_replace_app','user_copy_app')
AND external user
```

`source` 使用白名单，避免 `cap`、`creatorlab`、`template`、`relay`、`creation_v2_temp` 或未来新增的平台链路自动污染用户内容分母。新增用户创作链路必须显式评审后加入白名单。

模板系内容不再仅按 `source` 判断，而要求以下血缘成立：

```text
game_tasks.content_source_id -> content_templates.template_id
AND game_tasks.source IN ('content_template','user_remix_app')
```

其中 `content_template` 是模板创建，`user_remix_app` 且有模板血缘的是模板 Remix。`user_replace_app` 属于换素材路径，当前数据不携带模板血缘，因此保留在“全部用户内容”分母，但天然不进入模板系指标；这不是人为特例。

## 3. 模板总览

### 3.1 总数据

| 页面指标 | 当前计算 | 数据源 | 时间 | 实时状态 |
| --- | --- | --- | --- | --- |
| 模板占比 | 有模板血缘的 `content_template` + `user_remix_app` 内容数 / 用户创作来源白名单内容数 | `postgres.game_tasks` + `postgres.content_templates` | 顶部日期窗 | 实时 |
| 内容发布率 | `is_draft=false` 的内容数 / 全部符合基础过滤的内容数 | `postgres.game_tasks` | 顶部日期窗 | 实时 |
| 模板发布率 | 模板系内容中 `is_draft=false` / 全部模板系内容 | `postgres.game_tasks` + `postgres.content_templates` | 顶部日期窗 | 实时 |
| Try Now 成功率 | `template_try_now_result(success='1')` 事件数 / 全部 `template_try_now_result` 事件数 | PostHog `events`，iOS + Android | 顶部日期窗 | 实时，但受客户端埋点完整性影响 |
| 作者分享率 | 被内容作者本人点过分享的去重模板系内容数 / 窗口内创建的去重模板系内容数 | `share_channel_click` + 模板内容归因 | 顶部日期窗 | 实时 |
| 内容分享率 | 被任意外部用户点过分享的去重模板系内容数 / 窗口内创建的去重模板系内容数 | `share_channel_click` + 模板内容归因 | 顶部日期窗 | 实时 |

作者分享率与内容分享率是内容维度，不是点击次数或用户比例。同一内容分享多次只进入一次分子。

模板系内容分母由同一套血缘规则生成，并按 `content_id` 去重：

```text
game_tasks.source IN ('content_template','user_remix_app')
AND game_tasks.content_source_id -> content_templates.template_id
```

这里的关联键明确是 `game_tasks.content_source_id`，不是 `game_tasks.template_id`；后者在用户内容上没有可用值。普通 `user_remix_app` 若没有模板血缘不会进入模板分享分母。

分享动作使用 `share_channel_click`，包括端内动作，不要求 `share_result` 成功。只有带有效 `content_id` 且能关联回模板系内容的点击可以进入计算。

### 3.2 活跃分布热区

- 事件：`template_try_now_click`。
- 端覆盖：当前仅 iOS 有数据；Android 为 0，不能解读为双端总量。
- 值：每天每个时段的事件次数，不按用户去重。
- 时段：`00:00-05:59`、`06:00-11:59`、`12:00-17:59`、`18:00-23:59`。
- 时间：顶部日期窗。
- 过滤：完整 App release 过滤和内部用户过滤。
- 页面默认折叠。

Android 模板曝光/点击埋点上线后，这一指标会出现由覆盖变化引起的阶跃，不能直接解释为业务增长。若日期窗包含 `2026-08-09` 至 `2026-08-12`，对应格子显示为灰色虚线，提示客户端事件采集缺口。

风险：当前 HogQL 直接对 `timestamp` 使用 `toDate/toHour`，没有显式业务时区转换。热区适合看相对分布，不应直接当作严格的中国本地小时口径。

### 3.3 用户在线时长

```text
每日合计在线时长（分钟）
= SUM(ai_content_disappear.properties.time_interval) / 60000
```

仅计入 `time_interval > 0` 且 `<= 1,800,000 ms` 的记录，即单条最长 30 分钟。没有有效记录的日期不补零，也不展示。

- 开始时间：从 PostHog 中最早存在有效 `ai_content_disappear.time_interval` 的日期开始。
- 结束时间：顶部日期窗的结束日。
- 曲线：只显示“合计在线时长”。
- 模板发布点：来自 `postgres.content_templates.status='published'` 的 `published_at`。
- 发布点只画在有在线时长记录的日期上，并且模板必须属于当前网页可识别的模板集合。

风险：这是内容曝光退出事件累计的记录时长，不是后端会话时长；缺埋点、异常退出和版本覆盖变化都会影响总量。

### 3.4 模板状态分层

分母只包含 `content_templates.status='published'` 且 `published_at` 非空的模板。四类按顺序互斥归类：

| 分类 | 条件 |
| --- | --- |
| 高速新模板 | 窗口内实际在线天数 `<= 7`，且 iOS `template_try_now_click / 实际在线天数 >= 6` |
| 高发布承接 | 未进入高速新模板，且 `server_template_published / server_template_contents >= 25%`，同时 `success_users >= 5` |
| 高分享承接 | 未进入前两类，且 `template_all_shared_contents / template_created_contents >= 10%`，同时分母至少 3 个内容 |
| 观察池 | 未进入前三类 |

实际在线天数为 `min(窗口天数, 模板从可观测上线日至窗口结束的自然日数)`。可观测上线日默认取 `published_at`；若窗口内首个点击早于后台当前 `published_at`，取两者中更早的日期，避免状态回写把分母压得不合理。上线已久但只在少数日期发生点击的模板不会再被误判为“高速新”。点击分子仍为 iOS 单端；高发布承接改用统一模板血缘集合，但仍叠加客户端成功用户门槛，因此该模块是混合口径。

### 3.5 分榜排名

当前只展示模板榜，不再展示用户榜和总排名。

- 入榜集合：已发布且有 `published_at` 的模板。
- 排列方式：右上角可在“remix 数量”和“发布时间”之间切换。
- `remix 数量`：按窗口内 `template_try_now_click` 次数降序；当前是 iOS 单端口径。
- `发布时间`：按发布时间排序，再次点击同一按钮切换正序或倒序。
- 卡片外显的 `remix`：窗口内 `template_try_now_click` 次数，即 `template_remix_events`。
- 标题与发布时间：实时读取 `postgres.content_templates`。
- 封面：使用本地维护的模板封面映射；API 当前没有实时返回封面字段。

因此卡片顺序取决于当前选中的排序模式；`remix` 数字始终是窗口内客户端点击量，不是服务端 `user_run` 使用次数。

### 3.6 分榜下方三项统计

| 页面指标 | 计算与排序 |
| --- | --- |
| 使用次数最高模板 | 按窗口内 `content_template_runs.run_type='user_run'` 的 `count()` 降序；并显示 `uniq(user_id)` |
| 发布转化率最高模板 | `game_tasks.status='published'` 的关联 run 数 / 窗口内全部 `user_run`；先按比率，再按发布数、使用数降序 |
| 内容分享率最高模板 | `template_all_shared_contents / template_created_contents`；先按比率，再按被分享内容数、分母降序 |

三项均跟随顶部日期窗并实时刷新。发布转化分子只判断关联 `game_tasks.status='published'`，不要求 run 自身成功，也不额外过滤 `game_tasks.deleted_at`。

### 3.7 速度榜

当前口径：

```text
速度 = 窗口内 iOS template_try_now_click 次数
     / min(窗口天数, 模板从可观测上线日至窗口结束的自然日数)
```

- 排名按速度降序，展示前 8 个大于 0 的模板。
- 跟随顶部日期窗并从 PostHog 实时刷新。
- 分子是 iOS 单端客户端点击，不是服务端 `content_template_runs.user_run` 使用次数。
- 页面 tooltip 同时展示“实际在线天数”和“有点击天数”，但只有实际在线天数进入分母。
- 若首个点击早于 `published_at`，可观测上线日取两者中更早者，避免后台发布时间回写造成速度虚高。
- Android 点击埋点上线后会出现测量口径断点。

结论：速度榜可用于比较当前 iOS 入口吸引力，不应当作双端使用速度或服务端生成速度。

## 4. 模板详情

### 4.1 模板展示集合与数量

`/api/template-metrics` 会返回 `postgres.content_templates` 中全部可查模板，包括草稿、禁用、未发布等状态。网页最终只保留：

```text
template_status = 'published'
AND published_at 非空
```

所以 API 原始记录数可以是一百多个，页面模板总数仍应是五十几个。2026-08-25 实时核对为 `198 -> 56`。

新模板发布后，只要 `content_templates` 中已经是 `published`、存在 `published_at`，且发布时间不晚于顶部日期窗结束日，模板 ID 和占位标题会在刷新后自动进入网页。标题优先使用数据库 `content_templates.title`；没有可用标题时显示 `未同步模板 · <短 ID>`。封面仍需人工更新本地映射。

### 4.2 使用次数

```text
COUNT(content_template_runs)
WHERE run_type='user_run'
  AND template_id=<当前模板>
  AND external user
```

这是模板发布至今累计 run 数，不是点击数，不随顶部日期窗变化。

### 4.3 使用用户

```text
UNIQ(content_template_runs.user_id)
WHERE run_type='user_run'
  AND template_id=<当前模板>
  AND external user
```

这是模板发布至今累计去重用户数。

### 4.4 终态成功率

```text
成功率 = run.status='succeeded'
       / (run.status='succeeded' + run.status='failed')
```

- 时间：模板发布至今。
- `pending`、`running` 和其他非终态不进入分母。
- 页面同时显示终态样本数、成功数和失败数。
- 无终态样本时显示“无样本”，不显示伪造的 0% 或 100%。

### 4.5 发布转化率

```text
发布转化率 = 关联 game_tasks.status='published' 的 user_run 数
           / 全部 user_run 数
```

- 时间：模板发布至今。
- 分母包含该模板全部外部 `user_run`，不要求 run 成功。
- 分子只判断关联 `game_tasks.status='published'`。
- 这是 run 次数维度，不是用户维度。

### 4.6 作者分享率与内容分享率

模板详情沿用总览的模板分享定义：

```text
作者分享率 = 当前模板中被作者本人分享过的去重内容 / 当前模板系去重内容
内容分享率 = 当前模板中被任意外部用户分享过的去重内容 / 当前模板系去重内容
```

注意：这两张卡目前取自 `/api/metrics`，因此跟随顶部日期窗，不是发布至今累计。页面中的使用、用户、成功率、发布转化是生命周期值，分享率是窗口值，阅读时必须分开。

### 4.7 终态样本

```text
终态样本 = succeeded run 数 + failed run 数
```

用于解释终态成功率的样本规模。`pending/running` 不计入。

### 4.8 上线周期

```text
上线周期 = published_at（缺失时退回 created_at）至访问当天的自然日数，含首尾
```

该字段随日期自然增长。它只用于展示生命周期长度，不作为当前模板详情使用/成功/发布指标的筛选条件。

### 4.9 模板榜单

模板榜单与模板详情使用同一套生命周期实时数据，只展示已发布模板：

| 排序按钮 | 主排序 | 同值时依次比较 |
| --- | --- | --- |
| 使用 | 生命周期 `user_run` 次数降序 | 使用用户、成功数 |
| 成功率 | 生命周期终态成功率降序 | 终态样本、使用次数 |
| 发布转化 | 生命周期发布转化率降序 | 使用次数、成功数、使用用户 |

“使用”采用稠密排名：相同使用次数显示相同名次。搜索支持模板名称和完整/部分模板 ID。

### 4.10 模板折线趋势

- 外显曲线：每日 `remix` 值，不是累计值。
- 当前历史日数据来自本地 `TEMPLATE_LIFETIME_DAILY_CSV`，最多保留至 `2026-08-18`。
- 模板详情顶部累计指标已实时更新至当天，但折线历史没有通过 `/api/template-metrics` 实时补齐。
- 对没有本地历史序列的模板，折线可能为空或退回窗口聚合点。

结论：模板详情 KPI 是实时生命周期数据；模板折线仍是静态历史补充，不能视为截至当天的完整日趋势。

## 5. 刷新机制与失败兜底

- 首次打开：同时请求 `/api/metrics` 和 `/api/template-metrics`。
- 手动刷新：点击“刷新数据”后重新请求两条接口。
- 自动刷新：数据超过 5 分钟后自动请求；网页每 1 分钟检查一次。
- 回到页面或窗口重新聚焦：数据超过 2 分钟时刷新。
- 日期变化：立即按新日期重新请求 `/api/metrics`；`/api/template-metrics` 也会随页面刷新重新请求，但其生命周期口径不使用顶部日期参数。
- 单条接口失败：能成功的部分继续更新，失败部分保留可用数据并显示状态。
- 两条接口都失败：首次加载使用 `assets/charts-data.js` 静态包兜底；已有页面刷新失败时保留上一次成功数据。

页面状态栏显示数据来自 PostHog live、静态兜底或刷新失败。判断数字是否为最新值时，应同时查看状态栏和生成时间。

## 6. 当前已知边界

1. `2026-08-09` 至 `2026-08-12` 存在 PostHog 客户端事件采集缺口。页面会显示提示，并在热区将对应日期标灰；`game_tasks`、`content_template_runs` 等服务端指标不受影响。
2. `template_try_now_click`、`template_click`、`template_show` 当前实际是 iOS 单端。Try Now 成功率的 `template_try_now_result` 含少量 Android 数据，因此同页客户端指标的端覆盖并不完全一致。
3. 模板系按 `content_source_id` 血缘判断。`user_replace_app` 保留在全部用户内容分母，但因无模板血缘不进入模板系；普通无模板血缘 Remix 同样不进入。
4. 分享率以 `share_channel_click` 为行为证据，不等于“外部平台确认发布成功率”。
5. 模板详情分享率仍是顶部窗口值，和同页生命周期 KPI 的时间范围不同。
6. 速度榜是 iOS 点击 / 实际在线天数，不是双端服务端 run 速度。
7. 模板折线历史只到 `2026-08-18`，尚未实时续写。
8. 模板标题可由 `content_templates.title` 实时补充；封面仍依赖人工维护的本地映射。
9. 发布转化使用 `game_tasks.status='published'`，而总览内容/模板发布率使用 `is_draft=false`。这是与后端页面对数的既定口径，当前不单方面修改。

## 7. 代码位置

| 内容 | 文件 |
| --- | --- |
| PostHog/HogQL 查询、过滤和 API 返回字段 | `functions/_lib/posthog-live-metrics.mjs` |
| 总览 API | `functions/api/metrics.js` |
| 模板生命周期 API | `functions/api/template-metrics.js` |
| 页面指标计算、排序、日期窗和刷新 | `index.html` |
| 标题、封面和历史日趋势静态补充 | `assets/charts-data.js` |
