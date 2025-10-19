const esbuild = require('esbuild');

esbuild.build({
    entryPoints: ['index.js'],   // o 'src/index.ts' si usas TS
    bundle: true,                // <- VENDEAR deps
    platform: 'node',
    format: 'cjs',               // <- CommonJS
    target: 'node20',
    outfile: 'dist/index.cjs',
    sourcemap: false,
    minify: true,
    legalComments: 'none'
}).catch((err) => { console.error(err); process.exit(1); });
