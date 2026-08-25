# PostHog 实时刷新 API

本项目新增了 `/api/metrics`，用于让页面从 PostHog 实时刷新非 TCS 的总览 / 模板数据。浏览器不直接访问 PostHog，也不保存 Personal API Key；所有查询都在本地 Node 服务或 Cloudflare Pages Function 中执行。

2026-08-20 已按 PostHog「业务核心指标」看板与 `analytics-metrics` skill 对齐：

- 总览 / 内容发布类指标优先使用服务端数仓 `postgres.game_tasks`。
- 模板内容总量只包含 `source = 'content_template'`。
- `user_replace_app` 当前不纳入总览模板内容数、模板发布率，也不强行归到单模板。
- 客户端模板漏斗只保留 try-now 点击 / 成功 / 分享 / 热区，且带 App release 过滤。
- 用户去重用 `usr_id`，不再用 `person_id` 当业务 UV。
- internal 过滤升级为服务端内部账号 / 内部设备 + PostHog cohort `310528` 兜底。

## 文件入口

- `posthog-live-metrics.mjs`：HogQL 查询与返回结构的唯一口径入口。
- `functions/api/metrics.js`：Cloudflare Pages Function，线上使用。
- `local-posthog-server.mjs`：本地预览服务器，开发时使用。
- `index.html`：优先请求 `/api/metrics`，失败时回退 `assets/charts-data.js` 静态包。

## 环境变量

```bash
POSTHOG_HOST=https://us.posthog.com
POSTHOG_PROJECT_ID=425273
POSTHOG_PERSONAL_API_KEY=<personal api key with project query read permission>
POSTHOG_METRICS_START=2026-08-01T00:00:00Z
POSTHOG_METRICS_END=2026-08-18T00:00:00Z
```

页面顶部提供自定义日期范围。最早可选 `2026-08-01`，结束日期默认跟随本地今天；点击“应用”后，前端会把当前选择的 `start` / `end` 作为 query 参数传给 `/api/metrics`。`end` 是排除边界，例如界面选择 `2026-08-01 至 2026-08-20` 会请求 `start=2026-08-01T00:00:00Z&end=2026-08-21T00:00:00Z`。

PostHog 官方文档：`https://posthog.com/docs/sql`。HogQL API 使用 `/api/projects/:project_id/query`，需要 Personal API Key。

## Internal users 过滤

实时 API 不再使用 person 属性作为唯一过滤。当前事件查询同时排除：

```sql
AND person_id NOT IN (
  SELECT person_id
  FROM cohort_people
  WHERE cohort_id = 310528
)
AND lower(toString(properties.usr_id)) NOT IN (
  SELECT lower(toString(user_id))
  FROM postgres.app_user
  WHERE ifNull(is_internal, false) OR ifNull(is_internal_virtual_user, false)
)
AND toString(properties.device_id) NOT IN (
  SELECT toString(device_id)
  FROM postgres.user_devices
  WHERE lower(toString(user_id)) IN (...)
)
```

服务端内容查询通过 `postgres.app_user.is_internal / is_internal_virtual_user` 排除内部账号。完整风险梳理见 `docs/non-tcs-data-risk-audit.md`。

## 当前实时覆盖范围

实时 API 当前覆盖：

- 模板占比：`postgres.game_tasks` 中 `source='content_template'` 的内容数 / 全部有效内容数
- 总览发布数 / 发布率：`postgres.game_tasks`
- 模板内容数 / 发布数 / 发布率：`postgres.game_tasks`，模板来源只看 `content_template`
- Remix 内容数 / 发布数 / 发布率：`postgres.game_tasks`，`source='user_remix_app'`
- 模板点击：`template_try_now_click`
- 模板成功生成：`template_try_now_result` 且 `success=1`
- 模板成功分享：`share_result` 且 `is_success=true`
- 活跃热区：`template_try_now_click` 按日期和 4 个 UTC 时段聚合
- 模板详情成功率：全量 `postgres.content_template_runs` 中 `run_type='user_run'`，`status='succeeded' / (status='succeeded' + status='failed')`；`pending` / `running` 不进分母
- 模板详情发布转化率：关联 `postgres.game_tasks.status='published'` 的 run 数 / 全部 `user_run`；不要求 run 本身成功，也不额外过滤关联任务的 `deleted_at`
- 总览单模板使用次数：所选窗口内 `postgres.content_template_runs.run_type='user_run'` 的 run 数；默认仅外部用户
- 总览单模板发布转化率：所选窗口内关联 `postgres.game_tasks.status='published'` 的 run 数 / 同窗口全部 `user_run`
- 总览单模板内容分享率：所选窗口创建且具有模板血缘的内容中，被任意外部用户触发 `share_channel_click` 的去重内容数 / 同窗口模板系内容数

模板详情这两个指标与 Scratch Pad `/templates` 一致，默认只统计外部用户：内连接 `postgres.app_user`，排除 `is_internal` 和 `is_internal_virtual_user`。它们是模板发布至今的实时累计值，不随页面顶部日期范围变化；页面加载、手动刷新、每 5 分钟自动刷新及重新聚焦页面时，都会单独请求 `/api/template-metrics`。比例为 0 时仍保留明确的分子、分母，分母为 0 的成功率展示为“无样本”。独立接口避免总览重查询超时时把模板详情一起降级为旧静态数据。

`/api/template-metrics` 会保留全量 `content_templates` 记录用于指标核查；页面的模板详情榜单和模板计数只展示 `status='published'` 且 `published_at` 非空的模板，并在这批已发布模板内重新排名。草稿、未发布和下架记录不会计入页面显示的模板总数。

总览榜单下方的三项模板统计只读取 `/api/metrics` 的所选时间窗口，不读取 `/api/template-metrics` 的生命周期累计字段。页面加载、手动刷新、每 5 分钟自动刷新、日期范围变更及重新聚焦页面时都会重算。模板详情的发布至今累计与总览窗口指标保持分离。

## 暂不强行覆盖的指标

TCS 仍不使用总览口径强行计算，因为正式 TCS 缺少曝光用户 `E`。页面里的 TCS 区域只作为独立观察面板，不和总览 / 模板发布率混算。

另外，`user_replace_app` 暂不进入当前看板口径；如后续需要单独分析，可另开独立指标，不和模板内容数 / 模板发布率混算。
