import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForProvider, translateSafely } from '../translation.js';
const options = { preserveCode: true, preserveMacros: true, preserveUrls: true, preserveAngleInstructions: true, translateAttributes: false, minTextLength: 1 };
test('bounded batches translate only visible segments and preserve identity', async () => {
    const calls = [];
    const source = '<div hidden>SECRET</div><b>Hello</b> <i>world</i> {{user}}';
    const result = await translateSafely(source, options, async text => { calls.push(text); return text.replace('Hello', 'Привет').replace('world', 'мир'); }, new AbortController().signal, 100);
    assert.equal(result, '<div hidden>SECRET</div><b>Привет</b> <i>мир</i> {{user}}');
    assert.ok(calls.every(x => x.length <= 100 && !x.includes('SECRET') && !x.includes('{{user}}')));
});
test('split never exceeds provider limit or breaks surrogate pairs', () => {
    for (const source of ['a'.repeat(10) + ' xyz', '123456789😀x', 'x'.repeat(55)]) {
        const chunks = splitForProvider(source, 10);
        assert.equal(chunks.join(''), source);
        assert.ok(chunks.every(x => x.length <= 10 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(x)));
    }
});
