import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';

const rootDir = process.cwd();

async function run() {
  console.log('🚀 [1/3] Building Popup + Side Panel...');
  await build({
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: resolve(rootDir, 'popup.html'),
          sidepanel: resolve(rootDir, 'sidepanel.html')
        }
      }
    }
  });

  console.log('📦 [2/3] Building Content Script as self-contained IIFE...');
  await build({
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(rootDir, 'src/content/index.tsx'),
        output: {
          format: 'iife',
          entryFileNames: 'content.js'
        }
      }
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production')
    }
  });

  console.log('📋 [3/3] Emitting content.css, manifest.json, icons, fonts, background.js...');

  // Combine styles for content.css
  const tokensCss = fs.readFileSync(resolve(rootDir, 'src/styles/tokens.css'), 'utf-8');
  const fontsCss = fs.readFileSync(resolve(rootDir, 'src/styles/fonts.css'), 'utf-8');
  let inlineCss = fs.readFileSync(resolve(rootDir, 'src/content/inline.css'), 'utf-8');
  inlineCss = inlineCss.replace(/@import\s+['"'][^'"]+['"'];?/g, '');

  const combinedContentCss = `/* PromptEco Content Script Styles */\n${tokensCss}\n\n${fontsCss}\n\n${inlineCss}`;
  fs.writeFileSync(resolve(rootDir, 'dist/content.css'), combinedContentCss, 'utf-8');

  // Copy manifest.json
  fs.copyFileSync(
    resolve(rootDir, 'public/manifest.json'),
    resolve(rootDir, 'dist/manifest.json')
  );

  // Copy background.js service worker
  fs.copyFileSync(
    resolve(rootDir, 'public/background.js'),
    resolve(rootDir, 'dist/background.js')
  );

  // Copy icons
  fs.cpSync(resolve(rootDir, 'public/icons'), resolve(rootDir, 'dist/icons'), { recursive: true });

  // Copy fonts if present
  if (fs.existsSync(resolve(rootDir, 'public/fonts'))) {
    fs.cpSync(resolve(rootDir, 'public/fonts'), resolve(rootDir, 'dist/fonts'), { recursive: true });
  }

  // Fix popup.html + sidepanel.html: convert absolute /assets/ paths to relative ./assets/
  for (const htmlFile of ['popup.html', 'sidepanel.html']) {
    const htmlPath = resolve(rootDir, 'dist', htmlFile);
    if (fs.existsSync(htmlPath)) {
      let html = fs.readFileSync(htmlPath, 'utf-8');
      html = html.replace(/(src|href)="\/assets\//g, '$1="./assets/');
      fs.writeFileSync(htmlPath, html, 'utf-8');
    }
  }

  console.log('✅ PromptEco extension build finished successfully!');
}

run().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
