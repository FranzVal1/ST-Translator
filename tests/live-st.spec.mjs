import { test, expect } from '@playwright/test';

// Opt-in: install this working tree in a disposable SillyTavern instance first.
// This test sends only these synthetic messages to the real Google route.
test('real SillyTavern loads manifest hook and translates prompt copies', async ({page}) => {
    test.setTimeout(120000);
    const requests = [];
    page.on('request', request => { if (request.url().includes('/api/translate/')) requests.push(request.postDataJSON()); });
    await page.goto(process.env.ST_URL ?? 'http://127.0.0.1:18765/');
    await page.waitForFunction(() => typeof globalThis.safeTranslationInterceptor === 'function' && document.querySelector('#st_safe_outgoing'), {timeout:60000});
    const result = await page.evaluate(async () => {
        const {getContext, extension_settings, runGenerationInterceptors} = await import('/scripts/extensions.js');
        const {eventSource, event_types} = await import('/script.js');
        extension_settings.translate.auto_mode = 'none';
        Object.assign(extension_settings.safe_translation, {enabled:true, autoIncoming:false, autoOutgoing:true, outgoingLanguage:'en', targetLanguage:'ru', provider:'google'});
        const context = getContext();
        const source = 'Привет, как дела? <instruction>НЕ_ОТПРАВЛЯТЬ</instruction> <span hidden>SECRET_HIDDEN</span>';
        const player = {name:'Test player', mes:source, is_user:true, is_system:false, send_date:Date.now(), extra:{}};
        context.chat.push(player);
        await eventSource.emit(event_types.MESSAGE_SENT, context.chat.length - 1);
        const prompt = [{...player}];
        const aborted = await runGenerationInterceptors(prompt, 4096, 'normal');
        const repeated = [{...player}];
        const again = await runGenerationInterceptors(repeated, 4096, 'normal');
        return {aborted, again, original:player.mes, source, translated:prompt[0].mes, repeated:repeated[0].mes, stored:player.extra.safe_translation_outgoing};
    });
    expect(result.aborted).toBe(false);
    expect(result.again).toBe(false);
    expect(result.original).toBe(result.source);
    expect(result.translated).not.toBe(result.source);
    expect(result.translated).toContain('<instruction>НЕ_ОТПРАВЛЯТЬ</instruction>');
    expect(result.translated).toContain('<span hidden>SECRET_HIDDEN</span>');
    expect(result.repeated).toBe(result.translated);
    expect(result.stored.translatedText).toBe(result.translated);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toMatch(/НЕ_ОТПРАВЛЯТЬ|SECRET_HIDDEN/);
    console.log(JSON.stringify({test:'real Google + native ST interceptor', ...result, requests}, null, 2));
});

test('real incoming translation preserves hidden text and translates visible attributes', async ({page}) => {
    test.setTimeout(120000);
    const requests=[];
    page.on('request',r=>{if(r.url().includes('/api/translate/')) requests.push(r.postDataJSON());});
    await page.goto(process.env.ST_URL ?? 'http://127.0.0.1:18765/');
    await page.waitForFunction(()=>document.querySelector('#st_safe_attrs'));
    const result=await page.evaluate(async()=>{
        const {getContext,extension_settings}=await import('/scripts/extensions.js');
        const {eventSource,event_types}=await import('/script.js');
        Object.assign(extension_settings.safe_translation,{enabled:true,autoIncoming:true,autoOutgoing:false,translateAttributes:true,targetLanguage:'ru',provider:'google'});
        extension_settings.translate.auto_mode='none';
        const ctx=getContext();
        const message={name:'Test',is_user:false,is_system:false,mes:'<button title="Open">Hello</button><div hidden>HIDDEN_SECRET</div>',extra:{},send_date:Date.now()};
        ctx.chat.push(message);
        ctx.addOneMessage(message);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED,ctx.chat.length-1);
        return {source:message.mes,translated:message.extra.display_text};
    });
    expect(result.translated).toContain('<div hidden>HIDDEN_SECRET</div>');
    expect(result.translated).not.toContain('title="Open"');
    expect(result.translated).not.toContain('>Hello</button>');
    expect(result.source).toContain('title="Open"');
    expect(JSON.stringify(requests)).not.toContain('HIDDEN_SECRET');
    console.log(JSON.stringify({test:'real incoming attributes',...result,requests},null,2));
});

test('manual message button translates and toggles through native host click handlers', async ({page}) => {
    let requests=0;
    await page.route('**/api/translate/google', async route=>{
        requests++;
        await route.fulfill({status:200,contentType:'text/plain',body:'Проверка кнопки'});
    });
    await page.goto(process.env.ST_URL ?? 'http://127.0.0.1:18765/');
    await page.waitForFunction(()=>document.querySelector('#st_safe_auto'));
    const id=await page.evaluate(async()=>{
        const {getContext,extension_settings}=await import('/scripts/extensions.js');
        extension_settings.translate.auto_mode='none';
        Object.assign(extension_settings.safe_translation,{enabled:true,autoIncoming:false,provider:'google',targetLanguage:'ru'});
        globalThis.__clickErrors=[];
        toastr.error=message=>globalThis.__clickErrors.push(String(message));
        const ctx=getContext();
        const message={name:'Test',mes:'Button test',is_user:false,is_system:false,extra:{},send_date:Date.now()};
        ctx.chat.push(message);ctx.addOneMessage(message);
        return ctx.chat.length-1;
    });
    const button=page.locator(`#chat .mes[mesid="${id}"] .safe_translate_button`);
    await button.waitFor({state:'attached'});
    await button.dispatchEvent('click');
    await expect.poll(async()=>page.evaluate(async id=>{
        const {getContext}=await import('/scripts/extensions.js');
        return {display:getContext().chat[id].extra.display_text,errors:globalThis.__clickErrors};
    },id)).toEqual({display:'Проверка кнопки',errors:[]});
    await button.dispatchEvent('click');
    await expect.poll(()=>page.evaluate(async id=>{
        const {getContext}=await import('/scripts/extensions.js');
        return getContext().chat[id].extra.display_text ?? null;
    },id)).toBe(null);
    await button.dispatchEvent('click');
    await expect.poll(()=>page.evaluate(async id=>{
        const {getContext}=await import('/scripts/extensions.js');
        return getContext().chat[id].extra.display_text;
    },id)).toBe('Проверка кнопки');
    expect(requests).toBe(1);
});
