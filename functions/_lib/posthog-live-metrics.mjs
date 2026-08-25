const DEFAULT_HOST = "https://us.posthog.com";
const DEFAULT_PROJECT_ID = "425273";
const DEFAULT_START = "2026-08-01T00:00:00Z";
const FALLBACK_END = "2026-08-18T00:00:00Z";
const INTERNAL_COHORT_ID = 310528;
const USER_CONTENT_SOURCES = ["user_app", "content_template", "user_remix_app", "user_replace_app", "user_copy_app"];
const TEMPLATE_LINEAGE_SOURCES = ["content_template", "user_remix_app"];

function envValue(env, key) {
  return env && env[key] ? String(env[key]) : "";
}

function isoDate(value, fallback) {
  const date = value ? new Date(value) : new Date(fallback);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function defaultEndIso() {
  const date = new Date();
  if (Number.isNaN(date.getTime())) return FALLBACK_END;
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function sqlDate(value) {
  return isoDate(value, DEFAULT_START).slice(0, 19).replace("T", " ");
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function isTemplateIdLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanText(value));
}

function templateTitle(value, id) {
  const text = cleanText(value);
  if (!text) return "";
  if (id && text === String(id)) return "";
  return isTemplateIdLike(text) ? "" : text;
}

function rowObjects(response) {
  if (!response) return [];
  if (Array.isArray(response.results) && Array.isArray(response.columns)) {
    return response.results.map((row) => Object.fromEntries(response.columns.map((key, index) => [key, row[index]])));
  }
  if (Array.isArray(response.results) && response.results.every((item) => item && !Array.isArray(item) && typeof item === "object")) {
    return response.results;
  }
  return [];
}

function quotedList(values) {
  return values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(", ");
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 10 ? `${text.slice(0, 8)}...` : text;
}

function templateDetailUrl(id) {
  return id ? `https://mgt.echonlab.com/app-project/ppe-env/content-templates/${encodeURIComponent(String(id))}` : "#";
}

function contentDetailUrl(id) {
  return id ? `https://scratch-pad.echonlab.com/content/${encodeURIComponent(String(id))}` : "#";
}

function internalUserSubquery() {
  return `
    SELECT lower(toString(user_id))
    FROM postgres.app_user
    WHERE ifNull(is_internal, false) OR ifNull(is_internal_virtual_user, false)
  `;
}

function internalDeviceSubquery() {
  return `
    SELECT lower(toString(device_id))
    FROM postgres.user_devices
    WHERE lower(toString(user_id)) IN (${internalUserSubquery()})
  `;
}

function appEventFilter(from, to) {
  return `
    timestamp >= toDateTime('${from}')
    AND timestamp < toDateTime('${to}')
    AND properties.$lib IN ('posthog-ios', 'posthog-android')
    AND properties.app_env = 'ppe'
    AND properties.build_configuration = 'release'
    AND ifNull(toString(properties.channel_name), '') != 'testflight'
    AND person_id NOT IN (
      SELECT person_id
      FROM cohort_people
      WHERE cohort_id = ${INTERNAL_COHORT_ID}
    )
    AND lower(toString(properties.usr_id)) NOT IN (${internalUserSubquery()})
    AND lower(toString(properties.device_id)) NOT IN (${internalDeviceSubquery()})
  `;
}

function appEventHistoryFilter(to) {
  return `
    timestamp < toDateTime('${to}')
    AND properties.$lib IN ('posthog-ios', 'posthog-android')
    AND properties.app_env = 'ppe'
    AND properties.build_configuration = 'release'
    AND ifNull(toString(properties.channel_name), '') != 'testflight'
    AND person_id NOT IN (
      SELECT person_id
      FROM cohort_people
      WHERE cohort_id = ${INTERNAL_COHORT_ID}
    )
    AND lower(toString(properties.usr_id)) NOT IN (${internalUserSubquery()})
    AND lower(toString(properties.device_id)) NOT IN (${internalDeviceSubquery()})
  `;
}

function serverContentFilter(from, to) {
  return `
    g.created_at >= toDateTime('${from}')
    AND g.created_at < toDateTime('${to}')
    AND g.deleted_at IS NULL
    AND toString(g.source) IN (${quotedList(USER_CONTENT_SOURCES)})
    AND NOT ifNull(u.is_internal, false)
    AND NOT ifNull(u.is_internal_virtual_user, false)
  `;
}

function nonEmptySql(expression) {
  return `
    ${expression} IS NOT NULL
    AND toString(${expression}) != ''
    AND toString(${expression}) != '(null)'
    AND toString(${expression}) != '0'
  `;
}

function templateContentCtes(from, to) {
  return `
    template_content_raw AS (
      SELECT
        toString(g.id) AS content_id,
        toString(ct.template_id) AS template_id,
        lower(toString(g.user_id)) AS author_id,
        g.created_at AS created_at,
        if(toString(g.source) = 'content_template', 'template_create', 'template_remix') AS template_origin_type
      FROM postgres.game_tasks AS g
      INNER JOIN postgres.content_templates AS ct
        ON lower(toString(g.content_source_id)) = lower(toString(ct.template_id))
      LEFT JOIN postgres.app_user AS author
        ON lower(toString(g.user_id)) = lower(toString(author.user_id))
      WHERE toString(g.source) IN (${quotedList(TEMPLATE_LINEAGE_SOURCES)})
        AND g.created_at < toDateTime('${to}')
        AND g.deleted_at IS NULL
        AND ${nonEmptySql("g.content_source_id")}
        AND NOT ifNull(author.is_internal, false)
        AND NOT ifNull(author.is_internal_virtual_user, false)
    ),
    template_content AS (
      SELECT
        content_id,
        any(template_id) AS template_id,
        any(author_id) AS author_id,
        min(created_at) AS created_at
      FROM template_content_raw
      WHERE content_id != '' AND content_id != '(null)'
      GROUP BY content_id
    )
  `;
}

function templateShareEventsCte(from, to) {
  return `
    share_events AS (
      SELECT
        toString(e.properties.content_id) AS content_id,
        lower(toString(e.properties.usr_id)) AS sharer_id,
        e.timestamp AS share_at
      FROM events AS e
      LEFT JOIN postgres.app_user AS sharer
        ON lower(toString(e.properties.usr_id)) = lower(toString(sharer.user_id))
      WHERE e.timestamp >= toDateTime('${from}')
        AND e.timestamp < toDateTime('${to}')
        AND e.properties.$lib IN ('posthog-ios', 'posthog-android')
        AND e.properties.app_env = 'ppe'
        AND e.properties.build_configuration = 'release'
        AND ifNull(toString(e.properties.channel_name), '') != 'testflight'
        AND e.person_id NOT IN (
          SELECT person_id
          FROM cohort_people
          WHERE cohort_id = ${INTERNAL_COHORT_ID}
        )
        AND lower(toString(e.properties.usr_id)) NOT IN (${internalUserSubquery()})
        AND lower(toString(e.properties.device_id)) NOT IN (${internalDeviceSubquery()})
        AND toString(e.properties.usr_id) != ''
        AND toString(e.properties.usr_id) != '(null)'
        AND e.event = 'share_channel_click'
        AND ${nonEmptySql("e.properties.content_id")}
        AND NOT ifNull(sharer.is_internal, false)
        AND NOT ifNull(sharer.is_internal_virtual_user, false)
    )
  `;
}

function querySet(start, end) {
  const from = sqlDate(start);
  const to = sqlDate(end);
  const eventFilter = appEventFilter(from, to);
  const historyEventFilter = appEventHistoryFilter(to);
  const contentFilter = serverContentFilter(from, to);
  const validUsrId = "toString(properties.usr_id) != '' AND toString(properties.usr_id) != '(null)'";
  const templateIdFilter = "properties.template_id IS NOT NULL AND toString(properties.template_id) != '' AND toString(properties.template_id) != '(null)'";
  const templateContentSql = templateContentCtes(from, to);
  const templateShareEventsSql = templateShareEventsCte(from, to);

  return {
    templateClicks: `
      SELECT
        toString(properties.template_id) AS template_id,
        count() AS use_events,
        uniqIf(toString(properties.usr_id), ${validUsrId}) AS use_users,
        uniq(toDate(timestamp)) AS active_days,
        toString(min(toDate(timestamp))) AS first_click_day
      FROM events
      WHERE ${eventFilter}
        AND event = 'template_try_now_click'
        AND ${templateIdFilter}
      GROUP BY template_id
      ORDER BY use_events DESC
      LIMIT 500
    `,
    templateSuccess: `
      SELECT
        toString(properties.template_id) AS template_id,
        count() AS result_events,
        countIf(toString(properties.success) = '1') AS success_events,
        uniqIf(toString(properties.usr_id), toString(properties.success) = '1' AND ${validUsrId}) AS success_users
      FROM events
      WHERE ${eventFilter}
        AND event = 'template_try_now_result'
        AND ${templateIdFilter}
      GROUP BY template_id
      ORDER BY success_events DESC
      LIMIT 500
    `,
    templateRunWindow: `
      WITH scoped_runs AS (
        SELECT
          toString(r.template_id) AS template_id,
          toString(r.user_id) AS user_id,
          toString(r.status) AS run_status,
          toString(g.status) AS game_status
        FROM postgres.content_template_runs AS r
        INNER JOIN postgres.app_user AS au
          ON lower(toString(au.user_id)) = lower(toString(r.user_id))
        LEFT JOIN postgres.game_tasks AS g
          ON toString(g.id) = toString(r.game_id)
        WHERE r.run_type = 'user_run'
          AND r.created_at >= toDateTime('${from}')
          AND r.created_at < toDateTime('${to}')
          AND NOT ifNull(au.is_internal, false)
          AND NOT ifNull(au.is_internal_virtual_user, false)
      )
      SELECT
        template_id,
        count() AS window_usage_count,
        uniq(user_id) AS window_user_count,
        countIf(run_status = 'succeeded') AS window_success_count,
        countIf(run_status = 'failed') AS window_failure_count,
        countIf(game_status = 'published') AS window_published_count
      FROM scoped_runs
      GROUP BY template_id
      ORDER BY window_usage_count DESC
      LIMIT 500
    `,
    templateShares: `
      WITH
      ${templateContentSql},
      ${templateShareEventsSql}
      SELECT
        c.template_id AS template_id,
        uniqIf(s.sharer_id, s.content_id != '' AND s.sharer_id = c.author_id) AS template_self_share_users,
        uniqIf(s.sharer_id, s.content_id != '') AS template_all_share_users,
        countIf(s.content_id != '') AS template_share_channel_clicks,
        countIf(s.content_id != '' AND s.sharer_id = c.author_id) AS template_self_share_channel_clicks,
        uniqIf(c.content_id, c.created_at >= toDateTime('${from}') AND c.created_at < toDateTime('${to}')) AS template_created_contents,
        uniqIf(c.content_id, c.created_at >= toDateTime('${from}') AND c.created_at < toDateTime('${to}') AND s.share_at >= c.created_at AND s.share_at < toDateTime('${to}') AND s.sharer_id = c.author_id) AS template_self_shared_contents,
        uniqIf(c.content_id, c.created_at >= toDateTime('${from}') AND c.created_at < toDateTime('${to}') AND s.share_at >= c.created_at AND s.share_at < toDateTime('${to}')) AS template_all_shared_contents
      FROM template_content AS c
      LEFT JOIN share_events AS s
        ON s.content_id = c.content_id
      GROUP BY c.template_id
      ORDER BY template_all_shared_contents DESC, template_all_share_users DESC
      LIMIT 500
    `,
    templateShareOverview: `
      WITH
      ${templateContentSql},
      ${templateShareEventsSql}
      SELECT
        uniqIf(s.sharer_id, s.content_id != '' AND s.sharer_id = c.author_id) AS template_self_share_users,
        uniqIf(s.sharer_id, s.content_id != '') AS template_all_share_users,
        countIf(s.content_id != '') AS template_share_channel_clicks,
        countIf(s.content_id != '' AND s.sharer_id = c.author_id) AS template_self_share_channel_clicks,
        uniqIf(c.content_id, c.created_at >= toDateTime('${from}') AND c.created_at < toDateTime('${to}')) AS template_created_contents,
        uniqIf(c.content_id, c.created_at >= toDateTime('${from}') AND c.created_at < toDateTime('${to}') AND s.share_at >= c.created_at AND s.share_at < toDateTime('${to}') AND s.sharer_id = c.author_id) AS template_self_shared_contents,
        uniqIf(c.content_id, c.created_at >= toDateTime('${from}') AND c.created_at < toDateTime('${to}') AND s.share_at >= c.created_at AND s.share_at < toDateTime('${to}')) AS template_all_shared_contents
      FROM template_content AS c
      LEFT JOIN share_events AS s
        ON s.content_id = c.content_id
    `,
    eventOverview: `
      SELECT
        countIf(event = 'template_try_now_click') AS template_try_now_clicks,
        uniqIf(toString(properties.usr_id), event = 'template_try_now_click' AND ${validUsrId}) AS template_try_now_users,
        countIf(event = 'template_try_now_result') AS template_result_events,
        countIf(event = 'template_try_now_result' AND toString(properties.success) = '1') AS template_success_events,
        uniqIf(toString(properties.usr_id), event = 'template_try_now_result' AND toString(properties.success) = '1' AND ${validUsrId}) AS template_success_users,
        countIf(event = 'content_creation_submit') AS content_creation_submit,
        countIf(event = 'ai_content_post' AND toString(properties.success) = '1') AS post_success_events,
        uniqIf(toString(properties.usr_id), event = 'ai_content_post' AND toString(properties.success) = '1' AND ${validUsrId}) AS post_success_users,
        countIf(event = 'share_channel_click') AS share_channel_clicks,
        uniqIf(toString(properties.usr_id), event = 'share_channel_click' AND ${validUsrId}) AS share_channel_click_users
      FROM events
      WHERE ${eventFilter}
        AND event IN ('template_try_now_click', 'template_try_now_result', 'content_creation_submit', 'ai_content_post', 'share_channel_click')
    `,
    contentOverview: `
      SELECT
        count() AS total_contents,
        countIf(g.is_draft = false) AS published_contents,
        countIf(toString(g.source) IN (${quotedList(TEMPLATE_LINEAGE_SOURCES)}) AND ct.template_id IS NOT NULL) AS template_contents,
        countIf(toString(g.source) IN (${quotedList(TEMPLATE_LINEAGE_SOURCES)}) AND ct.template_id IS NOT NULL AND g.is_draft = false) AS template_published,
        countIf(toString(g.source) = 'content_template' AND ct.template_id IS NOT NULL) AS template_attributed_contents,
        countIf(toString(g.source) = 'content_template' AND ct.template_id IS NOT NULL AND g.is_draft = false) AS template_attributed_published,
        countIf(toString(g.source) = 'user_replace_app') AS ignored_user_replace_app_contents,
        countIf(toString(g.source) = 'user_replace_app' AND g.is_draft = false) AS ignored_user_replace_app_published,
        countIf(toString(g.source) = 'user_remix_app') AS remix_contents,
        countIf(toString(g.source) = 'user_remix_app' AND g.is_draft = false) AS remix_published
      FROM postgres.game_tasks AS g
      LEFT JOIN postgres.app_user AS u
        ON lower(toString(g.user_id)) = lower(toString(u.user_id))
      LEFT JOIN postgres.content_templates AS ct
        ON lower(toString(g.content_source_id)) = lower(toString(ct.template_id))
      WHERE ${contentFilter}
    `,
    templatePublish: `
      SELECT
        toString(ct.template_id) AS template_id,
        count() AS server_template_contents,
        countIf(g.is_draft = false) AS server_template_published,
        uniqIf(lower(toString(g.user_id)), toString(g.user_id) != '' AND toString(g.user_id) != '(null)') AS server_template_users,
        uniqIf(lower(toString(g.user_id)), g.is_draft = false AND toString(g.user_id) != '' AND toString(g.user_id) != '(null)') AS server_template_published_users
      FROM postgres.game_tasks AS g
      INNER JOIN postgres.content_templates AS ct
        ON lower(toString(g.content_source_id)) = lower(toString(ct.template_id))
      LEFT JOIN postgres.app_user AS u
        ON lower(toString(g.user_id)) = lower(toString(u.user_id))
      WHERE ${contentFilter}
        AND toString(g.source) IN (${quotedList(TEMPLATE_LINEAGE_SOURCES)})
        AND ${nonEmptySql("g.content_source_id")}
      GROUP BY template_id
      ORDER BY server_template_contents DESC
      LIMIT 500
    `,
    postOverviewRows: `
      SELECT
        g.id AS content_id,
        nullIf(g.title, '') AS title,
        toString(g.source) AS source_type,
        g.created_at AS created_at,
        ifNull(g.remix_count, 0) AS remix_events,
        ifNull(g.successful_share_count, 0) AS successful_share_count
      FROM postgres.game_tasks AS g
      LEFT JOIN postgres.app_user AS u
        ON lower(toString(g.user_id)) = lower(toString(u.user_id))
      WHERE ${contentFilter}
        AND g.is_draft = false
      ORDER BY remix_events DESC, successful_share_count DESC, g.created_at DESC
      LIMIT 50
    `,
    heatmap: `
      SELECT
        toString(toDate(timestamp)) AS day,
        multiIf(
          toHour(timestamp) < 6, 'late_night',
          toHour(timestamp) < 12, 'morning',
          toHour(timestamp) < 18, 'afternoon',
          'evening'
        ) AS day_part,
        count() AS remix_count
      FROM events
      WHERE ${eventFilter}
        AND event = 'template_try_now_click'
        AND ${templateIdFilter}
      GROUP BY day, day_part
      ORDER BY day, day_part
      LIMIT 500
    `,
    userOnlineTime: `
      SELECT
        toString(toDate(timestamp)) AS day,
        round(sum(toFloat(properties.time_interval)) / 60000.0, 1) AS total_online_minutes,
        count() AS recorded_interval_count
      FROM events
      WHERE ${historyEventFilter}
        AND event = 'ai_content_disappear'
        AND properties.time_interval IS NOT NULL
        AND toString(properties.time_interval) != ''
        AND toString(properties.time_interval) != '(null)'
        AND toFloat(properties.time_interval) > 0
        AND toFloat(properties.time_interval) <= 1800000
      GROUP BY day
      ORDER BY day
      LIMIT 500
    `,
    templatePublishTimeline: `
      SELECT
        toString(ct.template_id) AS template_id,
        nullIf(ct.title, '') AS template_name,
        toString(ct.status) AS status,
        toString(ct.mode) AS mode,
        toString(ct.published_at) AS published_at,
        toString(toDate(ct.published_at)) AS publish_day,
        toHour(ct.published_at) AS publish_hour
      FROM postgres.content_templates AS ct
      WHERE ct.status = 'published'
        AND ct.published_at < toDateTime('${to}')
        AND ct.template_id IS NOT NULL
        AND toString(ct.template_id) != ''
        AND toString(ct.template_id) != '(null)'
      ORDER BY ct.published_at
      LIMIT 500
    `,
    templateRunLifetime: `
      WITH scoped_runs AS (
        SELECT
          toString(r.template_id) AS template_id,
          toString(r.user_id) AS user_id,
          toString(r.status) AS run_status,
          toString(g.status) AS game_status
        FROM postgres.content_template_runs AS r
        INNER JOIN postgres.app_user AS au
          ON lower(toString(au.user_id)) = lower(toString(r.user_id))
        LEFT JOIN postgres.game_tasks AS g
          ON toString(g.id) = toString(r.game_id)
        WHERE r.run_type = 'user_run'
          AND NOT ifNull(au.is_internal, false)
          AND NOT ifNull(au.is_internal_virtual_user, false)
      ),
      metrics AS (
        SELECT
          template_id,
          count() AS usage_count,
          uniq(user_id) AS user_count,
          countIf(run_status = 'succeeded') AS success_count,
          countIf(run_status = 'failed') AS failure_count,
          countIf(game_status = 'published') AS published_count
        FROM scoped_runs
        GROUP BY template_id
      )
      SELECT
        toString(ct.template_id) AS template_id,
        nullIf(ct.title, '') AS template_name,
        toString(ct.status) AS template_status,
        toString(ct.mode) AS template_mode,
        toString(ct.created_at) AS created_at,
        toString(ct.published_at) AS published_at,
        ifNull(m.usage_count, 0) AS usage_count,
        ifNull(m.user_count, 0) AS user_count,
        ifNull(m.success_count, 0) AS success_count,
        ifNull(m.failure_count, 0) AS failure_count,
        ifNull(m.published_count, 0) AS published_count
      FROM postgres.content_templates AS ct
      LEFT JOIN metrics AS m
        ON m.template_id = toString(ct.template_id)
      WHERE ct.template_id IS NOT NULL
        AND toString(ct.template_id) != ''
        AND toString(ct.template_id) != '(null)'
      ORDER BY usage_count DESC, ct.created_at DESC, template_id DESC
      LIMIT 1000
    `,
  };
}

async function posthogQuery(env, sql, name) {
  const host = envValue(env, "POSTHOG_HOST") || DEFAULT_HOST;
  const projectId = envValue(env, "POSTHOG_PROJECT_ID") || DEFAULT_PROJECT_ID;
  const key = envValue(env, "POSTHOG_PERSONAL_API_KEY");
  if (!key) {
    const error = new Error("Missing POSTHOG_PERSONAL_API_KEY");
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${host.replace(/\/$/, "")}/api/projects/${projectId}/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: sql.trim(),
      },
      name,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.detail || payload.error || `PostHog query failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return rowObjects(payload);
}

function onlineDaysInWindow(publishedAt, firstClickAt, start, end) {
  const startDay = Date.parse(`${String(start).slice(0, 10)}T00:00:00Z`);
  const endDay = Date.parse(`${String(end).slice(0, 10)}T00:00:00Z`);
  const publishedDay = Date.parse(`${String(publishedAt || "").slice(0, 10)}T00:00:00Z`);
  const firstClickDay = Date.parse(`${String(firstClickAt || "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay) || endDay <= startDay) return 0;
  const observedStarts = [publishedDay, firstClickDay].filter(Number.isFinite);
  const observedStart = observedStarts.length ? Math.min(...observedStarts) : startDay;
  const onlineStart = Math.max(startDay, observedStart);
  return Math.max(0, Math.round((endDay - onlineStart) / 86400000));
}

function mergeByTemplate(clickRows, successRows, windowRunRows, shareRows, templatePublishRows, publishedTemplateRows = [], start, end) {
  const byId = new Map();
  function get(id) {
    if (!id) return null;
    if (!byId.has(id)) byId.set(id, { template_id: id, template_name: id });
    return byId.get(id);
  }

  publishedTemplateRows.forEach((row) => {
    const item = get(row.template_id);
    if (!item) return;
    item.template_name = templateTitle(row.template_name, row.template_id) || templateTitle(item.template_name, row.template_id) || row.template_id;
    item.template_status = row.status || "";
    item.template_mode = row.mode || "";
    item.published_at = row.published_at || "";
    item.publish_day = row.publish_day || "";
    item.publish_hour = number(row.publish_hour);
  });
  clickRows.forEach((row) => {
    const item = get(row.template_id);
    if (!item) return;
    item.use_events = number(row.use_events);
    item.use_users = number(row.use_users);
    item.template_remix_events = item.use_events;
    item.template_remix_users = item.use_users;
    item.active_days = number(row.active_days);
    item.first_click_day = row.first_click_day || "";
  });
  successRows.forEach((row) => {
    const item = get(row.template_id);
    if (!item) return;
    item.result_events = number(row.result_events);
    item.success_events = number(row.success_events);
    item.success_users = number(row.success_users);
  });
  windowRunRows.forEach((row) => {
    const item = get(row.template_id);
    if (!item) return;
    item.window_usage_count = number(row.window_usage_count);
    item.window_user_count = number(row.window_user_count);
    item.window_success_count = number(row.window_success_count);
    item.window_failure_count = number(row.window_failure_count);
    item.window_published_count = number(row.window_published_count);
  });
  shareRows.forEach((row) => {
    const item = get(row.template_id);
    if (!item) return;
    item.template_self_share_users = number(row.template_self_share_users);
    item.template_all_share_users = number(row.template_all_share_users);
    item.template_share_channel_clicks = number(row.template_share_channel_clicks);
    item.template_self_share_channel_clicks = number(row.template_self_share_channel_clicks);
    item.template_created_contents = number(row.template_created_contents);
    item.template_self_shared_contents = number(row.template_self_shared_contents);
    item.template_all_shared_contents = number(row.template_all_shared_contents);
  });
  templatePublishRows.forEach((row) => {
    const item = get(row.template_id);
    if (!item) return;
    item.server_template_contents = number(row.server_template_contents);
    item.server_template_published = number(row.server_template_published);
    item.server_template_users = number(row.server_template_users);
    item.server_template_published_users = number(row.server_template_published_users);
    item.successful_post_count = item.server_template_published;
    item.successful_post_users = item.server_template_published_users;
  });

  return Array.from(byId.values()).map((item) => {
    item.use_events = number(item.use_events);
    item.use_users = number(item.use_users);
    item.template_remix_events = number(item.template_remix_events);
    item.template_remix_users = number(item.template_remix_users);
    item.success_events = number(item.success_events);
    item.result_events = number(item.result_events);
    item.success_users = number(item.success_users);
    item.window_usage_count = number(item.window_usage_count);
    item.window_user_count = number(item.window_user_count);
    item.window_success_count = number(item.window_success_count);
    item.window_failure_count = number(item.window_failure_count);
    item.window_published_count = number(item.window_published_count);
    item.window_publish_conversion_rate = rate(item.window_published_count, item.window_usage_count);
    item.successful_post_count = number(item.successful_post_count);
    item.successful_post_users = number(item.successful_post_users);
    item.successful_share_count = number(item.successful_share_count);
    item.successful_share_users = number(item.successful_share_users);
    item.share_result_events = number(item.share_result_events);
    item.valid_share_attempts = number(item.valid_share_attempts);
    item.template_self_share_users = number(item.template_self_share_users);
    item.template_all_share_users = number(item.template_all_share_users);
    item.template_share_channel_clicks = number(item.template_share_channel_clicks);
    item.template_self_share_channel_clicks = number(item.template_self_share_channel_clicks);
    item.template_created_contents = number(item.template_created_contents);
    item.template_self_shared_contents = number(item.template_self_shared_contents);
    item.template_all_shared_contents = number(item.template_all_shared_contents);
    item.server_template_contents = number(item.server_template_contents);
    item.server_template_published = number(item.server_template_published);
    item.server_template_users = number(item.server_template_users);
    item.server_template_published_users = number(item.server_template_published_users);
    item.click_active_days = number(item.active_days);
    item.online_days = onlineDaysInWindow(item.published_at || item.publish_day, item.first_click_day, start, end);
    item.speed_denominator_days = item.online_days;
    item.gen_success_rate_1d = item.result_events ? item.success_events / item.result_events : (item.use_events ? item.success_events / item.use_events : 0);
    item.post_rate_1d = item.server_template_contents ? item.server_template_published / item.server_template_contents : 0;
    item.template_self_share_content_rate = rate(item.template_self_shared_contents, item.template_created_contents);
    item.template_all_share_content_rate = rate(item.template_all_shared_contents, item.template_created_contents);
    item.self_share_users = item.template_self_share_users;
    item.all_share_users = item.template_all_share_users;
    item.share_users = item.template_all_share_users;
    item.share_denominator = item.template_created_contents;
    item.share_rate_1d = item.template_all_share_content_rate;
    item.template_post_remix_events = item.server_template_published;
    item.template_remix_events_per_day = item.speed_denominator_days ? item.template_remix_events / item.speed_denominator_days : 0;
    item.metric_source = "window_template_lineage_plus_client_template_funnel_and_content_share";
    return item;
  }).sort((a, b) => b.template_remix_events - a.template_remix_events || b.success_users - a.success_users);
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function mapTemplateRunLifetimeRows(rows) {
  const sorted = rows.map((row) => {
    const usageCount = number(row.usage_count);
    const userCount = number(row.user_count);
    const successCount = number(row.success_count);
    const failureCount = number(row.failure_count);
    const publishedCount = number(row.published_count);
    const terminalRunCount = successCount + failureCount;
    return {
      template_id: row.template_id,
      template_name: templateTitle(row.template_name, row.template_id) || row.template_id,
      template_status: row.template_status || "",
      template_mode: row.template_mode || "",
      created_at: row.created_at || "",
      published_at: row.published_at || "",
      usage_count: usageCount,
      user_count: userCount,
      success_count: successCount,
      failure_count: failureCount,
      terminal_run_count: terminalRunCount,
      published_count: publishedCount,
      success_denominator: terminalRunCount,
      publish_denominator: usageCount,
      success_rate: rate(successCount, terminalRunCount),
      publish_conversion_rate: rate(publishedCount, usageCount),
      template_remix_events: usageCount,
      template_remix_users: userCount,
      success_events: successCount,
      successful_post_count: publishedCount,
      post_after_success_rate: rate(publishedCount, usageCount),
      metric_source: "content_template_runs.user_run_external_lifetime",
      template_metric_scope: "external",
      template_metric_window: "lifetime",
      published_count_is_exact: true,
      has_template_run_lifetime: true,
    };
  }).sort((a, b) => (
    b.usage_count - a.usage_count
      || String(b.created_at || "").localeCompare(String(a.created_at || ""))
      || String(b.template_id || "").localeCompare(String(a.template_id || ""))
  ));

  let denseRank = 0;
  let previousUsage = null;
  return sorted.map((item) => {
    if (previousUsage === null || item.usage_count !== previousUsage) {
      denseRank += 1;
      previousUsage = item.usage_count;
    }
    return { ...item, usage_rank: denseRank };
  });
}

export async function buildTemplateMetricsSource(env) {
  const sql = querySet(DEFAULT_START, defaultEndIso()).templateRunLifetime;
  const sourceRows = await posthogQuery(env, sql, "template run lifetime metrics");
  const rows = mapTemplateRunLifetimeRows(sourceRows);
  const templateNames = {};

  rows.forEach((item) => {
    const title = templateTitle(item.template_name, item.template_id);
    if (title) templateNames[item.template_id] = title;
  });

  return {
    source: "posthog-api-template-metrics",
    generated_at: new Date().toISOString(),
    TEMPLATE_RUN_LIFETIME_ROWS: rows,
    TEMPLATE_NAMES: templateNames,
    API_TRACE: {
      host: envValue(env, "POSTHOG_HOST") || DEFAULT_HOST,
      project_id: envValue(env, "POSTHOG_PROJECT_ID") || DEFAULT_PROJECT_ID,
      template_metric_scope: "external",
      template_metric_window: "lifetime",
      template_run_lifetime_source: "postgres.content_template_runs run_type=user_run joined to app_user; success=succeeded/(succeeded+failed); publish=game_tasks.status published/all user_run",
    },
  };
}

function mapPostRows(rows, end) {
  const endDay = new Date(Date.parse(end) - 86400000).toISOString().slice(0, 10);
  return rows.map((row) => {
    const contentId = row.content_id;
    const title = row.title || shortId(contentId);
    const createdAt = row.created_at || "";
    const createdDay = String(createdAt).slice(0, 10);
    const activeDays = createdDay
      ? Math.max(1, Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${createdDay}T00:00:00Z`)) / 86400000) + 1)
      : 0;
    const remixEvents = number(row.remix_events);
    const shareCount = number(row.successful_share_count);
    return {
      board: "post",
      board_label: "用户",
      title,
      subtitle: `${shortId(contentId)} · ${row.source_type || "server content"}`,
      url: contentDetailUrl(contentId),
      total_value: remixEvents,
      template_success_users: 0,
      template_post_remix: 0,
      post_remix: remixEvents,
      detail_text: `服务端发布内容 · 分享 ${shareCount} · 创建 ${createdDay || "-"}`,
      active_days: activeDays,
      content_id: contentId,
      remix_events: remixEvents,
      remix_users: 0,
      successful_share_count: shareCount,
      created_at: createdAt,
      source_type: row.source_type || "",
    };
  });
}

function mapTemplateOverviewRows(rows) {
  return rows.map((item) => ({
    template_id: item.template_id,
    template_name: item.template_name,
    board: "template",
    board_label: "模板",
    title: item.template_name,
    subtitle: `${shortId(item.template_id)} · 服务端发布率 ${Math.round(rate(item.server_template_published, item.server_template_contents) * 100)}%`,
    url: templateDetailUrl(item.template_id),
    total_value: number(item.server_template_contents) || number(item.template_remix_events),
    template_success_users: number(item.success_users),
    template_post_remix: number(item.server_template_published),
    template_remix_events: number(item.template_remix_events),
    template_remix_users: number(item.template_remix_users),
    template_all_share_users: number(item.template_all_share_users),
    template_all_shared_contents: number(item.template_all_shared_contents),
    template_created_contents: number(item.template_created_contents),
    template_all_share_content_rate: number(item.template_all_share_content_rate),
    post_remix: 0,
    detail_text: `try-now 成功 ${number(item.success_events)} · 发布 ${number(item.server_template_published)} / ${number(item.server_template_contents)} · 分享 ${number(item.template_all_shared_contents)} / ${number(item.template_created_contents)}`,
    active_days: number(item.active_days),
  }));
}

export async function buildMetricsSource(env, options = {}) {
  const start = isoDate(options.start || envValue(env, "POSTHOG_METRICS_START"), DEFAULT_START);
  const end = isoDate(options.end || envValue(env, "POSTHOG_METRICS_END"), defaultEndIso());
  const queries = querySet(start, end);

  const [
    clickRows,
    successRows,
    windowRunRows,
    shareRows,
    eventOverviewRows,
    contentOverviewRows,
    templateShareOverviewRows,
    templatePublishRows,
    postRows,
    heatmapRows,
    onlineTimeRows,
    publishTimelineRows,
  ] = await Promise.all([
    posthogQuery(env, queries.templateClicks, "template click rows"),
    posthogQuery(env, queries.templateSuccess, "template success rows"),
    posthogQuery(env, queries.templateRunWindow, "window template run rows"),
    posthogQuery(env, queries.templateShares, "template share rows"),
    posthogQuery(env, queries.eventOverview, "event overview totals"),
    posthogQuery(env, queries.contentOverview, "server content overview totals"),
    posthogQuery(env, queries.templateShareOverview, "template share overview"),
    posthogQuery(env, queries.templatePublish, "server template publish rows"),
    posthogQuery(env, queries.postOverviewRows, "server post overview rows"),
    posthogQuery(env, queries.heatmap, "activity heatmap"),
    posthogQuery(env, queries.userOnlineTime, "user online time"),
    posthogQuery(env, queries.templatePublishTimeline, "template publish timeline"),
  ]);

  const eventOverview = eventOverviewRows[0] || {};
  const contentOverview = contentOverviewRows[0] || {};
  const templateShareOverview = templateShareOverviewRows[0] || {};
  const rows = mergeByTemplate(clickRows, successRows, windowRunRows, shareRows, templatePublishRows, publishTimelineRows, start, end);
  const publishedTemplateMeta = publishTimelineRows.map((row) => ({
    template_id: row.template_id,
    title: templateTitle(row.template_name, row.template_id) || row.template_id,
    status: row.status,
    mode: row.mode,
    published_at: row.published_at,
    publish_day: row.publish_day,
    publish_hour: number(row.publish_hour),
  }));
  const templateNames = {};
  publishedTemplateMeta.forEach((item) => {
    const title = templateTitle(item.title, item.template_id);
    if (title) templateNames[item.template_id] = title;
  });
  rows.forEach((item) => {
    const title = templateTitle(item.template_name, item.template_id);
    if (title && !templateNames[item.template_id]) templateNames[item.template_id] = title;
  });
  const successUsers = number(eventOverview.template_success_users);
  const serverTemplateContents = number(contentOverview.template_contents);
  const serverTemplatePublished = number(contentOverview.template_published);
  const templateShareCreatedContents = number(templateShareOverview.template_created_contents);
  const templateSelfSharedContents = number(templateShareOverview.template_self_shared_contents);
  const templateAllSharedContents = number(templateShareOverview.template_all_shared_contents);
  const templateSelfShareRate = rate(templateSelfSharedContents, templateShareCreatedContents);
  const templateAllShareRate = rate(templateAllSharedContents, templateShareCreatedContents);
  const postOverviewRows = mapPostRows(postRows, end);
  const overviewMix = mapTemplateOverviewRows(rows).concat(postOverviewRows)
    .sort((a, b) => number(b.total_value) - number(a.total_value) || String(a.title || "").localeCompare(String(b.title || "")))
    .slice(0, 50)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    source: "posthog-api",
    generated_at: new Date().toISOString(),
    windowLabel: `${start.slice(0, 10)} 至 ${new Date(Date.parse(end) - 86400000).toISOString().slice(0, 10)}`,
    rows,
    TEMPLATE_OVERVIEW_ROWS: rows,
    PUBLISHED_TEMPLATE_META: publishedTemplateMeta,
    TEMPLATE_NAMES: templateNames,
    POST_OVERVIEW_ROWS: postOverviewRows,
    OVERVIEW_MIX_TOP50: overviewMix,
    OVERVIEW_TOTALS: {
      template_total: serverTemplateContents,
      post_total: Math.max(0, number(contentOverview.total_contents) - serverTemplateContents),
      template_post_remix: number(contentOverview.remix_contents),
    },
    SITE_TOTALS: {
      content_creation_submit: number(contentOverview.total_contents),
      client_content_creation_submit: number(eventOverview.content_creation_submit),
    },
    CONTENT_PUBLISH_STATS: {
      total_contents: number(contentOverview.total_contents),
      published_contents: number(contentOverview.published_contents),
      publish_rate_pct: rate(number(contentOverview.published_contents), number(contentOverview.total_contents)) * 100,
      template_contents: serverTemplateContents,
      template_published: serverTemplatePublished,
      template_publish_rate_pct: rate(serverTemplatePublished, serverTemplateContents) * 100,
      template_attributed_contents: number(contentOverview.template_attributed_contents),
      template_attributed_published: number(contentOverview.template_attributed_published),
      ignored_user_replace_app_contents: number(contentOverview.ignored_user_replace_app_contents),
      ignored_user_replace_app_published: number(contentOverview.ignored_user_replace_app_published),
      remix_contents: number(contentOverview.remix_contents),
      remix_published: number(contentOverview.remix_published),
      remix_publish_rate_pct: rate(number(contentOverview.remix_published), number(contentOverview.remix_contents)) * 100,
      source: "postgres.game_tasks",
      internal_filter: "postgres.app_user is_internal/is_internal_virtual_user",
    },
    CONVERSION_STATS: {
      success_users: serverTemplateContents,
      successful_post_users: serverTemplatePublished,
      post_rate_pct: rate(serverTemplatePublished, serverTemplateContents) * 100,
      successful_share_users: number(templateShareOverview.template_all_share_users),
      share_rate_pct: templateAllShareRate * 100,
      template_self_share_users: number(templateShareOverview.template_self_share_users),
      template_all_share_users: number(templateShareOverview.template_all_share_users),
      template_created_contents: templateShareCreatedContents,
      template_self_shared_contents: templateSelfSharedContents,
      template_all_shared_contents: templateAllSharedContents,
      template_self_share_content_rate_pct: templateSelfShareRate * 100,
      template_all_share_content_rate_pct: templateAllShareRate * 100,
    },
    TEMPLATE_SHARE_STATS: {
      template_self_share_users: number(templateShareOverview.template_self_share_users),
      template_all_share_users: number(templateShareOverview.template_all_share_users),
      template_share_channel_clicks: number(templateShareOverview.template_share_channel_clicks),
      template_self_share_channel_clicks: number(templateShareOverview.template_self_share_channel_clicks),
      template_created_contents: templateShareCreatedContents,
      template_self_shared_contents: templateSelfSharedContents,
      template_all_shared_contents: templateAllSharedContents,
      template_self_share_content_rate_pct: templateSelfShareRate * 100,
      template_all_share_content_rate_pct: templateAllShareRate * 100,
      source: "share_channel_click + game_tasks.content_source_id template bloodline",
      denominator: "template-system content created in selected window",
    },
    DATA_QUALITY: {
      app_event_scope: "iOS + Android App release",
      template_click_scope: "iOS only until Android template click/show events ship",
      client_event_ingestion_gaps: [
        {
          start: "2026-08-09",
          end: "2026-08-12",
          label: "PostHog 客户端事件采集缺口",
        },
      ],
      server_metrics_affected: false,
    },
    LIVE_CONVERSION_DIAGNOSTICS: {
      success_users: successUsers,
      client_template_click_users: number(eventOverview.template_try_now_users),
      client_template_result_events: number(eventOverview.template_result_events),
      client_template_success_events: number(eventOverview.template_success_events),
      server_template_contents: serverTemplateContents,
      server_template_published: serverTemplatePublished,
      server_template_publish_rate_pct: rate(serverTemplatePublished, serverTemplateContents) * 100,
      share_channel_clicks: number(eventOverview.share_channel_clicks),
      share_channel_click_users: number(eventOverview.share_channel_click_users),
      template_share_channel_clicks: number(templateShareOverview.template_share_channel_clicks),
      template_self_share_channel_clicks: number(templateShareOverview.template_self_share_channel_clicks),
      template_share_rate_denominator: templateShareCreatedContents,
      template_self_share_content_rate_pct: templateSelfShareRate * 100,
      template_all_share_content_rate_pct: templateAllShareRate * 100,
    },
    HEADLINE: {
      template_users_30d: successUsers,
      gen_success_rate_1d: rate(number(eventOverview.template_success_events), number(eventOverview.template_result_events)),
      post_after_success_rate: rate(serverTemplatePublished, serverTemplateContents),
      share_rate_1d: templateAllShareRate,
    },
    ACTIVITY_HEATMAP_ROWS: heatmapRows.map((row) => ({
      day: row.day,
      day_part: row.day_part,
      remix_count: number(row.remix_count),
    })),
    USER_ONLINE_TIME_ROWS: onlineTimeRows.map((row) => ({
      day: row.day,
      total_online_minutes: number(row.total_online_minutes),
      recorded_interval_count: number(row.recorded_interval_count),
    })),
    TEMPLATE_PUBLISH_TIMELINE_ROWS: publishTimelineRows.map((row) => ({
      template_id: row.template_id,
      template_name: templateTitle(row.template_name, row.template_id) || row.template_id,
      status: row.status,
      mode: row.mode,
      published_at: row.published_at,
      publish_day: row.publish_day,
      publish_hour: number(row.publish_hour),
    })),
    API_TRACE: {
      host: envValue(env, "POSTHOG_HOST") || DEFAULT_HOST,
      project_id: envValue(env, "POSTHOG_PROJECT_ID") || DEFAULT_PROJECT_ID,
      start,
      end,
      event_scope: "App only: $lib IN posthog-ios/posthog-android, app_env=ppe, build_configuration=release, channel_name != testflight; template click/show events are currently iOS-only",
      internal_filter: `lower(usr_id/device_id) matched to server app_user/user_devices + cohort_people cohort_id=${INTERNAL_COHORT_ID}`,
      content_source: `postgres.game_tasks with deleted_at IS NULL, user source whitelist (${USER_CONTENT_SOURCES.join(", ")}), app_user internal exclusions`,
      online_time_source: "all recorded App release ai_content_disappear.time_interval through selected end; daily sum in minutes; external users; positive intervals <= 30 minutes",
      template_publish_source: "postgres.content_templates status=published published_at",
      template_run_lifetime_source: "served independently by /api/template-metrics",
      template_run_window_source: "postgres.content_template_runs run_type=user_run created in selected window; external users; publish conversion=game_tasks.status published/all window user_run",
      template_share_metric: "share_channel_click joined by content_id to template-system content whose game_tasks.content_source_id matches content_templates.template_id and source is content_template or user_remix_app; content ratio denominator is created template-system content in the selected window",
      queries,
      docs: [
        "analytics-metrics skill §5.6",
        "template-metrics-and-game-task-sources.md",
        "template-content-sharing-metrics.md",
        "PostHog dashboard 1995665",
      ],
      caveats: [
        "2026-08-09 to 2026-08-12 has a known PostHog event-ingestion gap; server game_tasks content counts remain the preferred content source.",
        "Template-system content is lineage-based: content_template and user_remix_app rows whose content_source_id matches content_templates.template_id. user_replace_app has no template lineage and is excluded from template metrics while remaining in all-user-content totals.",
        "Template share attribution only counts share_channel_click events with content_id; clicks without content_id cannot be joined back to template-system content.",
        "template_try_now_click/template_click/template_show are currently iOS-only; Android coverage will create a measurement step-change when released.",
        "Client template funnel users use usr_id, not person_id. TCS remains separate from these overview/template definitions.",
      ],
    },
  };
}
