# Catnip 数据拉取 Runbook

用于在新开一个“没有记忆”的窗口时，快速让 Agent 对齐 `template-metrics-20260730` 网站口径，并稳定从 `PostHog MCP` 拉数、写回飞书。

## 1. 先看这两个文件

- 网站主文件：[`template-metrics-20260730.html`](file:///c:/Users/msi/Desktop/Research/template-metrics-20260730/template-metrics-20260730.html)
- 网站字段口径：[`charts.js`](file:///c:/Users/msi/Desktop/Research/template-metrics-20260730/assets/charts.js)

重点不是先改 UI，而是先从 `charts.js` 反推：

- 榜单字段叫什么
- 跳转链接怎么拼
- 模板 / 用户 / 总览 这三个口径各自看什么

## 2. 网站字段口径

### 2.1 用户 Post 榜单

`charts.js` 里用户榜单的核心字段是：

- `content_id`
- `content_title`
- `source_type`
- `active_days`
- `remix_events`
- `remix_users`
- `successful_share_count`

标题显示逻辑：

```javascript
function postTitle(row) {
  return row && row.content_title ? row.content_title : shortId(row.content_id);
}
```

结论：

- 如果 `content_title` 拉不到，允许回退成 `content_id` 或短 id
- 这不是理想方案，但和网站现有兜底逻辑一致

### 2.2 用户内容跳转链接

```javascript
function contentDetailUrl(id) {
  return id ? 'https://scratch-pad.echonlab.com/content/' + encodeURIComponent(String(id)) : '#';
}
```

结论：

- 用户内容详情统一跳到：

```text
https://scratch-pad.echonlab.com/content/{content_id}
```

### 2.3 模板跳转链接

```javascript
function templateDetailUrl(id) {
  return id ? 'https://mgt.echonlab.com/app-project/ppe-env/content-templates/' + encodeURIComponent(String(id)) : '#';
}
```

结论：

- 模板详情统一跳到：

```text
https://mgt.echonlab.com/app-project/ppe-env/content-templates/{template_id}
```

## 3. 先做 schema-first，不要直接猜

每次新窗口都要先这样做：

1. 读 `mcp_posthog` 的 `exec.json`
2. 先 `search`
3. 再 `info read-data-schema`
4. 再 `info execute-sql`
5. 先用 `read-data-schema` 验证事件和属性
6. 最后再写 SQL

不要一上来就写 SQL 猜字段，尤其不要猜：

- `title`
- `content_title`
- `source_type`
- `template_id`

这些字段在 Catnip 当前埋点里经常不稳定。

## 4. 本项目里已经确认过的关键事件

### 4.1 用户内容榜单直接相关

- `ai_content_post`
- `ai_content_action`
- `share_result`

### 4.2 已确认可用的关键属性

#### `ai_content_post`

- `content_id`
- `usr_id`
- `device_id`
- `success`

#### `ai_content_action`

- `content_id`
- `usr_id`
- `action_type`

已确认 `action_type` 里有：

- `click_remix`
- `click_share`
- `click_header`
- `like`
- `comment`
- `click_create_and_post_from_panel`
- `click_edit`

做用户最强榜时，`remix_events` 的口径就是：

- `event = 'ai_content_action'`
- `properties.action_type = 'click_remix'`

#### `share_result`

- `content_id`
- `usr_id`
- `is_success`
- `share_type`
- `result`

做 `successful_share_count` 时，口径就是：

- `event = 'share_result'`
- `properties.is_success = true`

## 5. internal users 过滤

不要再找 `Cohorts Internal users` 的 cohort id 了，直接用 person 属性过滤就行。

已确认 person 侧可用字段：

- `person.properties.$internal_or_test_user`

推荐过滤写法：

```sql
AND NOT coalesce(person.properties['$internal_or_test_user'], false)
```

这比去追 cohort 稳定。

## 6. 用户 Top 50 推荐 SQL 口径

这是目前最稳的一版，用于拉 `7.30-8.5` 用户最强 Top 50：

```sql
WITH window_posts AS (
    SELECT
        properties.content_id AS content_id,
        countIf(event = 'ai_content_action' AND properties.action_type = 'click_remix') AS remix_events,
        uniqIf(person_id, event = 'ai_content_action' AND properties.action_type = 'click_remix') AS remix_users,
        countIf(event = 'share_result' AND properties.is_success = true) AS successful_share_count,
        countIf(event = 'ai_content_post' AND properties.success = 1) AS successful_post_count
    FROM events
    WHERE timestamp >= toDateTime('2026-07-30 00:00:00')
      AND timestamp < toDateTime('2026-08-06 00:00:00')
      AND event IN ('ai_content_post', 'ai_content_action', 'share_result')
      AND properties.content_id IS NOT NULL
      AND NOT coalesce(person.properties['$internal_or_test_user'], false)
    GROUP BY content_id
    HAVING successful_post_count > 0
    ORDER BY remix_events DESC, remix_users DESC, successful_share_count DESC, content_id ASC
    LIMIT 50
),
content_lifetime AS (
    SELECT
        properties.content_id AS content_id,
        min(timestamp) AS first_seen_at,
        max(timestamp) AS last_seen_at,
        argMaxIf(person.properties.display_name, timestamp, person.properties.display_name IS NOT NULL AND person.properties.display_name != '') AS creator_name,
        argMaxIf(properties.title, timestamp, properties.title IS NOT NULL AND properties.title != '') AS title,
        argMaxIf(properties.source_type, timestamp, properties.source_type IS NOT NULL AND properties.source_type != '') AS source_type,
        argMaxIf(properties.content_type, timestamp, properties.content_type IS NOT NULL AND properties.content_type != '') AS content_type
    FROM events
    WHERE timestamp >= toDateTime('2026-05-01 00:00:00')
      AND properties.content_id IN (SELECT content_id FROM window_posts)
    GROUP BY content_id
)
SELECT
    rowNumberInAllBlocks() AS rank,
    w.content_id AS content_id,
    coalesce(nullIf(c.title, ''), w.content_id) AS display_title,
    nullIf(c.source_type, '') AS source_type,
    nullIf(c.content_type, '') AS content_type,
    nullIf(c.creator_name, '') AS creator_name,
    c.first_seen_at AS created_at,
    dateDiff('day', toDate(c.first_seen_at), toDate('2026-08-05')) + 1 AS active_days,
    w.successful_post_count AS successful_post_count,
    w.remix_events AS remix_events,
    w.remix_users AS remix_users,
    w.successful_share_count AS successful_share_count,
    concat('https://scratch-pad.echonlab.com/content/', w.content_id) AS detail_url
FROM window_posts AS w
LEFT JOIN content_lifetime AS c ON c.content_id = w.content_id
ORDER BY w.remix_events DESC, w.remix_users DESC, w.successful_share_count DESC, w.content_id ASC
```

## 7. 当前真实限制

这部分很重要，新窗口里必须提前知道。

### 7.1 `title` 不稳定

虽然 SQL 里可以尝试：

- `properties.title`
- `properties.content_title`

但当前时间窗内大多数内容都拉不到稳定标题。

安全处理方式：

- `display_title` 回退成 `content_id`
- 如果要前端展示，再走网站里的 `shortId` 逻辑

### 7.2 `source_type` 不稳定

虽然有些事件定义里能看到：

- `upload_source_select.source_type`

但当前它的值更多是：

- `photos`
- `camera`

这不是“模板 / 用户原创”的稳定区分口径。

所以：

- 不要把 `upload_source_select.source_type` 直接当成最终内容来源
- 目前用户 Post Top 榜里，`source_type` 只能当“尽量补”，不能当强依赖字段

### 7.3 `content_type` 相对稳定

目前拉到的用户 Top 内容，`content_type` 基本稳定是：

- `game`

这个字段可以留，但信息量不如 `remix/share/active_days` 大。

## 8. 做网站数据对齐时的推荐顺序

1. 先看 `charts.js`
2. 找到网站卡片或表格最终使用的字段名
3. 用 `PostHog MCP` 验证事件和属性
4. 先拉小样本 `LIMIT 10`
5. 验证：
   - 有没有 internal/test user
   - 有没有 title
   - 有没有 source_type
   - active_days 算法是否合理
6. 再拉完整榜单
7. 最后再写飞书或同步网站

不要反过来。

## 9. active_days 口径

网站里 `active_days` 是很关键的归因字段，因为老内容天然会更容易累积更多 remix。

当前推荐两种算法：

### 9.1 生命周期天数

```sql
dateDiff('day', toDate(first_seen_at), toDate('结束日期')) + 1
```

适合：

- 看一条内容“存在了多久”
- 和历史榜单保持一致

### 9.2 时间窗内活跃天数

```sql
uniq(toDate(timestamp))
```

适合：

- 看这段窗口里它活跃了几天

如果做“最强 Top 50”，建议两个都区分清楚，别混着叫。

## 10. 飞书写回经验

长文档更新不要直接把完整 XML 当命令行参数传进去，容易截断。

错误做法：

```powershell
lark-cli docs +update --doc "..." --command overwrite --content "<很长的xml>"
```

正确做法：

```powershell
Get-Content -Raw 'xxx.xml' |
  lark-cli docs +update --doc "https://echonlab.feishu.cn/wiki/..." --command overwrite --content - --as user
```

结论：

- 整篇覆盖优先用 `stdin`
- 覆盖后要立刻 `fetch` 回读确认 revision 和正文

## 11. 这次实际产出的文件

- 用户 Top50 飞书 XML 成稿：[`posthog_user_top50_20260730_20260805.xml`](file:///c:/Users/msi/Desktop/Research/posthog_user_top50_20260730_20260805.xml)
- 本说明文档：[`posthog_website_data_runbook.md`](file:///c:/Users/msi/Desktop/Research/posthog_website_data_runbook.md)

## 12. 给新窗口的最短提示词

直接把下面这段发给新窗口即可：

```md
请先读取：
1. c:\Users\msi\Desktop\Research\template-metrics-20260730\assets\charts.js
2. c:\Users\msi\Desktop\Research\posthog_website_data_runbook.md

目标：
- 严格按网站现有字段口径拉取数据，不要自创指标名
- 先 schema-first 验证 PostHog 事件和属性，再写 SQL
- 用户 Post 榜单核心字段：content_id / active_days / remix_events / remix_users / successful_share_count / detail_url
- 用户内容跳转链接统一是 https://scratch-pad.echonlab.com/content/{content_id}
- internal users 用 person.properties['$internal_or_test_user'] 过滤
- 长 XML 写飞书时必须走 stdin overwrite，不要直接把整段 XML 放进命令行参数

如果 title/source_type 拉不到稳定值：
- title 回退成 content_id
- source_type 保留为空或写 -

先给出你将使用的事件、属性、SQL 口径，再开始正式拉数。
```

## 13. 再补一条经验

如果任务目标是“和网站完全一致”，优先级永远是：

1. 网站现有字段口径一致
2. 埋点真实可拉
3. 文档展示完整

不是反过来。

也就是说：

- 不要为了表格好看，硬编标题或来源字段
- 允许某些列暂时留空，但必须明确写清楚为什么空

