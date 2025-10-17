import * as core from "@actions/core";
import fg from "fast-glob";
import fs from "fs";
import path from "path";

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

async function callOllamaChat(serverUrl, model, userPrompt, attempt = 1) {
    const url = `${serverUrl.replace(/\/$/, "")}/api/chat`;
    const body = {
        model,
        stream: false,
        // Puedes pasar opciones para aligerar inferencia:
        // options: { temperature: 0, num_predict: 512, mirostat: 0, num_ctx: 2048 },
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]
    };

    // Timeout 120s
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 120_000);

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
            await new Promise(r => setTimeout(r, backoff));
            return callOllamaChat(serverUrl, model, userPrompt, attempt + 1);
        }
        throw err;
    }
}

function safeParseJsonArray(txt, fallback = []) {
    const tryParse = (s) => {
        try {
            const parsed = JSON.parse(s.trim());
            return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
    };
    let result = tryParse(txt);
    if (result) return result;

    const m = txt.match(/```json([\s\S]*?)```/i) || txt.match(/```([\s\S]*?)```/i);
    if (m?.[1]) {
        result = tryParse(m[1]);
        if (result) return result;
    }
    // Último recurso: busca primer [ ... ]
    const bracket = txt.indexOf("[");
    const last = txt.lastIndexOf("]");
    if (bracket !== -1 && last !== -1 && last > bracket) {
        result = tryParse(txt.slice(bracket, last + 1));
        if (result) return result;
    }
    return fallback;
}

function extOf(file) {
    const e = path.extname(file).replace(".", "");
    return e || "txt";
}

function htmlEscape(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
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

// === Anotaciones en la UI del job ===
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

// === Barra de mensajes (Job Summary) ===
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
        `Descarga: **report.json** (en el artefacto y/o Pages).`,
    ].join("\n");

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) fs.appendFileSync(summaryPath, summary + "\n");
}

function uniqKeepOrder(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
        if (!seen.has(x)) { seen.add(x); out.push(x); }
    }
    return out;
}

async function resolveFiles({ file_list_path, file_list, file_glob, exclude_glob }) {
    let files = [];

    // 1) file_list_path: lee líneas del archivo si existe
    if (file_list_path) {
        try {
            const raw = fs.readFileSync(file_list_path, "utf8");
            files = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        } catch {
            core.warning(`No se pudo leer file_list_path: ${file_list_path}`);
        }
    }

    // 2) file_list: multiline input
    if (files.length === 0 && file_list) {
        files = file_list.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }

    // 3) glob fallback
    if (files.length === 0) {
        const patterns = [
            file_glob,
            `!${exclude_glob}`,
            "!.git/**",
            "!**/*.png", "!**/*.jpg", "!**/*.jpeg", "!**/*.gif", "!**/*.webp",
            "!**/*.pdf", "!**/*.zip", "!**/*.ico", "!**/*.wasm", "!**/*.exe", "!**/*.dll", "!**/*.so"
        ];
        files = await fg(patterns, { dot: true });
    } else {
        // Filtra binarios comunes y exclusiones
        const binRegex = /\.(png|jpg|jpeg|gif|webp|pdf|zip|ico|wasm|exe|dll|so)$/i;
        const excluded = exclude_glob ? await fg([`!${exclude_glob}`], { dot: true }) : null;
        files = files.filter(f =>
            f && !binRegex.test(f) && fs.existsSync(f) && fs.statSync(f).isFile()
        );
        files = uniqKeepOrder(files);
    }

    return files;
}

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

        const files = await resolveFiles({ file_list_path, file_list, file_glob, exclude_glob });

        if (files.length === 0) {
            core.warning("No se encontraron archivos a revisar.");
        }

        const results = [];

        for (const file of files) {
            let content = "";
            try {
                content = fs.readFileSync(file, "utf8");
            } catch {
                core.warning(`No se pudo leer como texto: ${file}`);
                continue;
            }
            const extension = path.extname(file).replace(".", "") || "txt";
            const prompt = buildUserPrompt(file, extension, content);
            const raw = await callOllamaChat(serverUrl, model, prompt);
            const issues = safeParseJsonArray(raw, []);
            results.push({ file, issues });
        }

        // Genera salida web
        const outDir = path.join(process.cwd(), "ollama-review-report");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(results, null, 2));
        fs.writeFileSync(path.join(outDir, "index.html"), generateHtmlReport(results));

        core.info(`Reporte generado en ${outDir}`);

        // Mensajes UI
        emitAnnotations(results);
        writeStepSummary(results);

        // Outputs
        core.setOutput("report_dir", outDir);
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
