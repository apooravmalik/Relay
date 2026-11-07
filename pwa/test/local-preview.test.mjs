import assert from 'node:assert/strict';
import test from 'node:test';
import { localPreviewPorts } from '../public/local-preview.js';

test('local preview detection accepts private localhost URLs and de-duplicates ports', () => {
  assert.deepEqual(localPreviewPorts('Open http://localhost:3000 and [http://127.0.0.1:3001](http://localhost:3000).'), [3000, 3001]);
});

test('local preview detection excludes privileged and invalid ports', () => {
  assert.deepEqual(localPreviewPorts('localhost:80 localhost:70000 localhost:3000'), [3000]);
});
