import {test,expect} from '@playwright/test';

// Opt-in live smoke; synthetic text only, no settings/chat writes.
// Map a non-localhost name to the test server to exercise insecure HTTP.
test.use({launchOptions:{args:['--host-resolver-rules=MAP st-http.test 127.0.0.1','--no-proxy-server']}});
test('Google translation works on an insecure HTTP origin',async({page})=>{
    test.setTimeout(60000);
    await page.goto(process.env.ST_HTTP_URL ?? 'http://st-http.test:8000/');
    await page.waitForFunction(()=>typeof globalThis.safeTranslationInterceptor==='function');
    const result=await page.evaluate(async()=>{
        const {createTranslator}=await import('/scripts/extensions/third-party/ST-Translator/provider.js');
        const {getRequestHeaders}=await import('/script.js');
        const {extension_settings}=await import('/scripts/extensions.js');
        const options={...extension_settings.safe_translation,provider:'google',targetLanguage:'en',outputMode:'both',timeoutMs:10000,retries:0};
        const translated=await createTranslator({headers:getRequestHeaders})('Привет, как дела?',options,new AbortController().signal);
        return {secure:isSecureContext,uuid:typeof crypto.randomUUID,translated};
    });
    expect(result.secure).toBe(false);
    expect(result.uuid).toBe('undefined');
    expect(result.translated.prompt).toMatch(/hi|hello/i);
    expect(result.translated.display).toBe(result.translated.prompt);
    console.log(JSON.stringify(result));
});
