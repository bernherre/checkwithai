// Build CJS sólido para GitHub Actions
const esbuild = require('esbuild');

esbuild.build({
    entryPoints: ['index.js'],        // tu entry (si es TS usa index.ts)
    bundle: true,
    platform: 'node',
    format: 'cjs',                    // <- CLAVE: CommonJS
    target: 'node20',
    outfile: 'dist/index.cjs',
    sourcemap: false,
    minify: true,
    legalComments: 'none',
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
