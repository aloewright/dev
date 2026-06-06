// Hindsight Memory — live instance monitor (Cloudflare Worker).
// Serves a dark-mode dashboard at / and proxies live stats at /api/stats by
// server-side fetching the self-hosted Hindsight instance through Cloudflare
// Access (service token) + the tenant API key, all from Worker secrets.

const TENANT = "default";

function hsHeaders(env) {
  const h = { accept: "application/json" };
  if (env.HINDSIGHT_API_KEY) h["authorization"] = `Bearer ${env.HINDSIGHT_API_KEY}`;
  if (env.HINDSIGHT_CF_ACCESS_CLIENT_ID) h["CF-Access-Client-Id"] = env.HINDSIGHT_CF_ACCESS_CLIENT_ID;
  if (env.HINDSIGHT_CF_ACCESS_CLIENT_SECRET) h["CF-Access-Client-Secret"] = env.HINDSIGHT_CF_ACCESS_CLIENT_SECRET;
  return h;
}

async function hsGet(env, path, asText = false) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(new URL(path, env.HINDSIGHT_BASE_URL).toString(), {
      headers: hsHeaders(env),
      signal: ctrl.signal,
    });
    if (!res.ok) return { _err: `HTTP ${res.status}` };
    return asText ? await res.text() : await res.json();
  } catch (e) {
    return { _err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Minimal Prometheus text parser: returns array of {name, labels{}, value}.
function parsePrometheus(text) {
  const out = [];
  if (typeof text !== "string") return out;
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+([0-9eE.+-]+)/);
    if (!m) continue;
    const labels = {};
    if (m[3]) {
      for (const pair of m[3].split(",")) {
        const km = pair.match(/^\s*([a-zA-Z0-9_]+)="(.*)"\s*$/);
        if (km) labels[km[1]] = km[2];
      }
    }
    out.push({ name: m[1], labels, value: Number(m[4]) });
  }
  return out;
}

function one(metrics, name, labelMatch) {
  const row = metrics.find(
    (r) => r.name === name && (!labelMatch || Object.entries(labelMatch).every(([k, v]) => r.labels[k] === v)),
  );
  return row ? row.value : null;
}

async function handleStats(env) {
  const [version, banksResp, metricsText] = await Promise.all([
    hsGet(env, "/version"),
    hsGet(env, `/v1/${TENANT}/banks`),
    hsGet(env, "/metrics", true),
  ]);

  const metrics = parsePrometheus(metricsText);
  const py = metrics.find((r) => r.name === "python_info");
  const startTime = one(metrics, "process_start_time_seconds");

  // LLM call performance, grouped by model+scope from the histogram _count/_sum.
  const llm = {};
  for (const r of metrics) {
    if (r.name !== "hindsight_llm_duration_seconds_count" && r.name !== "hindsight_llm_duration_seconds_sum") continue;
    const key = `${r.labels.model || "?"} · ${r.labels.scope || "?"}`;
    const e = (llm[key] ||= { model: r.labels.model, scope: r.labels.scope, calls: 0, ok: 0, seconds: 0 });
    if (r.name === "hindsight_llm_duration_seconds_count") {
      e.calls += r.value;
      if (r.labels.success === "true") e.ok += r.value;
    } else {
      e.seconds += r.value;
    }
  }
  const llmRows = Object.values(llm)
    .filter((e) => e.calls > 0)
    .map((e) => ({
      label: `${e.model} · ${e.scope}`,
      calls: e.calls,
      avgMs: e.calls ? Math.round((e.seconds / e.calls) * 1000) : 0,
      successPct: e.calls ? Math.round((e.ok / e.calls) * 100) : 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  const banks = (banksResp && banksResp.banks) || [];
  const totalFacts = banks.reduce((s, b) => s + (b.fact_count || 0), 0);

  return {
    ok: !version._err && !banksResp._err,
    fetchedAt: new Date().toISOString(),
    version: version._err ? null : version,
    python: py ? `${py.labels.major}.${py.labels.minor}.${py.labels.patchlevel}` : null,
    process: {
      rssBytes: one(metrics, "process_resident_memory_bytes"),
      virtualBytes: one(metrics, "process_virtual_memory_bytes"),
      cpuSeconds: one(metrics, "process_cpu_seconds_total"),
      openFds: one(metrics, "process_open_fds"),
      maxFds: one(metrics, "process_max_fds"),
      uptimeSeconds: startTime ? Math.max(0, Date.now() / 1000 - startTime) : null,
    },
    banks: {
      count: banks.length,
      totalFacts,
      list: banks
        .map((b) => ({
          id: b.bank_id,
          facts: b.fact_count || 0,
          lastDocAt: b.last_document_at || null,
        }))
        .sort((a, b) => b.facts - a.facts),
    },
    llm: llmRows,
    deployment: {
      host: "GCE e2-medium · us-central1 (pdx-software)",
      reach: "cloudflared tunnel + Cloudflare Access",
      embeddings: "local BGE (on-box, no gateway)",
      chat: "Cloudflare AI Gateway — dynamic/text_gen (+ dynamic/research_gen for reflect)",
      base: env.HINDSIGHT_BASE_URL || null,
    },
    errors: { version: version._err || null, banks: banksResp._err || null, metrics: metrics.length ? null : "no metrics" },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/stats") {
      const data = await handleStats(env);
      return new Response(JSON.stringify(data, null, 2), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

const HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hindsight Memory — Instance Monitor</title>
<style>
:root{
  --bg:#0b0e14; --panel:#141925; --panel2:#1b2230; --border:#262f3f;
  --text:#e6edf3; --muted:#8b97a8; --accent:#6ea8fe; --good:#3fb950; --bad:#f85149; --warn:#d29922;
}
html[data-theme="light"]{
  --bg:#f6f8fa; --panel:#ffffff; --panel2:#f0f3f7; --border:#d6dde6;
  --text:#1b2230; --muted:#5b6675; --accent:#1f6feb; --good:#1a7f37; --bad:#cf222e; --warn:#9a6700;
}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;align-items:center;gap:14px;margin-bottom:22px;flex-wrap:wrap}
h1{font-size:20px;margin:0;font-weight:650}
.dot{width:10px;height:10px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 3px color-mix(in srgb,var(--muted) 25%,transparent)}
.dot.up{background:var(--good);box-shadow:0 0 0 3px color-mix(in srgb,var(--good) 25%,transparent)}
.dot.down{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 25%,transparent)}
.spacer{flex:1}
button{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:8px;
  padding:7px 12px;cursor:pointer;font-size:13px} button:hover{border-color:var(--accent)}
.muted{color:var(--muted)} .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px}
.card h3{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
.big{font-size:26px;font-weight:680;line-height:1.1} .sub{color:var(--muted);font-size:12px;margin-top:4px}
section{margin-top:26px} section h2{font-size:14px;margin:0 0 12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums}
th{color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:none} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--border)}
.pill.on{color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,transparent)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--border)}
.kv:last-child{border-bottom:none} .kv .k{color:var(--muted)} .err{color:var(--bad)}
</style>
</head>
<body><div class="wrap">
<header>
  <span id="dot" class="dot"></span>
  <h1>Hindsight Memory · Instance Monitor</h1>
  <span class="spacer"></span>
  <span id="updated" class="muted" style="font-size:12px"></span>
  <button id="refresh">Refresh</button>
  <button id="theme">☀︎ / ☾</button>
</header>
<div id="content"><p class="muted">Loading live stats…</p></div>
</div>
<script>
const $=s=>document.querySelector(s);
const fmtBytes=b=>b==null?"—":b>=1e9?(b/1e9).toFixed(2)+" GB":b>=1e6?(b/1e6).toFixed(1)+" MB":(b/1e3).toFixed(0)+" KB";
const fmtDur=s=>{if(s==null)return"—";s=Math.floor(s);const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return (d?d+"d ":"")+(h?h+"h ":"")+m+"m";};
const ago=t=>{if(!t)return"—";const s=(Date.now()-new Date(t))/1000;return s<60?"just now":s<3600?Math.floor(s/60)+"m ago":s<86400?Math.floor(s/3600)+"h ago":Math.floor(s/86400)+"d ago";};
const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

function theme(t){document.documentElement.setAttribute("data-theme",t);localStorage.setItem("hm-theme",t);}
$("#theme").onclick=()=>theme(document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark");
theme(localStorage.getItem("hm-theme")||"dark");

function card(h,big,sub){return '<div class="card"><h3>'+h+'</h3><div class="big">'+big+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>';}

async function load(){
  $("#refresh").disabled=true;
  try{
    const d=await (await fetch("/api/stats",{cache:"no-store"})).json();
    $("#dot").className="dot "+(d.ok?"up":"down");
    $("#updated").textContent="updated "+ago(d.fetchedAt);
    const v=d.version||{}, p=d.process||{}, dep=d.deployment||{};
    const feats=Object.entries((v.features)||{}).filter(([,x])=>x).map(([k])=>'<span class="pill on">'+k+'</span>').join(" ")||"—";
    let html="";
    // overview cards
    html+='<div class="grid">';
    html+=card("Status", d.ok?'<span style="color:var(--good)">Healthy</span>':'<span style="color:var(--bad)">Degraded</span>', "API v"+(v.api_version||"?")+" · Python "+(d.python||"?"));
    html+=card("Uptime", fmtDur(p.uptimeSeconds), "CPU "+(p.cpuSeconds!=null?Math.round(p.cpuSeconds)+"s":"—")+" total");
    html+=card("Resident memory", fmtBytes(p.rssBytes), "virtual "+fmtBytes(p.virtualBytes));
    html+=card("Memory banks", (d.banks?.count??"—"), (d.banks?.totalFacts??0)+" facts stored");
    html+=card("Open file descriptors", (p.openFds!=null?p.openFds:"—"), "of "+(p.maxFds||"?")+" max");
    html+='</div>';
    // particulars
    html+='<section><h2>Particulars</h2><div class="card">';
    const kv=(k,val)=>'<div class="kv"><span class="k">'+k+'</span><span>'+val+'</span></div>';
    html+=kv("Endpoint",'<span class="mono">'+esc(dep.base||"—")+'</span>');
    html+=kv("Host",esc(dep.host||"—"));
    html+=kv("Reachability",esc(dep.reach||"—"));
    html+=kv("Embeddings",esc(dep.embeddings||"—"));
    html+=kv("Chat / reflect",esc(dep.chat||"—"));
    html+=kv("Features",feats);
    html+='</div></section>';
    // LLM performance
    if((d.llm||[]).length){
      html+='<section><h2>LLM call performance (since start)</h2><table><thead><tr><th>Model · scope</th><th>Calls</th><th>Avg latency</th><th>Success</th></tr></thead><tbody>';
      for(const r of d.llm){const sc=r.successPct>=99?"var(--good)":r.successPct>=90?"var(--warn)":"var(--bad)";
        html+='<tr><td class="mono">'+esc(r.label)+'</td><td>'+r.calls+'</td><td>'+r.avgMs+' ms</td><td style="color:'+sc+'">'+r.successPct+'%</td></tr>';}
      html+='</tbody></table></section>';
    }
    // banks
    if((d.banks?.list||[]).length){
      html+='<section><h2>Memory banks</h2><table><thead><tr><th>Bank</th><th>Facts</th><th>Last activity</th></tr></thead><tbody>';
      for(const b of d.banks.list){html+='<tr><td class="mono">'+esc(b.id)+'</td><td>'+b.facts+'</td><td class="muted">'+ago(b.lastDocAt)+'</td></tr>';}
      html+='</tbody></table></section>';
    }
    const errs=Object.entries(d.errors||{}).filter(([,x])=>x);
    if(errs.length) html+='<section><h2>Errors</h2><div class="card err">'+errs.map(([k,x])=>esc(k+": "+x)).join("<br>")+'</div></section>';
    $("#content").innerHTML=html;
  }catch(e){
    $("#dot").className="dot down";
    $("#content").innerHTML='<div class="card err">Failed to load stats: '+esc(e.message||e)+'</div>';
  }finally{ $("#refresh").disabled=false; }
}
$("#refresh").onclick=load;
load(); setInterval(load, 30000);
</script>
</body></html>`;
