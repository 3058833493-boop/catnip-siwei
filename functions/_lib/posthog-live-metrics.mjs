const DEFAULT_HOST = "https://us.posthog.com";
const DEFAULT_PROJECT_ID = "425273";
const DEFAULT_START = "2026-08-01T00:00:00Z";
const DEFAULT_END = "2026-08-18T00:00:00Z";
const INTERNAL_COHORT_ID = 310528;
const TEMPLATE_SOURCES = ["content_template"];
const EXCLUDED_CONTENT_SOURCES = ["content_studio", "workbench", "admin", "eval", "github_import"];

function envValue(env, key) {
  return env && env[key] ? String(env[key]) : "";
}

function isoDate(value, fallback) {
  const date = value ? new Date(value) : new Date(fallback);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function sqlDate(value) {
  return isoDate(value, DEFAULT_START).slice(0, 19).replace("T", " ");
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
    SELECT toString(device_id)
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
    AND toString(properties.device_id) NOT IN (${internalDeviceSubquery()})
  `;
}

function serverContentFilter(from, to) {
  return `
    g.created_at >= toDateTime('${from}')
    AND g.created_at < toDateTime('${to}')
    AND g.deleted_at IS NULL
    AND toString(g.source) NOT IN (${quotedList(EXCLUDED_CONTENT_SOURCES)})
    AND NOT ifNull(u.is_internal, false)
    AND NOT ifNull(u.is_internal_virtual_user, false)
  `;
}

function querySet(start, end) {
  const from = sqlDate(start);
  const to = sqlDate(end);
  const eventFilter = appEventFilter(from, to);
  const contentFilter = serverContentFilter(from, to);
  const validUsrId = "toString(properties.usr_id) != '' AND toString(properties.usr_id) != '(null)'";
  const shareSuccess = "toString(properties.is_success) IN ('true', '1')";
  const shareValidAttempt = "toString(properties.is_valid_attempt) IN ('true', '1')";
  const templateIdFilter = "properties.template_id IS NOT NULL AND toString(properties.template_id) != '' AND toString(properties.template_id) != '(null)'";

  return {
    templateClicks: `
      SELECT
        toString(properties.template_id) AS template_id,
        count() AS use_events,
        uniqIf(toString(properties.usr_id), ${validUsrId}) AS use_users,
        uniq(toDate(timestamp)) AS active_days
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
    templateShares: `
      SELECT
        toString(properties.template_id) AS template_id,
        count() AS share_result_events,
        countIf(${shareSuccess}) AS successful_share_count,
        uniqIf(toString(properties.usr_id), ${shareSuccess} AND ${validUsrId}) AS successful_share_users,
        countIf(${shareValidAttempt}) AS valid_share_attempts
      FROM events
      WHERE ${eventFilter}
        AND event = 'share_result'
        AND ${templateIdFilter}
      GROUP BY template_id
      ORDER BY successful_share_users DESC
      LIMIT 500
    `,
    repeatUsers: `
      SELECT
        template_id,
        countIf(successes >= 2) AS repeat_success_users,
        sum(if(successes >= 2, successes - 1, 0)) AS repeat_success_extra_events,
        sum(successes) AS success_events_for_replay
      FROM (
        SELECT
          toString(properties.template_id) AS template_id,
          toString(properties.usr_id) AS usr_id,
          count() AS successes
        FROM events
        WHERE ${eventFilter}
          AND event = 'template_try_now_result'
          AND toString(properties.success) = '1'
          AND ${templateIdFilter}
          AND ${validUsrId}
        GROUP BY template_id, usr_id
      )
      GROUP BY template_id
      ORDER BY repeat_success_extra_events DESC
      LIMIT 500
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
        countIf(event = 'share_result' AND ${shareSuccess}) AS share_success_events,
        uniqIf(toString(properties.usr_id), event = 'share_result' AND ${shareSuccess} AND ${validUsrId}) AS share_success_users,
        countIf(event = 'share_result') AS share_result_events,
        countIf(event = 'share_result' AND ${shareValidAttempt}) AS valid_share_attempts
      FROM events
      WHERE ${eventFilter}
        AND event IN ('template_try_now_click', 'template_try_now_result', 'content_creation_submit', 'ai_content_post', 'share_result')
    `,
    contentOverview: `
      SELECT
        count() AS total_contents,
        countIf(g.is_draft = false) AS published_contents,
        countIf(toString(g.source) IN (${quotedList(TEMPLATE_SOURCES)})) AS template_contents,
        countIf(toString(g.source) IN (${quotedList(TEMPLATE_SOURCES)}) AND g.is_draft = false) AS template_published,
        countIf(toString(g.source) = 'content_template') AS template_attributed_contents,
        countIf(toString(g.source) = 'content_template' AND g.is_draft = false) AS template_attributed_published,
        countIf(toString(g.source) = 'user_replace_app') AS ignored_user_replace_app_contents,
        countIf(toString(g.source) = 'user_replace_app' AND g.is_draft = false) AS ignored_user_replace_app_published,
        countIf(toString(g.source) = 'user_remix_app') AS remix_contents,
        countIf(toString(g.source) = 'user_remix_app' AND g.is_draft = false) AS remix_published
      FROM postgres.game_tasks AS g
      LEFT JOIN postgres.app_user AS u
        ON lower(toString(g.user_id)) = lower(toString(u.user_id))
      WHERE ${contentFilter}
    `,
    templatePublish: `
      SELECT
        toString(g.content_source_id) AS template_id,
        count() AS server_template_contents,
        countIf(g.is_draft = false) AS server_template_published,
        uniqIf(lower(toString(g.user_id)), toString(g.user_id) != '' AND toString(g.user_id) != '(null)') AS server_template_users,
        uniqIf(lower(toString(g.user_id)), g.is_draft = false AND toString(g.user_id) != '' AND toString(g.user_id) != '(null)') AS server_template_published_users
      FROM postgres.game_tasks AS g
      LEFT JOIN postgres.app_user AS u
        ON lower(toString(g.user_id)) = lower(toString(u.user_id))
      WHERE ${contentFilter}
        AND toString(g.source) = 'content_template'
        AND g.content_source_id IS NOT NULL
        AND toString(g.content_source_id) != ''
        AND toString(g.content_source_id) != '(null)'
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
        round(sumIf(toFloat(properties.time_interval), event = 'ai_content_disappear' AND toFloat(properties.time_interval) BETWEEN 0 AND 1800000) / 1000.0 / nullIf(uniqIf(toString(properties.device_id), event = 'ai_content_show' AND toString(properties.device_id) != '' AND toString(properties.device_id) != '(null)'), 0), 1) AS total_sec_per_device,
        round(sumIf(toFloat(properties.time_interval), event = 'ai_content_disappear' AND toString(properties.page_name) = 'home' AND toFloat(properties.time_interval) BETWEEN 0 AND 1800000) / 1000.0 / nullIf(uniqIf(toString(properties.device_id), event = 'ai_content_show' AND toString(properties.device_id) != '' AND toString(properties.device_id) != '(null)'), 0), 1) AS feed_sec_per_device,
        round(sumIf(toFloat(properties.time_interval), event = 'ai_content_disappear' AND toString(properties.page_name) != 'home' AND toFloat(properties.time_interval) BETWEEN 0 AND 1800000) / 1000.0 / nullIf(uniqIf(toString(properties.device_id), event = 'ai_content_show' AND toString(properties.device_id) != '' AND toString(properties.device_id) != '(null)'), 0), 1) AS other_sec_per_device,
        round(countIf(event = 'ai_content_show') / nullIf(uniqIf(toString(properties.device_id), event = 'ai_content_show' AND toString(properties.device_id) != '' AND toString(properties.device_id) != '(null)'), 0), 2) AS contents_per_device
      FROM events
      WHERE ${eventFilter}
        AND event IN ('ai_content_show', 'ai_content_disappear')
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
        AND ct.published_at >= toDateTime('${from}')
        AND ct.published_at < toDateTime('${to}')
        AND ct.template_id IS NOT NULL
        AND toString(ct.template_id) != ''
        AND toString(ct.template_id) != '(null)'
      ORDER BY ct.published_at
      LIMIT 500
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

function mergeByTemplate(clickRows, successRows, shareRows, repeatRows, templatePublishRows) {
  const byId = new Map();
  function get(id) {
    if (!byId.has(id)) byId.set(id, { template_id: id, template_name: id });
    return byId.get(id);
  }

  clickRows.forEach((row) => {
    const item = get(row.template_id);
    item.use_events = number(row.use_events);
    item.use_users = number(row.use_users);
    item.template_remix_events = item.use_events;
    item.template_remix_users = item.use_users;
    item.active_days = number(row.active_days);
  });
  successRows.forEach((row) => {
    const item = get(row.template_id);
    item.result_events = number(row.result_events);
    item.success_events = number(row.success_events);
    item.success_users = number(row.success_users);
  });
  shareRows.forEach((row) => {
    const item = get(row.template_id);
    item.share_result_events = number(row.share_result_events);
    item.successful_share_count = number(row.successful_share_count);
    item.successful_share_users = number(row.successful_share_users);
    item.valid_share_attempts = number(row.valid_share_attempts);
  });
  repeatRows.forEach((row) => {
    const item = get(row.template_id);
    item.repeat_success_users = number(row.repeat_success_users);
    item.repeat_success_extra_events = number(row.repeat_success_extra_events);
    item.success_events_for_replay = number(row.success_events_for_replay);
    item.repeat_try_now_users_7d = item.repeat_success_users;
    item.repeat_click_users = item.repeat_success_users;
  });
  templatePublishRows.forEach((row) => {
    const item = get(row.template_id);
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
    item.successful_post_count = number(item.successful_post_count);
    item.successful_post_users = number(item.successful_post_users);
    item.successful_share_count = number(item.successful_share_count);
    item.successful_share_users = number(item.successful_share_users);
    item.share_result_events = number(item.share_result_events);
    item.valid_share_attempts = number(item.valid_share_attempts);
    item.server_template_contents = number(item.server_template_contents);
    item.server_template_published = number(item.server_template_published);
    item.server_template_users = number(item.server_template_users);
    item.server_template_published_users = number(item.server_template_published_users);
    item.repeat_success_users = number(item.repeat_success_users);
    item.repeat_success_extra_events = number(item.repeat_success_extra_events);
    item.success_events_for_replay = number(item.success_events_for_replay);
    item.repeat_try_now_users_7d = item.repeat_success_users;
    item.repeat_click_users = item.repeat_success_users;
    item.gen_success_rate_1d = item.result_events ? item.success_events / item.result_events : (item.use_events ? item.success_events / item.use_events : 0);
    item.post_rate_1d = item.server_template_contents ? item.server_template_published / item.server_template_contents : 0;
    item.share_denominator = Math.max(item.valid_share_attempts, item.successful_share_count, item.share_result_events);
    item.share_rate_1d = item.share_denominator ? item.successful_share_count / item.share_denominator : 0;
    item.replay_denominator = item.success_events_for_replay || item.success_events;
    item.replay_events = item.repeat_success_extra_events;
    item.replay_rate_7d = item.replay_denominator ? item.repeat_success_extra_events / item.replay_denominator : 0;
    item.template_post_remix_events = item.server_template_published;
    item.template_remix_events_per_day = item.active_days ? item.template_remix_events / item.active_days : 0;
    item.metric_source = "client_template_funnel_plus_server_content_publish";
    return item;
  }).sort((a, b) => b.template_remix_events - a.template_remix_events || b.success_users - a.success_users);
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
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
    post_remix: 0,
    detail_text: `try-now 成功 ${number(item.success_events)} · 服务端发布 ${number(item.server_template_published)} / ${number(item.server_template_contents)}`,
    active_days: number(item.active_days),
  }));
}

export async function buildMetricsSource(env, options = {}) {
  const start = isoDate(options.start || envValue(env, "POSTHOG_METRICS_START"), DEFAULT_START);
  const end = isoDate(options.end || envValue(env, "POSTHOG_METRICS_END"), DEFAULT_END);
  const queries = querySet(start, end);

  const [
    clickRows,
    successRows,
    shareRows,
    repeatRows,
    eventOverviewRows,
    contentOverviewRows,
    templatePublishRows,
    postRows,
    heatmapRows,
    onlineTimeRows,
    publishTimelineRows,
  ] = await Promise.all([
    posthogQuery(env, queries.templateClicks, "template click rows"),
    posthogQuery(env, queries.templateSuccess, "template success rows"),
    posthogQuery(env, queries.templateShares, "template share rows"),
    posthogQuery(env, queries.repeatUsers, "template repeat successful generations"),
    posthogQuery(env, queries.eventOverview, "event overview totals"),
    posthogQuery(env, queries.contentOverview, "server content overview totals"),
    posthogQuery(env, queries.templatePublish, "server template publish rows"),
    posthogQuery(env, queries.postOverviewRows, "server post overview rows"),
    posthogQuery(env, queries.heatmap, "activity heatmap"),
    posthogQuery(env, queries.userOnlineTime, "user online time"),
    posthogQuery(env, queries.templatePublishTimeline, "template publish timeline"),
  ]);

  const eventOverview = eventOverviewRows[0] || {};
  const contentOverview = contentOverviewRows[0] || {};
  const rows = mergeByTemplate(clickRows, successRows, shareRows, repeatRows, templatePublishRows);
  const successUsers = number(eventOverview.template_success_users);
  const serverTemplateContents = number(contentOverview.template_contents);
  const serverTemplatePublished = number(contentOverview.template_published);
  const shareSuccessEvents = number(eventOverview.share_success_events);
  const shareDenominator = Math.max(number(eventOverview.valid_share_attempts), shareSuccessEvents, number(eventOverview.share_result_events));
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
      successful_share_users: number(eventOverview.share_success_users),
      share_rate_pct: rate(shareSuccessEvents, shareDenominator) * 100,
    },
    LIVE_CONVERSION_DIAGNOSTICS: {
      success_users: successUsers,
      client_template_click_users: number(eventOverview.template_try_now_users),
      client_template_result_events: number(eventOverview.template_result_events),
      client_template_success_events: number(eventOverview.template_success_events),
      server_template_contents: serverTemplateContents,
      server_template_published: serverTemplatePublished,
      server_template_publish_rate_pct: rate(serverTemplatePublished, serverTemplateContents) * 100,
      share_success_events: shareSuccessEvents,
      share_result_events: number(eventOverview.share_result_events),
      valid_share_attempts: number(eventOverview.valid_share_attempts),
      share_rate_denominator: shareDenominator,
      share_success_rate_pct: rate(shareSuccessEvents, shareDenominator) * 100,
    },
    HEADLINE: {
      template_users_30d: successUsers,
      gen_success_rate_1d: rate(number(eventOverview.template_success_events), number(eventOverview.template_result_events)),
      post_after_success_rate: rate(serverTemplatePublished, serverTemplateContents),
      share_rate_1d: rate(shareSuccessEvents, shareDenominator),
    },
    ACTIVITY_HEATMAP_ROWS: heatmapRows.map((row) => ({
      day: row.day,
      day_part: row.day_part,
      remix_count: number(row.remix_count),
    })),
    USER_ONLINE_TIME_ROWS: onlineTimeRows.map((row) => ({
      day: row.day,
      total_sec_per_device: number(row.total_sec_per_device),
      feed_sec_per_device: number(row.feed_sec_per_device),
      other_sec_per_device: number(row.other_sec_per_device),
      contents_per_device: number(row.contents_per_device),
    })),
    TEMPLATE_PUBLISH_TIMELINE_ROWS: publishTimelineRows.map((row) => ({
      template_id: row.template_id,
      template_name: row.template_name || row.template_id,
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
      event_scope: "App only: $lib IN posthog-ios/posthog-android, app_env=ppe, build_configuration=release, channel_name != testflight",
      internal_filter: `server app_user/user_devices + cohort_people cohort_id=${INTERNAL_COHORT_ID}`,
      content_source: "postgres.game_tasks with deleted_at IS NULL, source exclusions, app_user internal exclusions",
      online_time_source: "PostHog dashboard 1995665 insight Yj72rIIx: ai_content_disappear.time_interval / uniq device_id with ai_content_show",
      template_publish_source: "postgres.content_templates status=published published_at",
      replay_metric: "repeat_success_extra_events / success_events_for_replay; same usr_id + template_id, template_try_now_result success=1, numerator excludes each user's first success",
      queries,
      docs: [
        "analytics-metrics skill §5.6",
        "PostHog dashboard 1995665",
      ],
      caveats: [
        "2026-08-09 to 2026-08-12 has a known PostHog event-ingestion gap; server game_tasks content counts remain the preferred content source.",
        "Template source counts intentionally use content_template only; user_replace_app is ignored in this dashboard.",
        "Client template funnel users use usr_id, not person_id. TCS remains separate from these overview/template definitions.",
      ],
    },
  };
}
