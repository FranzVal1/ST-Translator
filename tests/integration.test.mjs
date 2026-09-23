import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import jquery from 'jquery';

test('extension UI enables outgoing interceptor and preserves editor original', async () => {
    const dom = new JSDOM('<div id="extensions_settings2"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_buttons"><button class="mes_edit">Edit</button></div></div></div>', {url:'http://localhost'});
    const $ = jquery(dom.window);
    for (const key of ['document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'MutationObserver', 'Event', 'InputEvent']) globalThis[key] = dom.window[key];
    globalThis.$ = $;
    globalThis.toastr = {error:()=>{}, warning:()=>{}, info:()=>{}, clear:()=>{}};
    const events = new Map();
    const settings = {};
    const context = {chatId:'chat', chat:[{mes:'Привет', is_user:true, extra:{}}], saveChat:async()=>{}};
    globalThis.__st = {
        eventSource:{on:(name, fn)=>events.set(name, fn), off:()=>{}},
        event_types:Object.fromEntries(['CHARACTER_MESSAGE_RENDERED','MESSAGE_SWIPED','CHAT_CHANGED','MESSAGE_UPDATED','MESSAGE_SENT','GENERATION_STOPPED'].map(x=>[x,x])),
        getRequestHeaders:()=>({'Content-Type':'application/json'}), saveSettingsDebounced:()=>{}, updateMessageBlock:()=>{},
        extension_settings:settings, getContext:()=>context,
        POPUP_TYPE:{CONFIRM:1}, callGenericPopup:async()=>0,
    };
    globalThis.fetch = async (_, args) => new Response(JSON.parse(args.body).text.replace('Привет', 'Hello'));
    const moduleStub = 'data:text/javascript,' + encodeURIComponent('export const {eventSource,event_types,getRequestHeaders,saveSettingsDebounced,updateMessageBlock,extension_settings,getContext,POPUP_TYPE,callGenericPopup}=globalThis.__st;');
    let code = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    code = code.replace(/from ['"]([^'"]+)['"]/g, (_, path) => `from ${JSON.stringify(path.startsWith('./') ? new URL('../' + path.slice(2), import.meta.url).href : moduleStub)}`);
    const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    await mod.init();
    assert.ok(document.querySelector('#st_safe_outgoing'));
    assert.equal(settings.safe_translation.autoOutgoing, false);
    $('#st_safe_outgoing').prop('checked', true).trigger('change');
    assert.equal(settings.safe_translation.autoOutgoing, true);
    const prompt = context.chat.map(m=>({...m}));
    await globalThis.safeTranslationInterceptor(prompt, 4096, () => assert.fail('aborted'), 'normal');
    assert.equal(prompt[0].mes, 'Hello');
    assert.equal(context.chat[0].mes, 'Привет');
    assert.ok(document.querySelector('.safe_translate_button'));
    document.querySelector('.mes_edit').dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
    const textarea = document.createElement('textarea'); textarea.className='edit_textarea'; textarea.value='Hello';
    document.querySelector('.mes').append(textarea);
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.equal(textarea.value, 'Привет');
    dom.window.close();
});
