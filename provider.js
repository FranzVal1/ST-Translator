import { PARSER_VERSION, providerChunkLimits, translateSafely } from './translation.js';

export function translationSignature(source, settings) {
    const keys = ['provider', 'targetLanguage', 'preserveCode', 'preserveMacros', 'preserveUrls', 'preserveAngleInstructions', 'translateAttributes', 'translateTitle', 'translateAlt', 'translatePlaceholder', 'translateAriaLabel', 'minTextLength', 'protectedTags', 'protectedClasses'];
    return JSON.stringify([PARSER_VERSION, ...keys.map(k => settings[k]), source]);
}

function delay(ms, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', abort, {once:true});
    });
}

export function createTranslator({fetchFn = fetch, headers, maxCacheChars = 2_000_000}) {
    const cache = new Map();
    let cacheChars = 0;
    const translate = async (source, settings, signal) => {
        // Do not retain a live settings object across await boundaries.
        const s = structuredClone(settings);
        const key = translationSignature(source, s);
        signal.throwIfAborted();
        if (s.cache && cache.has(key)) {
            const result = cache.get(key);
            cache.delete(key); cache.set(key, result);
            return result;
        }
        if (!Object.hasOwn(providerChunkLimits, s.provider)) throw new Error('Неизвестный переводчик');
        const request = async (text, parentSignal) => {
            for (let attempt = 0; ; attempt++) {
                parentSignal.throwIfAborted();
                const controller = new AbortController();
                const abort = () => controller.abort(parentSignal.reason);
                parentSignal.addEventListener('abort', abort, {once:true});
                const timer = setTimeout(() => controller.abort(new Error('Истекло время ожидания перевода')), Math.max(1, s.timeoutMs ?? 30000));
                let retryMs = 500 * 2 ** attempt;
                try {
                    const body = s.provider === 'yandex' ? {chunks:[text], lang:s.targetLanguage} : {text, lang:s.targetLanguage};
                    const response = await fetchFn(`/api/translate/${s.provider}`, {method:'POST', headers:headers(), body:JSON.stringify(body), signal:controller.signal});
                    const result = await response.text();
                    if (!response.ok) {
                        const error = new Error(`${s.provider}: HTTP ${response.status}`);
                        error.retryable = response.status === 429 || response.status >= 500;
                        const after = response.headers.get('Retry-After');
                        if (after !== null) {
                            const seconds = Number(after);
                            const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
                            if (Number.isFinite(wait)) retryMs = Math.max(0, wait);
                        }
                        throw error;
                    }
                    if (!result.trim() || /^\s*(?:<!doctype\s+html|<html)/i.test(result)) {
                        const error = new Error(`${s.provider}: некорректный ответ`);
                        error.retryable = false;
                        throw error;
                    }
                    parentSignal.throwIfAborted();
                    return result;
                } catch (error) {
                    if (parentSignal.aborted) throw parentSignal.reason;
                    if (error.retryable === false || attempt >= Math.min(3, s.retries ?? 1)) throw error;
                } finally {
                    clearTimeout(timer);
                    parentSignal.removeEventListener('abort', abort);
                }
                await delay(retryMs, parentSignal);
            }
        };
        const result = await translateSafely(source, s, request, signal, providerChunkLimits[s.provider]);
        if (s.cache && key.length + result.length <= maxCacheChars) {
            cache.set(key, result); cacheChars += key.length + result.length;
            while (cacheChars > maxCacheChars) {
                const oldest = cache.keys().next().value;
                cacheChars -= oldest.length + cache.get(oldest).length;
                cache.delete(oldest);
            }
        }
        return result;
    };
    translate.clearCache = () => { cache.clear(); cacheChars = 0; };
    return translate;
}
