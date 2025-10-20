# Ollama Code Review Action

[![CI](https://github.com/bernherre/checkwithai/actions/workflows/code-review-ollama.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/code-review-ollama.yml)
[![Release](https://img.shields.io/github/v/release/OWNER/REPO?display_name=tag&sort=semver)](https://github.com/OWNER/REPO/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Revisa archivos de código con un **LLM local (Ollama)** y genera:
- **Anotaciones** en el job (warnings/errors) por archivo/línea.
- **Resumen Markdown** (para comentar en PR o commit).
- **Reporte HTML + JSON** (artefacto `ollama-review-report`).

> Ideal para PRs o para ejecutarlo en el main como control de calidad continuo.

---

## ✨ Características

- Soporte para **PR**: revisa sólo archivos cambiados de código.
- Fallback para **push**: usa glob (p.ej. `src/**/*.{ts,tsx,...}`).
- **Fail-fast opcional** si hay issues **CRÍTICA**.
- **Paralelismo controlado** (revisión por archivo).
- Reporte HTML y JSON exportables como artefacto.

---

## 🚀 Requisitos

- Runner Linux con **Ollama** en segundo plano (usamos `ai-action/setup-ollama` en ejemplos).
- Permisos adecuados si quieres comentar en PR/commit:
  ```yaml
  permissions:
    contents: write
    pull-requests: write


| Input                    | Tipo                |                                 Default | Descripción                               |
| ------------------------ | ------------------- | --------------------------------------: | ----------------------------------------- |
| `model`                  | string              |                      `qwen2.5-coder:7b` | Modelo de Ollama a usar.                  |
| `server_url`             | string              |                `http://127.0.0.1:11434` | URL del servidor Ollama.                  |
| `file_glob`              | string              | `**/*.{ts,tsx,js,jsx,py,cs,java,go,rs}` | Patrón glob fallback para archivos.       |
| `exclude_glob`           | string (multilínea) |                          ver action.yml | Exclusiones adicionales.                  |
| `file_list`              | string (multilínea) |                                    `""` | Lista directa de paths (uno por línea).   |
| `file_list_path`         | string              |                                    `""` | Ruta a archivo con paths (uno por línea). |
| `fail_on_critica`        | `true/false`        |                                  `true` | Falla el job si hay alguna **CRÍTICA**.   |
| `retention_days`         | number              |                                     `7` | Retención del artefacto.                  |
| `request_timeout_ms`     | number              |                                `300000` | Timeout por archivo (ms).                 |
| `max_bytes_per_file`     | number              |                                `200000` | Límite de bytes leídos por archivo.       |
| `ollama_num_predict`     | number              |                                   `256` | Tokens de salida (Ollama).                |
| `ollama_num_ctx`         | number              |                                  `1536` | Tamaño de contexto (Ollama).              |
| `ollama_temperature`     | number              |                                     `0` | Temperatura (Ollama).                     |
| `review_max_concurrency` | number              |                                     `1` | Archivos en paralelo.                     |


| Output            | Descripción                                                     |
| ----------------- | --------------------------------------------------------------- |
| `report_dir`      | Directorio donde se generó el reporte (`ollama-review-report`). |
| `summary_md_path` | Ruta al `summary.md` (útil para comentar en PR/commit).         |

## Ejemplo de tags version
```
git rm --cached -r .
git reset --hard
cd action-ollama-codereview
npm ci
npm run build
cd ..
git add .
git commit -m "CJS"
git push
git tag -a v1.4.3 -m "v1.4.3"
git push origin v1.4.3
git tag -fa v1 -m "v1 -> v1.4.3"
git push origin v1 --force
```

# Ejemplo retag
```
git tag -d v1.3.3
git push origin :refs/tags/v1.3.3
git tag -a v1.3.3 -m "v1.3.3"
git push origin v1.3.3

# (opcional) mueve el alias estable
git tag -fa v1 -m "v1 -> v1.3.4"
git push origin v1.3.3 --force
```  