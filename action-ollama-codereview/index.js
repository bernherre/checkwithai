import * as core from "@actions/core";
import fg from "fast-glob";
import fs from "fs";
import os from "os";
import path from "path";

/* =========================
   Prompt del revisor
   ========================= */
const systemPrompt = `You are “Code Review Assistant”, an expert code reviewer with deep knowledge of secure coding, performance, clean code, and language idioms.

RULES
- Output MUST be a JSON array ONLY (no prose, no backticks, no extra keys).
- Each item MUST include: severity, line, description, solution, explanation.
- Valid severities: "CRÍTICA", "ALTA", "MEDIA", "BAJA".
- "line" is a positive integer or a "start-end" string for ranges (e.g., "15-22").
- Exclude false positives. If NO issues, output [].
- Prefer concrete, minimal fixes. Provide small, self-contained code in "solution".
- Consider: security (injections, secrets, deserialización insegura, SSRF/RCE, XSS/CSRF), performance (complejidad, I/O, memoria), estilo/legibilidad, errores lógicos, edge cases, mejores prácticas de la plataforma, manejo de errores, concurrencia, validación de entradas y contratos.
- Mantén el lenguaje y términos en español.

OUTPUT FORMAT (array only)
[
  {
    "severity": "ALTA",
    "line": 42,
    "description": "Descripción concisa del problema",
    "solution": "Código corregido mínimo y funcional",
    "explanation": "Por qué esta solución es mejor"
  }
]

CONTEXTO DEL ARCHIVO
- Nombre: \${filename}
- Tipo: \${extension}
- Contenido:
\`\`\`\${extension}
\${content}
\`\`\`
Tarea: analiza el archivo y devuelve el JSON con los issues según las reglas.`;

/* =========================
   Helpers
   ========================= */
function buildUserPrompt(filename, extension, content) {
    return `Code Review Assistant

## File to Review
Filename: ${filename}
File type: ${extension}

## Code Content
\`\`\`${extension}
${content}
\`\`\`

Please analyze this file and return ONLY the JSON array of issues as specified.`;
}
function show(s) { return String(s ?? "").replace(/\r/g, "\\r").replace(/\n/g, "\\n"); }

function negativePatternsFromExclude(exclude_glob) {
    if (!exclude_glob) return [];
    const lines = String(exclude_glob).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines.map(p => (p.startsWith("!") ? p : `!${p}`));
}

function safeParseJsonArray(txt, fallback = []) {
    const tryParse = (s) => { try { const j = JSON.parse(s.trim()); return Array.isArray(j) ? j : null; } catch { return null; } };
    let res = tryParse(txt);
    if (res) return res;
    const m = txt.match(/```json([\s\S]*?)```/i) || txt.match(/```([\s\S]*?)```/i);
    if (m?.[1]) { res = tryParse(m[1]); if (res) return res; }
    const i = txt.indexOf("["), j = txt.lastIndexOf("]");
    if (i !== -1 && j !== -1 && j > i) { res = tryParse(txt.slice(i, j + 1)); if (res) return res; }
    return fallback;
}

function extOf(file) { return path.extname(file).replace(".", "") || "txt"; }
function htmlEscape(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
function truncateByBytes(str, maxBytes) {
    const buf = Buffer.from(str, "utf8");
    if (buf.length <= maxBytes) return str;
    return buf.subarray(0, maxBytes).toString("utf8") + "\n\n/* [Truncado por límite de tamaño] */\n";
}

/* =========================
   Reporte HTML + UI
   ========================= */
function generateHtmlReport(results) {
    const totalIssues = results.reduce((a, r) => a + r.issues.length, 0);
    const criticas = results.flatMap(r => r.issues.filter(i => (i.severity || "").toUpperCase() === "CRÍTICA"));
    const rows = results.map(r => {
        const items = r.issues.map((i, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><code>${htmlEscape(r.file)}</code></td>
        <td>${htmlEscape(i.severity || "")}</td>
        <td>${htmlEscape(String(i.line ?? ""))}</td>
        <td>${htmlEscape(i.description || "")}</td>
        <td><pre>${htmlEscape(i.solution || "")}</pre></td>
        <td>${htmlEscape(i.explanation || "")}</td>
      </tr>`).join("");
        return items || `
      <tr>
        <td>–</td><td><code>${htmlEscape(r.file)}</code></td>
        <td colspan="5"><em>Sin hallazgos</em></td>
      </tr>`;
    }).join("");
    return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ollama Code Review</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Arial,sans-serif;margin:24px}
h1{margin:0 0 8px}.summary{margin:8px 0 16px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
th{background:#f7f7f7;text-align:left}pre{white-space:pre-wrap;margin:0}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;background:#eee;margin-right:6px;font-size:12px}
.crit{background:#ffe5e5;color:#900}a.tag{text-decoration:none;color:inherit}
</style>
</head><body>
<h1>Ollama Code Review</h1>
<div class="summary">
  <span class="tag">Archivos: ${results.length}</span>
  <span class="tag">Issues totales: ${totalIssues}</span>
  <span class="tag ${criticas.length ? "crit" : ""}">CRÍTICAS: ${criticas.length}</span>
  <a class="tag" href="./report.json" download>Descargar JSON</a>
</div>
<table><thead>
  <tr><th>#</th><th>Archivo</th><th>Severidad</th><th>Línea(s)</th><th>Descripción</th><th>Solución</th><th>Explicación</th></tr>
</thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function severityToCommand(sev = "") {
    const s = (sev || "").toUpperCase();
    if (s === "CRÍTICA") return "error";
    if (s === "ALTA" || s === "MEDIA") return "warning";
    return "notice";
}
function firstLine(lineField) {
    if (typeof lineField === "number") return lineField;
    if (typeof lineField === "string") {
        const m = lineField.match(/^(\d+)(?:\s*-\s*\d+)?$/); if (m) return parseInt(m[1], 10);
    }
    return undefined;
}
function emitAnnotations(results) {
    for (const r of results) {
        for (const i of r.issues) {
            const cmd = severityToCommand(i.severity);
            const line = firstLine(i.line);
            const loc = []; if (r.file) loc.push(`file=${r.file}`); if (line) loc.push(`line=${line}`);
            const header = loc.length ? `${cmd} ${loc.join(",")}` : cmd;
            const msg = `${i.description || "Issue"}${i.explanation ? ` — ${i.explanation}` : ""}`;
            console.log(`::${header}::${msg}`);
        }
    }
}
function writeStepSummary(results) {
    const totalFiles = results.length; const counts = { CRÍTICA: 0, ALTA: 0, MEDIA: 0, BAJA: 0 };
    let totalIssues = 0;
    for (const r of results) for (const i of r.issues) { const s = (i.severity || "").toUpperCase(); if (counts[s] !== undefined) counts[s]++; totalIssues++; }
    const summary = [
        `# 🧠 Ollama Code Review`,
        ``,
        `**Archivos analizados:** ${totalFiles}  |  **Issues totales:** ${totalIssues}`,
        ``,
        `- CRÍTICA: ${counts["CRÍTICA"]}`,
        `- ALTA: ${counts["ALTA"]}`,
        `- MEDIA: ${counts["MEDIA"]}`,
        `- BAJA: ${counts["BAJA"]}`,
        ``,
        `Descarga: **report.json** (en el artefacto).`,
    ].join("\n");
    const p = process.env.GITHUB_STEP_SUMMARY; if (p) fs.appendFileSync(p, summary + "\n");
}

/* =========================
   Resolución de archivos
   ========================= */
function uniqKeepOrder(arr) { const seen = new Set(); const out = []; for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } } return out; }

async function resolveFiles({ file_list_path, file_list, file_glob, exclude_glob }) {
    let files = [];
    if (file_list_path) {
        try {
            const raw = fs.readFileSync(file_list_path, "utf8");
            files = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            core.info(`[debug] using file_list_path (${files.length} rutas)`);
        } catch {
            core.warning(`No se pudo leer file_list_path: ${file_list_path}`);
        }
    }
    if (files.length === 0 && file_list) {
        files = file_list.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        core.info(`[debug] using file_list (${files.length} rutas)`);
    }
    if (files.length === 0) {
        const negs = negativePatternsFromExclude(exclude_glob);
        const defaultNegs = [
            "!**/node_modules/**",
            "!**/dist/**",
            "!**/build/**",
            "!**/.next/**",
            "!**/coverage/**",
            "!**/ollama-review-report/**",
            "!**/*.png", "!**/*.jpg", "!**/*.jpeg", "!**/*.gif", "!**/*.webp",
            "!**/*.pdf", "!**/*.zip", "!**/*.ico", "!**/*.wasm", "!**/*.exe", "!**/*.dll", "!**/*.so",
            "!**/*.lock", "!package-lock.json", "!yarn.lock", "!pnpm-lock.yaml",
            "!**/.git/**",
            "!action-ollama-codereview/**"
        ];
        const patterns = [file_glob, ...defaultNegs, ...negs];
        core.info(`[debug] glob.patterns="${show(patterns.join(" | "))}"`);
        files = await fg(patterns, { dot: true });
    } else {
        const bin = /\.(png|jpg|jpeg|gif|webp|pdf|zip|ico|wasm|exe|dll|so)$/i;
        files = files.filter(f => f && !bin.test(f) && fs.existsSync(f) && fs.statSync(f).isFile());
        files = uniqKeepOrder(files);
    }
    return files;
}

/* =========================
   Llamada a Ollama (keep-alive, threads, timeout/retry)
   ========================= */
async function callOllamaChat(serverUrl, model, userPrompt, attempt = 1) {
    const url = `${serverUrl.replace(/\/$/, "")}/api/chat`;
    const opts = globalThis.__OLLAMA_OPTIONS__ || {};
    const timeoutMs = globalThis.__REQUEST_TIMEOUT_MS__ ?? 120_000;

    const body = {
        model,
        stream: false,
        keep_alive: "10m",
        options: opts,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
    };

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ac.signal,
        });
        clearTimeout(to);
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Ollama error: ${res.status} ${res.statusText} - ${txt}`);
        }
        const data = await res.json();
        return data?.message?.content ?? "";
    } catch (err) {
        clearTimeout(to);
        if (attempt < 3) {
            const backoff = 1000 * Math.pow(2, attempt - 1);
            core.warning(`[retry] intento ${attempt} falló (${err?.message || err}); reintentando en ${backoff}ms`);
            await new Promise(r => setTimeout(r, backoff));
            return callOllamaChat(serverUrl, model, userPrompt, attempt + 1);
        }
        throw err;
    }
}

/* =========================
   Concurrencia controlada
   ========================= */
async function mapLimit(items, limit, worker) {
    const ret = new Array(items.length);
    let i = 0, active = 0, rejectOnce = null;
    return new Promise((resolve, reject) => {
        rejectOnce = (e) => { if (reject) { const r = reject; reject = null; r(e); } };
        const next = () => {
            if (i === items.length && active === 0) return resolve(ret);
            while (active < limit && i < items.length) {
                const idx = i++, it = items[idx];
                active++;
                Promise.resolve(worker(it, idx))
                    .then(val => { ret[idx] = val; active--; next(); })
                    .catch(rejectOnce);
            }
        };
        next();
    });
}

/* =========================
   Programa principal
   ========================= */
async function run() {
    try {
        const model = core.getInput("model");
        const serverUrl = core.getInput("server_url");
        const file_glob = core.getInput("file_glob");
        const exclude_glob = core.getInput("exclude_glob");
        const file_list = core.getInput("file_list");
        const file_list_path = core.getInput("file_list_path");
        const failOnCritica = core.getInput("fail_on_critica") === "true";
        const retentionDays = parseInt(core.getInput("retention_days"), 10) || 7;

        // Resiliencia / perf
        const requestTimeoutMs = parseInt(core.getInput("request_timeout_ms") || "300000", 10);
        const maxBytesPerFile = parseInt(core.getInput("max_bytes_per_file") || "307200", 10);
        const numPredict = parseInt(core.getInput("ollama_num_predict") || "512", 10);
        const numCtx = parseInt(core.getInput("ollama_num_ctx") || "2048", 10);
        const temperature = parseFloat(core.getInput("ollama_temperature") || "0");
        const maxConc = parseInt(core.getInput("review_max_concurrency") || process.env.REVIEW_MAX_CONCURRENCY || "2", 10);

        // Usa al menos 2 hilos, no más que CPUs-1
        const cpuThreads = Math.max(2, (os.cpus()?.length || 2) - 1);

        // Logs inputs
        core.info(`[inputs] model="${show(model)}" server_url="${show(serverUrl)}"`);
        core.info(`[inputs] file_glob="${show(file_glob)}"`);
        core.info(`[inputs] exclude_glob="${show(exclude_glob)}"`);
        core.info(`[inputs] file_list_path="${show(file_list_path)}"`);
        core.info(`[inputs] file_list(len=${file_list ? file_list.split(/\r?\n/).filter(Boolean).length : 0})="${show(file_list)}"`);
        core.info(`[inputs] request_timeout_ms=${requestTimeoutMs} max_bytes_per_file=${maxBytesPerFile} num_predict=${numPredict} num_ctx=${numCtx} temperature=${temperature} max_concurrency=${maxConc} threads=${cpuThreads}`);

        // Inyecta opciones globales para callOllamaChat
        globalThis.__OLLAMA_OPTIONS__ = { temperature, num_predict: numPredict, num_ctx: numCtx, num_thread: cpuThreads };
        globalThis.__REQUEST_TIMEOUT_MS__ = requestTimeoutMs;

        const files = await resolveFiles({ file_list_path, file_list, file_glob, exclude_glob });
        core.info(`[debug] files.count=${files.length}`);
        if (files.length) core.info(`[debug] files.preview(<=20)=${show(files.slice(0, 20).join(", "))}`);
        if (files.length === 0) core.warning("No se encontraron archivos a revisar.");

        const results = await mapLimit(files, Math.max(1, maxConc), async (file) => {
            let content = "";
            try { content = fs.readFileSync(file, "utf8"); } catch { core.warning(`No se pudo leer como texto: ${file}`); return { file, issues: [] }; }
            const originalBytes = Buffer.byteLength(content, "utf8");
            const truncated = truncateByBytes(content, maxBytesPerFile);
            const usedBytes = Buffer.byteLength(truncated, "utf8");
            core.info(`[file] ${file} size=${originalBytes}B used=${usedBytes}B`);

            const extension = extOf(file);
            const prompt = buildUserPrompt(file, extension, truncated);

            const t0 = Date.now();
            let raw = "";
            try { raw = await callOllamaChat(serverUrl, model, prompt); }
            catch (e) { core.warning(`[file] ${file} request failed: ${e?.message || e}`); throw e; }
            finally { core.info(`[file] ${file} elapsed=${Date.now() - t0}ms`); }

            const issues = safeParseJsonArray(raw, []);
            return { file, issues };
        });

        // Reporte
        const outDir = path.join(process.cwd(), "ollama-review-report");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(results, null, 2));
        fs.writeFileSync(path.join(outDir, "index.html"), generateHtmlReport(results));
        core.info(`Reporte generado en ${outDir}`);

        // UI
        emitAnnotations(results);
        writeStepSummary(results);

        // Outputs
        core.setOutput("report_dir", outDir);
        core.setOutput("retention_days", retentionDays.toString());

        // Gate CRÍTICA
        const anyCritica = results.some(r => r.issues.some(i => (i.severity || "").toUpperCase() === "CRÍTICA"));
        if (failOnCritica && anyCritica) core.setFailed("Se encontraron issues con severidad CRÍTICA.");
    } catch (err) {
        core.setFailed(err.message || String(err));
    }
}

run();
