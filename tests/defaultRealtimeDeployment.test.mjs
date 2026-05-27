import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('repo defaults use gpt-realtime-1.5 for production stability', () => {
  assert.match(fs.readFileSync('app.js', 'utf8'), /realtimeDeployment: 'gpt-realtime-1\.5'/);
  assert.match(fs.readFileSync('infra/main.bicep', 'utf8'), /param realtimeDeployment string = 'gpt-realtime-1\.5'/);
  assert.match(fs.readFileSync('infra/main.parameters.json', 'utf8'), /REALTIME_DEPLOYMENT=gpt-realtime-1\.5/);
  assert.match(fs.readFileSync('api/local.settings.sample.json', 'utf8'), /"REALTIME_DEPLOYMENT": "gpt-realtime-1\.5"/);
});
