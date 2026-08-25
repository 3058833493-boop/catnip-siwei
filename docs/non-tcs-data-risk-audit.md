# 非 TCS 数据口径与风险梳理

更新时间：2026-08-20

本文只梳理“总览 / 模板”数据，不包含 TCS。TCS 应单独看，因为正式 TCS 需要曝光用户 `E`，当前页面里仍是未除以曝光分母的替代排序值。

## 1. 当前已对齐的口径

页面当前是 API-first：

- 优先请求 `/api/metrics`，由 `posthog-live-metrics.mjs` 实时查询 PostHog。
- 请求失败时回退静态包。
- 顶部是自定义日期范围；最早可选 `2026-08-01`，结束日期默认跟随本地今天。

实时 API 已按 PostHog「业务核心指标」看板和 `analytics-metrics` skill 对齐：

- 总览内容数 / 发布数 / 发布率：`postgres.game_tasks`
- 内容分母：期内创建、`deleted_at IS NULL`
- 内容分子：`is_draft = false`
- 排除来源：`content_studio`、`workbench`、`admin`、`eval`、`github_import`
- 模板来源：`content_template`
- Remix 来源：`user_remix_app`
- 客户端模板漏斗：`template_try_now_click`、`template_try_now_result`、`share_result`
- App 事件过滤：`$lib IN ('posthog-ios','posthog-android')`、`app_env='ppe'`、`build_configuration='release'`、`channel_name != 'testflight'`
- 用户去重：`usr_id`，不再用 `person_id` 当业务 UV

## 2. Internal users 过滤现状

当前实现已不再只依赖 `person.properties['$internal_or_test_user']`。

事件查询同时排除：

- PostHog cohort `Internal / Test users`，cohort id `310528`
- `postgres.app_user.is_internal = true`
- `postgres.app_user.is_internal_virtual_user = true`
- 由 `postgres.user_devices` 映射出来的内部设备

服务端内容查询通过 `postgres.app_user` 排除内部账号。这个和看板里的“排除自己人”方向一致。

## 3. 当前剩余风险

### 3.1 2026-08-09 至 2026-08-12 事件数据空洞

PostHog 看板说明这段时间有免费额度耗尽导致的事件丢失。客户端事件类指标，比如 try-now 点击、成功、分享、热区，在这段窗口内仍会低估。

服务端 `game_tasks` 内容数更适合作为内容发布类口径，但如果分析“客户端行为链路”，仍需要显式提示这段不可补的数据空洞。

### 3.2 `user_replace_app` 不进入当前模板口径

当前总览模板口径只包含：

```sql
source = 'content_template'
```

`user_replace_app` 多数行没有 `content_source_id`，无法可靠映射回模板 UUID。因此当前页面不把它纳入：

- 总览模板内容数
- 模板发布率分母 / 分子
- 单模板发布归因

### 3.3 分享仍是客户端事件口径

分享指标仍来自 `share_result`，不是服务端 `game_tasks.successful_share_count`。原因是看板口径把 `copy_link`、`download`、`comment` 等动作也纳入分享行为，而服务端分享计数字段和看板定义不完全一致。

### 3.4 TCS 仍然独立

当前页面的 TCS 面板仍缺正式分母 `E=曝光用户`。因此它不能和总览的服务端内容发布率、模板发布率混算。

## 4. 维护建议

1. 内容发布类问题优先查 `postgres.game_tasks`，不要再从 `content_creation_submit - template_success_events` 推导。
2. 模板 try-now 漏斗继续用客户端事件，但必须带 App release 过滤、TestFlight 排除和 internal 过滤。
3. 单模板发布归因只认 `content_source_id` 能对上模板 UUID 的服务端行。
4. 对外展示任何跨 `2026-08-09 ~ 2026-08-12` 的客户端事件趋势时，必须标注数据空洞。
5. 如果未来要看 `user_replace_app`，另开独立指标；不要和当前模板内容数 / 模板发布率混算。
