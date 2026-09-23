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

test('corrupted, duplicated or reordered markers retry only that batch', async () => {
    for (const mode of ['missing','duplicate','reordered']) {
        const calls=[];
        const result=await translateSafely('<b>First</b> <i>Second</i>',options,async text=>{
            calls.push(text);
            const markers=text.match(/\[\[ST_[^\]]+\]\]/g);
            if (!markers) return text.toUpperCase();
            if (mode==='missing') return text.replace(markers[0],'');
            if (mode==='duplicate') return text+markers[0];
            return text.replace(markers[0],'TEMP').replace(markers[1],markers[0]).replace('TEMP',markers[1]);
        },new AbortController().signal,1000);
        assert.equal(result,'<b>FIRST</b> <i>SECOND</i>');
        assert.equal(calls.length,3);
    }
});
test('cancellation during batching prevents fallback requests',async()=>{
    const c=new AbortController();let calls=0;
    await assert.rejects(translateSafely('<b>First</b> <i>Second</i>',options,async()=>{calls++;c.abort();return 'bad';},c.signal,1000),{name:'AbortError'});
    assert.equal(calls,1);
});

test('outgoing serialization separates literal prompt text from safe display HTML', async () => {
    const result = await translateSafely('Hello &amp; {{user}}', {...options, outputMode:'both'}, async()=> 'Tom & Jerry < 5', new AbortController().signal, 1000);
    assert.deepEqual(result, {prompt:'Tom & Jerry < 5 &amp; {{user}}', display:'Tom &amp; Jerry &lt; 5 &amp; {{user}}'});
});

test('HTTP/LAN translation works without secure-context crypto.randomUUID', async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(globalThis.crypto,'randomUUID');
    Object.defineProperty(globalThis.crypto,'randomUUID',{value:undefined,configurable:true});
    try {
        const result=await translateSafely('<b>Hello</b> <i>world</i>',options,async text=>text.replace('Hello','Привет').replace('world','мир'),new AbortController().signal,1000);
        assert.equal(result,'<b>Привет</b> <i>мир</i>');
    } finally {
        if(descriptor) Object.defineProperty(globalThis.crypto,'randomUUID',descriptor);
        else delete globalThis.crypto.randomUUID;
    }
});
