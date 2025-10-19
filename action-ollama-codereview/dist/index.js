import * as core from "@actions/core";
import fg from "fast-glob";
import fs from "fs";
import os from "os";
import path from "path";

/* ===== Prompt de sistema (igual a tu versión, con reglas estrictas) ===== */
const systemPrompt = `You are “Code Review Assistant”, an expert code reviewer with deep knowledge of secure coding, performance, clean code, and language idioms.

RULES
- Output MUST be a JSON array ONLY (no prose, no backticks, no extra keys).
- Each item MUST include: severity, line, description, solution, explanation.
- Valid severities: "CRÍTICA", "ALTA", "MEDIA", "BAJA".
- "line" is a positive integer or a "start-end" string for ranges (e.g., "15-22").
- Exclude false positives. If NO issues, output [].
- Prefer concrete, minimal fixes. Provide small, self-contained code in "solution".
- Consider: security, performance, style/readability, logic errors, edge cases, platform best practices, error handling, concurrency, input validation.
- Spanish output.

FORMAT (array only)
[
  { "severity": "ALTA", "line": 42, "description": "...", "solution": "...", "explanation": "..." }
]`;

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

/* ===== Utils ===== */
function show(s) { return String(s ?? "").replace(/\r/g, "\\r").replace(/\n/g, "\\n"); }
function extOf(file) { const e = path.extname(file).replace(".", ""); return e || "txt"; }
function htmlEscape(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
function firstLine(lineField) {
    if (typeof lineField === "number") return lineField;
    if (typeof lineField === "string") { const m = lineField.match(/^(\d+)(?:\s*-\s*\d+)?$/); if (m) return parseInt(m[1], 10); }
    return undefined;
}
function severityToCommand(sev = "") { const s = (sev || "").toUpperCase(); if (s === "CRÍTICA") return "error"; if (s === "ALTA" || s === "MEDIA") return "warning"; return "notice"; }
function uniqKeepOrder(arr) { const seen = new Set(); const out = []; for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } } return out; }
function truncateByBytes(str, maxBytes) {
    const buf = Buffer.from(str, "utf8");
    if (buf.length <= maxBytes) return str;
    return buf.subarray(0, maxBytes).toString("utf8") + "\n\n/* [Truncado por límite de tamaño] */\n";
}
function safeParseJsonArray(txt, fallback = []) {
    const tryParse = s => { try { const j = JSON.parse(s.trim()); return Array.isArray(j) ? j : null; } catch { return null; } };
    let res = tryParse(txt); if (res) return res;
    const m = txt.match(/```json([\s\S]*?)```/i) || txt.match(/```([\s\S]*?)```/i);
    if (m?.[1]) { res = tryParse(m[1]); if (res) return res; }
    const i = txt.indexOf("["), j = txt.lastIndexOf("]");
    if (i !== -1 && j !== -1 && j > i) { res = tryParse(txt.slice(i, j + 1)); if (res) return res; }
    return fallback;
}

/* ===== UI (HTML / anotaciones / summary.md) ===== */
function generateHtmlReport(results) {
    const totalIssues = results.reduce((a, r) => a + (r.issues?.length || 0), 0);
    const criticas = results.flatMap(r => (r.issues || []).filter(i => (i.severity || "").toUpperCase() === "CRÍTICA"));
    const rows = results.map(r => {
        const items = (r.issues || []).map((i, idx) => `
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
.crit{background:#ffe5e5;color:#900}
</style>
</head><body>
<h1>Ollama Code Review</h1>
<div class="summary">
  <span class="tag">Archivos: ${results.length}</span>
  <span class="tag">Issues: ${totalIssues}</span>
  <span class="tag ${criticas.length ? "crit" : ""}">CRÍTICAS: ${criticas.length}</span>
  <a class="tag" href="./report.json" download>Descargar JSON</a>
</div>
<table><thead>
  <tr><th>#</th><th>Archivo</th><th>Severidad</th><th>Línea(s)</th><th>Descripción</th><th>Solución</th><th>Explicación</th></tr>
</thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function generateMarkdownSummary(results, maxItems = 60) {
    const counts = { CRÍTICA: 0, ALTA: 0, MEDIA: 0, BAJA: 0 }; const flat = [];
    for (const r of results) {
        for (const i of (r.issues || [])) {
            const sev = (i.severity || "").toUpperCase();
            if (counts[sev] !== undefined) counts[sev]++;
            flat.push({ file: r.file, ...i });
        }
    }
    const header = [
        `# 🧠 Ollama Code Review`,
        ``,
        `**Archivos:** ${results.length}  |  **Issues:** ${flat.length}`,
        `- CRÍTICA: ${counts["CRÍTICA"]}  |  ALTA: ${counts["ALTA"]}  |  MEDIA: ${counts["MEDIA"]}  |  BAJA: ${counts["BAJA"]}`,
        ``
    ].join("\n");
    if (flat.length === 0) return header + `✅ Sin hallazgos.\n`;

    const lines = flat.slice(0, maxItems).map((i, idx) => {
        const sev = i.severity || "";
        const ln = i.line ?? "";
        const desc = i.description || "";
        const sol = i.solution ? `\n  - _Fix:_\n\n    \`\`\`\n${i.solution}\n    \`\`\`` : "";
        const exp = i.explanation ? `\n  - _Por qué:_ ${i.explanation}` : "";
        return `**${idx + 1}. [${sev}]** \`${i.file}:${ln}\` — ${desc}${sol}${exp}`;
    });
    const tail = flat.length > maxItems ? `\n> _Mostrando ${maxItems} de ${flat.length} issues._` : "";
    return [header, ...lines, tail, `\n_Artefacto: **ollama-review** (HTML/JSON)._`].join("\n");
}

function emitAnnotations(results) {
    for (const r of results) {
        for (const i of (r.issues || [])) {
            const cmd = severityToCommand(i.severity);
            const line = firstLine(i.line);
            const loc = []; if (r.file) loc.push(`file=${r.file}`); if (line) loc.push(`line=${line}`);
            const header = loc.length ? `${cmd} ${loc.join(",")}` : cmd;
            const msg = `${i.description || "Issue"}${i.explanation ? ` — ${i.explanation}` : ""}`;
            console.log(`::${header}::${msg}`);
        }
    }
}

function writeStepSummary(md) {
    const p = process.env.GITHUB_STEP_SUMMARY;
    if (p) fs.appendFileSync(p, md + "\n");
}

/* ===== Files ===== */
function negativePatternsFromExclude(exclude_glob) {
    if (!exclude_glob) return [];
    const lines = String(exclude_glob).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines.map(p => (p.startsWith("!") ? p : `!${p}`));
}

async function resolveFiles({ file_list_path, file_list, file_glob, exclude_glob }) {
    let files = [];
    if (file_list_path) {
        try {
            const raw = fs.readFileSync(file_list_path, "utf8");
            files = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            core.info(`[debug] using file_list_path (${files.length})`);
        } catch { core.warning(`No se pudo leer file_list_path: ${file_list_path}`); }
    }
    if (files.length === 0 && file_list) {
        files = file_list.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        core.info(`[debug] using file_list (${files.length})`);
    }
    if (files.length === 0) {
        const negs = negativePatternsFromExclude(exclude_glob);
        const defaultNegs = [
            "!**/node_modules/**", "!**/dist/**", "!**/build/**", "!**/.next/**", "!**/coverage/**",
            "!**/ollama-review-report/**", "!**/.git/**",
            "!**/*.png", "!**/*.jpg", "!**/*.jpeg", "!**/*.gif", "!**/*.webp", "!**/*.pdf", "!**/*.zip", "!**/*.ico", "!**/*.wasm", "!**/*.exe", "!**/*.dll", "!**/*.so",
            "!**/*.lock", "!package-lock.json", "!yarn.lock", "!pnpm-lock.yaml"
        ];
        const patterns = [file_glob, ...defaultNegs, ...negs];
        core.info(`[debug] glob.patterns="${show(patterns.join(" | "))}"`);
        files = await fg(patterns, { dot: true });
    } else {
        const bin = /\.(png|jpg|jpeg|gif|webp|pdf|zip|ico|wasm|exe|dll|so)$/i;
        files = uniqKeepOrder(files.filter(f => f && !bin.test(f) && fs.existsSync(f) && fs.statSync(f).isFile()));
    }
    return files;
}

/* ===== Ollama ===== */
async function callOllamaChat(serverUrl, model, userPrompt, timeoutMs) {
    const url = `${serverUrl.replace(/\/$/, "")}/api/chat`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                stream: false,
                keep_alive: "10m",
                options: globalThis.__OLLAMA_OPTIONS__ || {},
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ]
            }),
            signal: ac.signal
        });
        clearTimeout(to);
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Ollama error: ${res.status} ${res.statusText} - ${txt}`);
        }
        const data = await res.json();
        return data?.message?.content ?? "";
    } finally { clearTimeout(to); }
}

/* ===== Programa principal ===== */
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

        const requestTimeoutMs = parseInt(core.getInput("request_timeout_ms") || "300000", 10);
        const maxBytesPerFile = parseInt(core.getInput("max_bytes_per_file") || "200000", 10);
        const numPredict = parseInt(core.getInput("ollama_num_predict") || "256", 10);
        const numCtx = parseInt(core.getInput("ollama_num_ctx") || "1536", 10);
        const temperature = parseFloat(core.getInput("ollama_temperature") || "0");
        const maxConc = parseInt(core.getInput("review_max_concurrency") || "1", 10);

        const cpuThreads = Math.max(2, (os.cpus()?.length || 2) - 1);
        globalThis.__OLLAMA_OPTIONS__ = { temperature, num_predict: numPredict, num_ctx: numCtx, num_thread: cpuThreads };

        core.info(`[inputs] model="${show(model)}" server_url="${show(serverUrl)}"`);
        core.info(`[inputs] file_glob="${show(file_glob)}"`);
        core.info(`[inputs] exclude_glob="${show(exclude_glob)}"`);
        core.info(`[inputs] request_timeout_ms=${requestTimeoutMs} max_bytes_per_file=${maxBytesPerFile} num_predict=${numPredict} num_ctx=${numCtx} threads=${cpuThreads} conc=${maxConc}`);

        const files = await resolveFiles({ file_list_path, file_list, file_glob, exclude_glob });
        core.info(`[debug] files.count=${files.length}`);
        if (files.length) core.info(`[debug] files.preview=${show(files.slice(0, 20).join(", "))}`);
        if (files.length === 0) core.warning("No se encontraron archivos a revisar.");

        const results = [];
        for (const file of files) {
            let content = "";
            try { content = fs.readFileSync(file, "utf8"); }
            catch { core.warning(`No se pudo leer como texto: ${file}`); continue; }
            const extension = extOf(file);
            const prompt = buildUserPrompt(file, extension, truncateByBytes(content, maxBytesPerFile));
            const raw = await callOllamaChat(serverUrl, model, prompt, requestTimeoutMs);
            const issues = safeParseJsonArray(raw, []);
            results.push({ file, issues });
        }

        // Reportes
        const outDir = path.join(process.cwd(), "ollama-review-report");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(results, null, 2));
        fs.writeFileSync(path.join(outDir, "index.html"), generateHtmlReport(results));
        const summaryMd = generateMarkdownSummary(results, 60);
        fs.writeFileSync(path.join(outDir, "summary.md"), summaryMd);

        core.info(`Reporte generado en ${outDir}`);

        // UI
        emitAnnotations(results);
        writeStepSummary(summaryMd);

        // Outputs
        core.setOutput("report_dir", outDir);
        core.setOutput("summary_md_path", path.join(outDir, "summary.md"));
        core.setOutput("retention_days", retentionDays.toString());

        // Gate
        const anyCritica = results.some(r => r.issues?.some(i => (i.severity || "").toUpperCase() === "CRÍTICA"));
        if (failOnCritica && anyCritica) {
            core.setFailed("Se encontraron issues con severidad CRÍTICA.");
        }
    } catch (err) {
        core.setFailed(err?.message || String(err));
    }
}

run();
