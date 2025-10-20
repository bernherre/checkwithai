// action-ollama-codereview/index.js  (CommonJS)
const core = require("@actions/core");
const fg = require("fast-glob");
const fs = require("fs");
const path = require("path");

// Directorio de artefactos (siempre el mismo)
const OUT_DIR = path.join(process.cwd(), "ollama-review-report");

// === Config & utils ===
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES_PER_FILE = 200_000;
const DEFAULT_MAX_CONCURRENCY = 2;

const systemPrompt = `
You are “Code Review Assistant”, an expert code reviewer with deep knowledge of secure coding, performance, clean code, and language idioms.

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
Tarea: analiza el archivo y devuelve el JSON con los issues según las reglas.`.trim();

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function htmlEscape(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
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
        const m = lineField.match(/^(\d+)(?:\s*-\s*\d+)?$/);
        if (m) return parseInt(m[1], 10);
    }
    return undefined;
}

// Minimal limiter (sin deps)
function createLimiter(max = DEFAULT_MAX_CONCURRENCY) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= max) return;
        const job = queue.shift();
        if (!job) return;
        active++;
        job().finally(() => { active--; next(); });
    };
    return fn => new Promise((resolve, reject) => {
        queue.push(() => fn().then(resolve, reject));
        next();
    });
}

// === Ollama call + parsing ===
async function callOllamaChat({
    serverUrl,
    model,
    userPrompt,
    requestTimeoutMs,
    ollamaOpts = {},
    attempt = 1,
    maxAttempts = 3
}) {
    const url = `${serverUrl.replace(/\/$/, "")}/api/chat`;
    const body = {
        model,
        stream: false,
        options: filterOllamaOptions(ollamaOpts),
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]
    };

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);

    try {
        // Node 20: fetch global disponible
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
        if (attempt < maxAttempts) {
            const backoff = (1000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400);
            core.warning(`[retry] intento ${attempt} falló (${err.message || err}); reintentando en ${backoff}ms`);
            await sleep(backoff);
            return callOllamaChat({ serverUrl, model, userPrompt, requestTimeoutMs, ollamaOpts, attempt: attempt + 1, maxAttempts });
        }
        throw err;
    }
}

function filterOllamaOptions(opts) {
    const out = {};
    if (!opts) return out;
    if (opts.num_predict != null) out.num_predict = Number(opts.num_predict);
    if (opts.num_ctx != null) out.num_ctx = Number(opts.num_ctx);
    if (opts.temperature != null) out.temperature = Number(opts.temperature);
    return out;
}

function safeParseJsonArray(txt, fallback = []) {
    const tryParse = (s) => {
        try {
            const parsed = JSON.parse(String(s).trim());
            return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
    };

    let result = tryParse(txt);
    if (result) return result;

    const m = String(txt).match(/```json([\s\S]*?)```/i) || String(txt).match(/```([\s\S]*?)```/i);
    if (m?.[1]) {
        result = tryParse(m[1]);
        if (result) return result;
    }
    const b = String(txt).indexOf("[");
    const e = String(txt).lastIndexOf("]");
    if (b !== -1 && e !== -1 && e > b) {
        result = tryParse(String(txt).slice(b, e + 1));
        if (result) return result;
    }
    return fallback;
}

// === Reporting ===
function emitAnnotations(results) {
    for (const r of results) {
        for (const i of r.issues) {
            const cmd = severityToCommand(i.severity);
            const line = firstLine(i.line);
            const loc = [];
            if (r.file) loc.push(`file=${r.file}`);
            if (line) loc.push(`line=${line}`);
            const header = loc.length ? `${cmd} ${loc.join(",")}` : cmd;
            const msg = `${i.description || "Issue"}${i.explanation ? ` — ${i.explanation}` : ""}`;
            console.log(`::${header}::${msg}`);
        }
    }
}

function writeStepSummary(results) {
    const totalFiles = results.length;
    const counts = { "CRÍTICA": 0, "ALTA": 0, "MEDIA": 0, "BAJA": 0 };
    let totalIssues = 0;
    for (const r of results) {
        for (const i of r.issues) {
            const sev = (i.severity || "").toUpperCase();
            if (counts[sev] !== undefined) counts[sev]++;
            totalIssues++;
        }
    }
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
        `Artefacto/Pages: **ollama-review-report** (index.html, report.json).`,
    ].join("\n");

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) fs.appendFileSync(summaryPath, summary + "\n");
}

function buildMarkdownSummary(results) {
    const totals = { CRÍTICA: 0, ALTA: 0, MEDIA: 0, BAJA: 0 };
    let totalIssues = 0;

    for (const r of results) {
        for (const i of r.issues) {
            const sev = (i.severity || "").toUpperCase();
            if (totals[sev] !== undefined) totals[sev]++;
            totalIssues++;
        }
    }

    const lines = [];
    lines.push(`# 🧠 Ollama Code Review`);
    lines.push(``);
    lines.push(`**Archivos analizados:** ${results.length}  |  **Issues totales:** ${totalIssues}`);
    lines.push(``);
    lines.push(`- CRÍTICA: ${totals["CRÍTICA"]}`);
    lines.push(`- ALTA: ${totals["ALTA"]}`);
    lines.push(`- MEDIA: ${totals["MEDIA"]}`);
    lines.push(`- BAJA: ${totals["BAJA"]}`);
    lines.push(``);
    lines.push(`## Detalle por archivo`);
    if (results.length === 0) {
        lines.push(`_Sin archivos para revisar._`);
    } else {
        for (const r of results) {
            lines.push(`### \`${r.file}\``);
            if (!r.issues.length) {
                lines.push(`- _Sin hallazgos_`);
            } else {
                for (const i of r.issues) {
                    const sev = i.severity || "";
                    const line = i.line != null ? ` (línea(s): ${i.line})` : "";
                    lines.push(`- **${sev}**${line}: ${i.description || ""}`);
                }
            }
            lines.push(``);
        }
    }
    lines.push(`_Artefactos_: \`ollama-review-report/index.html\`, \`ollama-review-report/report.json\``);
    return lines.join("\n");
}

function generateHtmlReport(results) {
    const totalIssues = results.reduce((acc, r) => acc + r.issues.length, 0);
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
      </tr>
    `).join("");
        return items || `
      <tr>
        <td>–</td><td><code>${htmlEscape(r.file)}</code></td>
        <td colspan="5"><em>Sin hallazgos</em></td>
      </tr>
    `;
    }).join("");

    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ollama Code Review</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Arial, sans-serif; margin: 24px; }
  h1 { margin: 0 0 8px; }
  .summary { margin: 8px 0 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
  th { background: #f7f7f7; text-align: left; }
  pre { white-space: pre-wrap; margin: 0; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eee; margin-right: 6px; font-size: 12px; }
  .crit { background: #ffe5e5; color: #900; }
  a.tag { text-decoration: none; color: inherit; }
</style>
</head>
<body>
  <h1>Ollama Code Review</h1>
  <div class="summary">
    <span class="tag">Archivos: ${results.length}</span>
    <span class="tag">Issues totales: ${totalIssues}</span>
    <span class="tag ${criticas.length ? "crit" : ""}">CRÍTICAS: ${criticas.length}</span>
    <a class="tag" href="./report.json" download>Descargar JSON</a>
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Archivo</th><th>Severidad</th><th>Línea(s)</th><th>Descripción</th><th>Solución</th><th>Explicación</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>`;
}

// === File resolution & reading ===
function extOf(file) {
    const e = path.extname(file).replace(".", "");
    return e || "txt";
}

function uniqKeepOrder(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
    return out;
}

async function resolveFiles({ file_list_path, file_list, file_glob, exclude_glob }) {
    let files = [];

    if (file_list_path) {
        try {
            const raw = fs.readFileSync(file_list_path, "utf8");
            files = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        } catch {
            core.warning(`No se pudo leer file_list_path: ${file_list_path}`);
        }
    }

    if (files.length === 0 && file_list) {
        files = file_list.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }

    if (files.length === 0) {
        const patterns = [
            file_glob,
            ...(String(exclude_glob || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(p => `!${p}`)),
            "!**/.git/**",
            "!**/*.png", "!**/*.jpg", "!**/*.jpeg", "!**/*.gif", "!**/*.webp",
            "!**/*.pdf", "!**/*.zip", "!**/*.ico", "!**/*.wasm", "!**/*.exe", "!**/*.dll", "!**/*.so"
        ];
        files = await fg(patterns, { dot: true });
    } else {
        const binRegex = /\.(png|jpg|jpeg|gif|webp|pdf|zip|ico|wasm|exe|dll|so)$/i;
        files = files.filter(f => f && !binRegex.test(f) && fs.existsSync(f) && fs.statSync(f).isFile());
        files = uniqKeepOrder(files);
    }

    return files;
}

function readTextFileCapped(file, maxBytes) {
    try {
        const stat = fs.statSync(file);
        const cap = Math.max(0, Number(maxBytes) || DEFAULT_MAX_BYTES_PER_FILE);
        if (stat.size <= cap) {
            return { text: fs.readFileSync(file, "utf8"), truncated: false, bytes: stat.size };
        }
        const fd = fs.openSync(file, "r");
        const buf = Buffer.allocUnsafe(cap);
        fs.readSync(fd, buf, 0, cap, 0);
        fs.closeSync(fd);
        const note = `\n\n/* [AVISO] Contenido truncado a ${cap} bytes de ${stat.size} */\n`;
        return { text: buf.toString("utf8") + note, truncated: true, bytes: cap };
    } catch {
        return { text: "", truncated: false, bytes: 0, err: true };
    }
}

// === Main ===
async function run() {
    try {
        // Inputs
        const model = core.getInput("model", { required: true });
        const serverUrl = core.getInput("server_url", { required: true });
        const file_glob = core.getInput("file_glob") || "**/*.{ts,tsx,js,jsx,py,cs,java,go,rs}";
        const exclude_glob = core.getInput("exclude_glob") || "";
        const file_list = core.getInput("file_list") || "";
        const file_list_path = core.getInput("file_list_path") || "";
        const failOnCritica = (core.getInput("fail_on_critica") || "").toLowerCase() === "true";
        const retentionDays = parseInt(core.getInput("retention_days") || "7", 10) || 7;

        const requestTimeoutMs = parseInt(core.getInput("request_timeout_ms") || `${DEFAULT_REQUEST_TIMEOUT_MS}`, 10);
        const maxBytesPerFile = parseInt(core.getInput("max_bytes_per_file") || `${DEFAULT_MAX_BYTES_PER_FILE}`, 10);
        const num_predict = core.getInput("ollama_num_predict") || core.getInput("num_predict");
        const num_ctx = core.getInput("ollama_num_ctx") || core.getInput("num_ctx");
        const temperature = core.getInput("ollama_temperature") || core.getInput("temperature");
        const reviewMaxConcurrency = parseInt(core.getInput("review_max_concurrency") || process.env.REVIEW_MAX_CONCURRENCY || `${DEFAULT_MAX_CONCURRENCY}`, 10);

        core.info(`[inputs] model="${model}" server_url="${serverUrl}"`);
        core.info(`[inputs] file_glob="${file_glob}"`);
        core.info(`[inputs] exclude_glob="${exclude_glob.replace(/\n/g, "\\n")}"`);
        core.info(`[inputs] file_list_path="${file_list_path}"`);
        core.info(`[inputs] file_list(len=${file_list.length})="${file_list ? "[...]" : ""}"`);
        core.info(`[inputs] request_timeout_ms=${requestTimeoutMs} max_bytes_per_file=${maxBytesPerFile} num_predict=${num_predict || ""} num_ctx=${num_ctx || ""} temperature=${temperature || ""} max_concurrency=${reviewMaxConcurrency}`);

        const files = await resolveFiles({ file_list_path, file_list, file_glob, exclude_glob });
        core.info(`[debug] files.count=${files.length}`);
        core.info(`[debug] files.preview(<=20)=${files.slice(0, 20).join(", ")}`);

        if (files.length === 0) {
            core.warning("No se encontraron archivos a revisar.");
        }

        const limiter = createLimiter(Math.max(1, reviewMaxConcurrency));
        const results = [];

        const tasks = files.map(file => limiter(async () => {
            const ext = extOf(file);
            const { text, truncated, err, bytes } = readTextFileCapped(file, maxBytesPerFile);
            if (err) { core.warning(`No se pudo leer como texto: ${file}`); results.push({ file, issues: [] }); return; }

            core.info(`[file] ${file} size=${bytes}B used=${Math.min(bytes, maxBytesPerFile)}B${truncated ? " [truncated]" : ""}`);
            const prompt = buildUserPrompt(file, ext, text);
            const ollamaOpts = {
                num_predict: num_predict ? Number(num_predict) : undefined,
                num_ctx: num_ctx ? Number(num_ctx) : undefined,
                temperature: temperature ? Number(temperature) : undefined,
            };
            const started = Date.now();
            let raw;
            try {
                raw = await callOllamaChat({
                    serverUrl,
                    model,
                    userPrompt: prompt,
                    requestTimeoutMs,
                    ollamaOpts
                });
            } catch (e) {
                core.warning(`[file] ${file} request failed: ${e.message || e}`);
                results.push({ file, issues: [] });
                return;
            } finally {
                const elapsed = Date.now() - started;
                core.info(`[file] ${file} elapsed=${elapsed}ms`);
            }
            const issues = safeParseJsonArray(raw, []);
            results.push({ file, issues });
        }));

        for (const t of tasks) { await t; }

        // === SIEMPRE crear artefactos ===
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(results, null, 2));
        fs.writeFileSync(path.join(OUT_DIR, "index.html"), generateHtmlReport(results));

        // Markdown para comentar en PR/commit
        const summaryMd = buildMarkdownSummary(results);
        const summaryMdPath = path.join(OUT_DIR, "summary.md");
        fs.writeFileSync(summaryMdPath, summaryMd, "utf8");

        core.info(`Reporte generado en ${OUT_DIR}`);

        // UI
        emitAnnotations(results);
        writeStepSummary(results);

        // Outputs
        core.setOutput("report_dir", OUT_DIR);
        core.setOutput("summary_md_path", summaryMdPath);
        core.setOutput("retention_days", retentionDays.toString());

        // Gate por CRÍTICA
        const anyCritica = results.some(r => r.issues.some(i => (i.severity || "").toUpperCase() === "CRÍTICA"));
        if (failOnCritica && anyCritica) {
            core.setFailed("Se encontraron issues con severidad CRÍTICA.");
        }
    } catch (err) {
        core.setFailed(err.message || String(err));
    }
}

run();
