// Cloudflare Worker for the Work Notebook app.
//  - /vapid     public key for push notifications (created automatically the first time)
//  - /sync      the app sends the reminder time + whether you logged today
//  - /unsub     turn the reminder off
//  - /rate      collects ratings;  /ratings?key=ADMIN_KEY  shows them to you
//  - cron       every 15 minutes: sends "did you log today?" only if you did NOT log
// Needs: a KV namespace bound with the variable name DB, a variable ADMIN_KEY (your password),
// and a Cron Trigger:  */15 * * * *

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const enc = (s) => new TextEncoder().encode(s);
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const res = (body, status = 200, type = "text/plain") =>
  new Response(body, { status, headers: { ...CORS, "Content-Type": type + ";charset=utf-8" } });

async function vapid(env) {
  let v = await env.DB.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = {
      pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)),
      priv: await crypto.subtle.exportKey("jwk", kp.privateKey),
    };
    await env.DB.put("vapid", JSON.stringify(v));
  }
  return v;
}

async function makeJwt(endpoint, v, subject) {
  const head = b64u(enc(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey("jwk", v.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(head + "." + body));
  return head + "." + body + "." + b64u(sig);
}

async function sendPush(sub, env) {
  const v = await vapid(env);
  const jwt = await makeJwt(sub.endpoint, v, env.CONTACT || "https://abdcode.pages.dev");
  return fetch(sub.endpoint, {
    method: "POST",
    headers: { Authorization: "vapid t=" + jwt + ", k=" + v.pub, TTL: "43200", Urgency: "normal" },
  });
}

function localTime(tz, now) {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
      }).formatToParts(now).map((x) => [x.type, x.value])
    );
    return {
      date: p.year + "-" + p.month + "-" + p.day,
      min: (+p.hour % 24) * 60 + +p.minute,
      wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    };
  } catch (e) { return null; }
}

const keyOf = async (endpoint) => "s:" + b64u(await crypto.subtle.digest("SHA-256", enc(endpoint))).slice(0, 32);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/vapid") return res((await vapid(env)).pub);

    if (req.method === "POST") {
      let b;
      try { b = await req.json(); } catch (e) { return res("bad", 400); }

      if (url.pathname === "/rate") {
        const stars = Math.round(+b.stars);
        if (!(stars >= 1 && stars <= 5)) return res("bad", 400);
        const rec = { stars, note: String(b.note || "").slice(0, 500), lang: String(b.lang || "").slice(0, 5), at: Date.now() };
        await env.DB.put("r:" + rec.at + ":" + crypto.randomUUID().slice(0, 6), JSON.stringify(rec));
        return res("ok");
      }

      if (url.pathname === "/sync") {
        const sub = b.sub;
        if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) return res("bad", 400);
        if (!/^\d\d:\d\d$/.test(b.time || "") || !Array.isArray(b.days)) return res("bad", 400);
        const k = await keyOf(sub.endpoint);
        const old = (await env.DB.get(k, "json")) || {};
        const rec = {
          sub: { endpoint: sub.endpoint, keys: sub.keys || {} },
          time: b.time,
          days: b.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
          tz: String(b.tz || "UTC").slice(0, 60),
          lang: String(b.lang || "ar").slice(0, 5),
          last: String(b.last || "").slice(0, 10),
          sent: old.sent || "",
        };
        await env.DB.put(k, JSON.stringify(rec));
        return res("ok");
      }

      if (url.pathname === "/unsub") {
        if (typeof b.endpoint === "string") await env.DB.delete(await keyOf(b.endpoint));
        return res("ok");
      }
    }

    if (url.pathname === "/ratings" && env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY) {
      const list = await env.DB.list({ prefix: "r:", limit: 1000 });
      const rows = (await Promise.all(list.keys.map((k) => env.DB.get(k.name, "json")))).filter(Boolean).sort((a, b) => b.at - a.at);
      const avg = rows.length ? (rows.reduce((s, r) => s + r.stars, 0) / rows.length).toFixed(2) : "-";
      const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      const cards = rows.map((r) =>
        `<div style="border:1px solid #ddd;border-radius:10px;padding:10px;margin:8px 0"><b style="color:#f5b301">${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)}</b> <small>${new Date(r.at).toLocaleString("ar")} · ${esc(r.lang)}</small><div>${esc(r.note)}</div></div>`
      ).join("");
      return res(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body dir="rtl" style="font-family:system-ui,sans-serif;max-width:560px;margin:20px auto;padding:0 12px"><h2>التقييمات (${rows.length}) — المعدّل ${avg}</h2>${cards}`,
        200, "text/html"
      );
    }

    return res("not found", 404);
  },

  // runs every 15 minutes
  async scheduled(event, env) {
    const now = new Date();
    let cursor;
    do {
      const l = await env.DB.list({ prefix: "s:", cursor });
      cursor = l.list_complete ? undefined : l.cursor;
      for (const k of l.keys) {
        const r = await env.DB.get(k.name, "json");
        if (!r) continue;
        const lt = localTime(r.tz || "UTC", now);
        if (!lt) continue;
        const [h, m] = String(r.time || "18:00").split(":").map(Number);
        const at = h * 60 + m;
        if (!(r.days || []).includes(lt.wd)) continue;
        if (lt.min < at || lt.min > at + 360) continue;   // only within 6 hours after the chosen time
        if (r.last === lt.date || r.sent === lt.date) continue; // already logged today, or already reminded
        const out = await sendPush(r.sub, env);
        if (out.status === 404 || out.status === 410) { await env.DB.delete(k.name); continue; }
        if (out.ok) { r.sent = lt.date; await env.DB.put(k.name, JSON.stringify(r)); }
      }
    } while (cursor);
  },
};
