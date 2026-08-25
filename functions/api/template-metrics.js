import { buildTemplateMetricsSource } from "../_lib/posthog-live-metrics.mjs";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestGet({ env }) {
  try {
    const data = await buildTemplateMetricsSource(env);
    return json({ ok: true, data });
  } catch (error) {
    return json({
      ok: false,
      error: error && error.message ? error.message : String(error),
      detail: error && error.payload ? error.payload : undefined,
    }, error && error.status ? error.status : 500);
  }
}
