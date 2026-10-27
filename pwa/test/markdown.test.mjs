import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMarkdown } from '../public/markdown.js';

test('Markdown parser keeps chat structure without interpreting raw HTML', () => {
  assert.deepEqual(parseMarkdown('# Result\n\n- **Tests:** passed\n- [Preview](https://relay.example.ts.net:3000/)\n\n| Check | Result |\n| --- | --- |\n| Build | Passed |\n\n```sh\nnpm test\n```\n\n<script>alert(1)</script>'), [
    { type: 'heading', level: 1, text: 'Result' },
    { type: 'list', ordered: false, items: ['**Tests:** passed', '[Preview](https://relay.example.ts.net:3000/)'] },
    { type: 'table', headers: ['Check', 'Result'], rows: [['Build', 'Passed']] },
    { type: 'code', language: 'sh', text: 'npm test' },
    { type: 'paragraph', text: '<script>alert(1)</script>' },
  ]);
});
