'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist');
const files = [
  'index.html',
  'styles.css',
  'app.js',
  'appUtils.mjs',
  'avatarStage.mjs',
  'avatarStageUtils.mjs',
  'coachAdviceClient.mjs',
  'conversationLogClient.mjs',
  'diagnosticEventClient.mjs',
  'realtimeConversationEngine.mjs',
  'realtimeConversationUtils.mjs',
  'staticwebapp.config.json'
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(outDir, file));
}

copyDir(path.join(root, 'assets'), path.join(outDir, 'assets'));

function copyDir(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}
