import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../runtime.js';
function fixture(overrides = {}) {
    const chat = [{mes:'Привет', is_user:true, extra:{}}, {mes:'Hello', is_user:false, extra:{}}];
    const s = {enabled:true, autoOutgoing:true, outgoingLanguage:'en', targetLanguage:'ru', provider:'google'};
    let saves = 0; const requests = [];
    const context = {chat, chatId:'a', saveChat: async () => { saves++; }};
    const runtime = createRuntime({getContext: () => context, getSettings: () => s,
        translate: async (source, settings) => { requests.push([source, settings.targetLanguage]); return source === 'Привет' ? 'Hello player' : 'Привет персонаж'; },
        update: () => {}, notify: () => {}, progress: () => {}, ask: async () => 'cancel', ...overrides});
    return {chat, s, context, runtime, requests, saves: () => saves};
}
test('outgoing interceptor translates every prompt without changing original or re-requesting', async () => {
    const f = fixture();
    for (let turn = 0; turn < 2; turn++) {
        const prompt = f.chat.map(m => ({...m}));
        let aborted = false;
        await f.runtime.intercept(prompt, () => { aborted = true; });
        assert.equal(aborted, false);
        assert.equal(prompt[0].mes, 'Hello player');
        assert.equal(f.chat[0].mes, 'Привет');
        assert.equal(prompt[1].mes, 'Hello');
    }
    assert.equal(f.requests.length, 1);
    assert.equal(f.chat[0].extra.safe_translation_outgoing.translatedText, 'Hello player');
});
export { fixture };

for (const change of ['chat', 'scope', 'message']) {
    test(`edited does not translate a stale slot after save changes ${change}`, async () => {
        const f = fixture();
        f.s.autoIncoming = true;
        const message = f.chat[1];
        message.extra = {safe_translation:{source:'Old', translatedText:'Старый'}, display_text:'Старый'};
        let release;
        f.context.saveChat = () => release ? Promise.resolve() : new Promise(resolve => { release = resolve; });
        const task = f.runtime.edited(1);
        assert.equal(typeof release, 'function');
        if (change === 'chat') {
            f.context.chat = [f.chat[0], {mes:'Other chat', extra:{}}];
            f.context.chatId = 'b';
        } else if (change === 'scope') {
            f.runtime.invalidate();
        } else {
            f.chat[1] = {mes:'Replacement', extra:{}};
        }
        release();
        await task;
        assert.deepEqual(f.requests, []);
        assert.equal(f.context.chat[1].extra.display_text, undefined);
    });
}

test('chat queue is cancellable, single-flight and never continues into a new chat', async () => {
    let release; let calls = 0;
    const f = fixture({translate: async () => { calls++; return await new Promise(resolve => {release = resolve;}); }});
    f.chat.push({mes:'Another', extra:{}});
    const task = f.runtime.translateChat();
    await Promise.resolve();
    await f.runtime.translateChat();
    assert.equal(calls, 1);
    f.runtime.invalidate();
    f.context.chat = [{mes:'New chat', extra:{}}]; f.context.chatId = 'b';
    release('Перевод'); await task;
    assert.equal(calls, 1);
    assert.equal(f.chat[1].extra.display_text, undefined);
    assert.equal(f.context.chat[0].extra.display_text, undefined);
});
test('bulk saves once, retries only failures and preserves foreign display text', async () => {
    let fail = true;
    const f = fixture({translate: async text => { if (text === 'Bad' && fail) throw Error('offline'); return 'Перевод'; }});
    f.chat.push({mes:'Bad', extra:{}});
    await f.runtime.translateChat();
    assert.equal(f.saves(), 1);
    assert.equal(f.chat[1].extra.display_text, 'Перевод');
    fail = false;
    await f.runtime.translateChat(true);
    assert.equal(f.chat[2].extra.display_text, 'Перевод');
    f.chat.push({mes:'Foreign', extra:{display_text:'Other extension'}});
    await f.runtime.clear();
    assert.equal(f.chat[3].extra.display_text, 'Other extension');
    assert.equal(f.chat[1].extra.display_text, undefined);
});

test('toggle reuses saved translation; edits invalidate outgoing and incoming views', async () => {
    const f = fixture();
    await f.runtime.translateMessage(1);
    await f.runtime.toggle(1);
    assert.equal(f.chat[1].extra.display_text, undefined);
    await f.runtime.toggle(1);
    assert.equal(f.chat[1].extra.display_text, 'Привет персонаж');
    assert.equal(f.requests.length, 1);
    await f.runtime.intercept(f.chat.map(m => ({...m})), () => assert.fail('aborted'));
    await f.runtime.toggle(0);
    assert.equal(f.chat[0].extra.display_text, 'Hello player');
    f.chat[0].mes = 'Новая реплика';
    await f.runtime.edited(0);
    assert.equal(f.chat[0].extra.display_text, undefined);
    assert.equal(f.chat[0].extra.safe_translation_outgoing, undefined);
});

test('unchanged outgoing translations are persisted and not requested every turn', async () => {
    let calls = 0;
    const f = fixture({translate:async text => { calls++; return text; }});
    for (let i=0; i<2; i++) await f.runtime.intercept(f.chat.map(m=>({...m})), ()=>assert.fail());
    assert.equal(calls, 1);
});
test('refreshing outgoing translation also refreshes its visible preview', async () => {
    const f = fixture();
    await f.runtime.intercept(f.chat.map(m=>({...m})), ()=>assert.fail());
    await f.runtime.toggle(0);
    const prompt = f.chat.map(m=>({...m})); prompt[0].mes = 'Changed by prompt regex';
    await f.runtime.intercept(prompt, ()=>assert.fail());
    assert.equal(f.chat[0].extra.display_text, 'Привет персонаж');
    await f.runtime.toggle(0);
    assert.equal(f.chat[0].extra.display_text, undefined);
});

test('failed outgoing translation aborts by default; original needs explicit consent', async () => {
    for (const choice of ['cancel','original','retry']) {
        let calls = 0; let asked = 0;
        const f = fixture({translate:async()=>{ if (++calls === 1) throw Error('offline'); return 'Recovered'; }, ask:async()=>{ asked++; return choice; }});
        const prompt = f.chat.map(m=>({...m})); let aborted = false;
        await f.runtime.intercept(prompt,()=>{aborted=true;});
        assert.equal(asked, 1);
        assert.equal(aborted, choice === 'cancel');
        assert.equal(prompt[0].mes, choice === 'retry' ? 'Recovered' : 'Привет');
        assert.equal(f.chat[0].mes, 'Привет');
        if (choice === 'original') assert.equal(f.chat[0].extra.safe_translation_outgoing, undefined);
    }
});
for (const change of ['chat', 'scope']) {
    test(`outgoing aborts when ${change} changes during final save`, async () => {
        const f = fixture();
        let release;
        let entered;
        const saving = new Promise(resolve => { entered = resolve; });
        f.context.saveChat = () => new Promise(resolve => { release = resolve; entered(); });
        const aborted = [];
        const task = f.runtime.intercept(f.chat.map(m => ({...m})), value => aborted.push(value));
        await saving;
        assert.deepEqual(aborted, []);
        if (change === 'chat') {
            f.context.chat = [];
            f.context.chatId = 'b';
        } else {
            f.runtime.invalidate();
        }
        release();
        await task;
        assert.deepEqual(aborted, [true]);
    });
}

test('outgoing cancellation and concurrent generation never apply a partial prompt', async () => {
    let release;
    const f = fixture({translate:async()=>new Promise(resolve=>{release=resolve;})});
    const prompt = f.chat.map(m=>({...m})); let aborted = false;
    const task = f.runtime.intercept(prompt,()=>{aborted=true;});
    let duplicateAborted=false;
    await f.runtime.intercept(f.chat.map(m=>({...m})),()=>{duplicateAborted=true;});
    assert.equal(duplicateAborted,true);
    f.runtime.invalidate(); release('Hello'); await task;
    assert.equal(aborted,true);
    assert.equal(prompt[0].mes,'Привет');
    assert.equal(f.chat[0].extra.safe_translation_outgoing,undefined);
});
for (const cached of [false, true]) {
    test(`incoming preserves display claimed in flight (cached=${cached})`, async () => {
        let release;
        const f = fixture({translate: async () => new Promise(resolve => { release = resolve; })});
        const message = f.chat[1];
        const record = cached ? {source:message.mes, translatedText:'Previous'} : undefined;
        if (cached) {
            message.extra.safe_translation = record;
            message.extra.display_text = record.translatedText;
        }
        const task = f.runtime.translateMessage(1, {force:true});
        message.extra.display_text = 'Other extension';
        release('Our translation');
        assert.equal(await task, false);
        assert.equal(message.extra.display_text, 'Other extension');
        assert.equal(message.extra.safe_translation, record);
        assert.equal(f.saves(), 0);
    });
}

for (const change of ['shift', 'remove']) {
    test(`incoming cleanup never updates the wrong slot after ${change}`, async () => {
        let release;
        const updates = [];
        const f = fixture({
            translate: async () => new Promise(resolve => { release = resolve; }),
            update: (id, message, busy) => updates.push({id, message, busy, associated:f.chat[id] === message}),
        });
        f.chat.push({mes:'Next', extra:{}});
        const message = f.chat[1];
        const task = f.runtime.translateMessage(1);
        if (change === 'shift') f.chat.shift();
        else f.chat.splice(1, 1);
        release('Stale');
        assert.equal(await task, false);
        assert.ok(updates.every(u => u.associated), 'every update must target its actual message slot');
        assert.equal(message.extra.display_text, undefined);
        assert.equal(f.saves(), 0);
    });
}

test('incoming stale swipe and edits never overwrite a new message', async () => {
    let release;
    const f = fixture({translate:async()=>new Promise(resolve=>{release=resolve;})});
    const job = f.runtime.translateMessage(1);
    f.chat[1].swipe_id=1;
    release('Stale'); await job;
    assert.equal(f.chat[1].extra.display_text,undefined);
});
test('outgoing honors prompt-only transformations, skips system and command messages', async () => {
    const f = fixture();
    const prompt = [{...f.chat[0], mes:'Regex transformed'}, {is_user:true,is_system:true,mes:'Secret'}, {is_user:true,mes:'/help'}];
    await f.runtime.intercept(prompt,()=>assert.fail());
    assert.deepEqual(f.requests, [['Regex transformed','en']]);
    assert.equal(f.chat[0].mes,'Привет');
});

test('outgoing raw prompt and safe preview use distinct serializations', async()=>{
    const f=fixture({translate:async()=>({prompt:'Tom & Jerry < 5',display:'Tom &amp; Jerry &lt; 5'})});
    const prompt=f.chat.map(m=>({...m}));
    await f.runtime.intercept(prompt,()=>assert.fail());
    assert.equal(prompt[0].mes,'Tom & Jerry < 5');
    await f.runtime.toggle(0);
    assert.equal(f.chat[0].extra.display_text,'Tom &amp; Jerry &lt; 5');
    await f.runtime.toggle(0);
    assert.equal(f.chat[0].extra.display_text,undefined);
});
