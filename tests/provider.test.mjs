import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator } from '../provider.js';
const options = { preserveCode: true, preserveMacros: true, preserveUrls: true, preserveAngleInstructions: true, minTextLength: 1, provider: 'yandex', targetLanguage: 'en', retries: 1, timeoutMs: 1000, cache: true };
test('Yandex uses chunks; transient errors retry; permanent errors do not', async () => {
    const calls = [];
    const translator = createTranslator({ fetchFn: async (url, args) => {
        calls.push({url, body: JSON.parse(args.body)});
        return calls.length === 1 ? new Response('busy', {status: 429, headers: {'Retry-After':'0'}}) : new Response('Hello');
    }, headers: () => ({'Content-Type':'application/json'}) });
    assert.equal(await translator('Привет', options, new AbortController().signal), 'Hello');
    assert.deepEqual(calls[0].body, {chunks:['Привет'], lang:'en'});
    assert.equal(calls.length, 2);
    let count = 0;
    const bad = createTranslator({fetchFn: async () => { count++; return new Response('bad request', {status:400}); }, headers: () => ({})});
    await assert.rejects(bad('Привет', options, new AbortController().signal), /HTTP 400/);
    assert.equal(count, 1);
});
test('request timeout rejects, and cancellation stops retries', async () => {
    const translator = createTranslator({fetchFn: (_, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})), headers: () => ({})});
    await assert.rejects(translator('Привет', {...options, timeoutMs: 10, retries:0}, new AbortController().signal), /время|timeout/i);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(translator('Привет', options, controller.signal), {name:'AbortError'});
});

test('concurrent identical translations keep LRU accounting bounded', async () => {
    const {translationSignature} = await import('../provider.js');
    let calls = 0;
    const t = createTranslator({headers:()=>({}), maxCacheChars:translationSignature('Hello',options).length + 5,
        fetchFn:async()=>{ calls++; return new Response('Hello'); }});
    await Promise.all(Array.from({length:3},()=>t('Hello',options,new AbortController().signal)));
    await t('Hello',options,new AbortController().signal);
    assert.equal(calls, 3);
});
