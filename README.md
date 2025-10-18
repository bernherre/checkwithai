# Ollama Code Review (GitHub Action)

Revisa archivos de tu repo con un modelo **Ollama** y genera:
- `ollama-review-report/index.html` (reporte web)
- `ollama-review-report/report.json` (formato estructurado)
- anotaciones en la UI del job (error/warning/notice)
- resumen en la barra de mensajes (Job Summary)

## Inputs

- `model` (default: `qwen2.5-coder:7b`)
- `server_url` (default: `http://localhost:11434`)
- `file_glob` (default: `**/*`) — fallback 
- `exclude_glob` (default: `node_modules/**`)
- `file_list` — lista multilínea de paths (tiene prioridad sobre `file_glob`)
- `file_list_path` — ruta a archivo con paths (uno por línea). **Mayor prioridad**
- `fail_on_critica` (default: `true`)
- `retention_days` (default: `7`)

## Consejos
- Para PR, pasa `file_list_path` con los archivos cambiados del PR para acelerar.
- Publica el reporte como artefacto y/o en GitHub Pages.

## Ejemplo de tags version
```git rm --cached -r .
git reset --hard
cd action-ollama-codereview
npm ci
npm run build
cd ..
git add .
git commit -m "fix: recursive excludes and default negs in glob"
git push
git tag -a v1.0.10 -m "v1.0.10"
git push origin v1.0.10
git tag -fa v1 -m "v1"
git push origin v1 --force
```

# Ejemplo retag
```git tag -d v1.0.6
git push origin :refs/tags/v1.0.6
git tag -a v1.0.6 -m "v1.0.6"
git push origin v1.0.6

# (opcional) mueve el alias estable
git tag -fa v1 -m "v1"
git push origin v1 --force
```  