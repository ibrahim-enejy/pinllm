import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT_DIR, 'apps/extension');
const PUBLIC_ZIP_PATH = path.join(ROOT_DIR, 'apps/web/public/pinllm-extension.zip');

if (fs.existsSync(PUBLIC_ZIP_PATH)) {
  fs.unlinkSync(PUBLIC_ZIP_PATH);
}

execFileSync(
  'zip',
  ['-r', '-q', PUBLIC_ZIP_PATH, 'manifest.json', 'background.js', 'content.js', 'content.css', 'popup.html', 'popup.js'],
  { cwd: EXT_DIR }
);

const stat = fs.statSync(PUBLIC_ZIP_PATH);
console.log(`Packaged browser extension to ${PUBLIC_ZIP_PATH} (${stat.size} bytes)`);
