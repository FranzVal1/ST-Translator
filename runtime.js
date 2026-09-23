import { translationSignature } from './provider.js';

export function createRuntime({getContext, getSettings, translate, update, notify, progress, ask}) {
    let epoch = 0;
    let generation = null;
    let queue = null;
    let failed = [];
    const jobs = new Map();
    const displayOf = record => record?.displayText ?? record?.translatedText;
    const ownedDisplay = message => {
        const extra = message.extra;
        return extra?.safe_translation?.translatedText === extra?.display_text && typeof extra?.display_text === 'string';
    };
    const capture = () => {
        const context = getContext();
        const version = epoch;
        const chatId = context.chatId;
        return {context, valid: () => epoch === version && getContext().chat === context.chat && getContext().chatId === chatId};
    };
    const runtime = {
        invalidate() {
            epoch++; generation?.abort(); queue?.controller.abort();
            for (const job of jobs.values()) job.abort();
            jobs.clear(); failed = [];
            progress({running:false, done:0, total:0, failed:0});
        },
        stop() { queue?.controller.abort(); },
        async translateMessage(id, {force = false, persist = true, signal, settings, quiet = false} = {}) {
            const scope = capture();
            const s = structuredClone(settings ?? getSettings());
            const message = scope.context.chat[id];
            if (!s.enabled || !message || message.is_user || message.is_system || typeof message.mes !== 'string') return true;
            message.extra ??= {};
            const source = message.mes;
            const swipe = message.swipe_id;
            const signature = translationSignature(source, s);
            if (!force && message.extra.safe_translation?.signature === signature) return true;
            // Never overwrite another extension's presentation.
            if (message.extra.display_text && !ownedDisplay(message)) {
                if (!quiet) notify('Отображаемый перевод принадлежит другому расширению.');
                return false;
            }
            jobs.get(message)?.abort();
            const controller = new AbortController();
            jobs.set(message, controller);
            const abort = () => controller.abort(signal.reason);
            signal?.addEventListener('abort', abort, {once:true});
            if (signal?.aborted) abort();
            const valid = () => scope.valid() && !controller.signal.aborted && jobs.get(message) === controller && scope.context.chat[id] === message && message.mes === source && message.swipe_id === swipe;
            update(id, message, true);
            try {
                const translatedText = await translate(source, s, controller.signal);
                if (!valid()) return false;
                if (message.extra.display_text && !ownedDisplay(message)) {
                    if (!quiet) notify('Отображаемый перевод принадлежит другому расширению.');
                    return false;
                }
                message.extra.safe_translation = {signature, source, translatedText, provider:s.provider, targetLanguage:s.targetLanguage};
                message.extra.display_text = translatedText;
                update(id, message, false);
                if (persist) await scope.context.saveChat();
                return true;
            } catch (error) {
                if (valid() && !quiet) notify(error.message);
                return false;
            } finally {
                signal?.removeEventListener('abort', abort);
                if (jobs.get(message) === controller) {
                    jobs.delete(message);
                    if (scope.valid() && scope.context.chat[id] === message) update(id, message, false);
                }
            }
        },
        async translateChat(retryFailed = false) {
            if (queue || !getSettings().enabled) return;
            const scope = capture();
            const settings = structuredClone(getSettings());
            const items = retryFailed ? failed.filter(m => scope.context.chat.includes(m)) : scope.context.chat.filter(m => !m.is_user && !m.is_system && typeof m.mes === 'string');
            failed = [];
            const task = {controller:new AbortController(), done:0, total:items.length};
            queue = task;
            const report = running => progress({running, done:task.done, total:task.total, failed:failed.length});
            report(true);
            try {
                for (const message of items) {
                    if (!scope.valid() || task.controller.signal.aborted) break;
                    const id = scope.context.chat.indexOf(message);
                    if (id < 0) continue;
                    const ok = await runtime.translateMessage(id, {persist:false, signal:task.controller.signal, settings, quiet:true});
                    if (!scope.valid() || task.controller.signal.aborted) break;
                    if (!ok) failed.push(message);
                    task.done++; report(true);
                }
                if (scope.valid()) await scope.context.saveChat();
            } finally {
                if (queue === task) queue = null;
                if (scope.valid()) report(false);
            }
        },
        async toggle(id) {
            const context = getContext();
            const message = context.chat[id];
            if (!message || message.is_system) return;
            const record = message.extra?.[message.is_user ? 'safe_translation_outgoing' : 'safe_translation'];
            if (!record || record.source !== message.mes) {
                if (!message.is_user) await runtime.translateMessage(id, {force:true});
                else notify('Английская версия появится при генерации с включённым исходящим переводом.');
                return;
            }
            if (message.extra.display_text === displayOf(record)) {
                delete message.extra.display_text; record.showingTranslation = false;
            } else if (!message.extra.display_text) {
                message.extra.display_text = displayOf(record); record.showingTranslation = true;
            } else { notify('Отображаемый текст принадлежит другому расширению.'); return; }
            update(id, message, false);
            await context.saveChat();
        },
        async edited(id) {
            const scope = capture();
            const context = scope.context;
            const message = context.chat[id];
            if (!message) return;
            jobs.get(message)?.abort();
            if (message.is_user) generation?.abort();
            let changed = false;
            for (const key of ['safe_translation', 'safe_translation_outgoing']) {
                const record = message.extra?.[key];
                if (record && record.source !== message.mes) {
                    if (message.extra.display_text === displayOf(record)) delete message.extra.display_text;
                    delete message.extra[key]; changed = true;
                }
            }
            if (changed) { update(id, message, false); await context.saveChat(); }
            if (!scope.valid() || context.chat[id] !== message) return;
            if (getSettings().autoIncoming && !message.is_user) await runtime.translateMessage(id);
        },
        async clear() {
            runtime.invalidate();
            const context = getContext();
            for (const [id, message] of context.chat.entries()) {
                if (!message.extra) continue;
                if (ownedDisplay(message)) delete message.extra.display_text;
                if (message.extra.safe_translation_outgoing?.showingTranslation && message.extra.display_text === displayOf(message.extra.safe_translation_outgoing)) delete message.extra.display_text;
                delete message.extra.safe_translation;
                delete message.extra.safe_translation_outgoing;
                update(id, message, false);
            }
            await context.saveChat();
        },
        async intercept(prompt, abort) {
            const settings = structuredClone(getSettings());
            if (!settings.enabled || !settings.autoOutgoing) return;
            if (generation) { abort(true); return; }
            const scope = capture();
            const controller = new AbortController();
            generation = controller;
            const signal = controller.signal;
            settings.targetLanguage = settings.outgoingLanguage;
            settings.outputMode = 'both';
            const prepared = [];
            const isCurrent = () => scope.valid() && !signal.aborted;
            try {
                for (const item of prompt) {
                    if (!item.is_user || item.is_system || typeof item.mes !== 'string' || !item.mes.trim() || /^\s*\//.test(item.mes)) continue;
                    const source = item.mes;
                    // SillyTavern passes shallow message copies; extra identifies the original
                    // even after system-message filtering or prompt-only regex processing.
                    const live = scope.context.chat.find(m => m.extra && m.extra === item.extra);
                    const original = live?.mes;
                    const signature = translationSignature(source, settings);
                    const cached = live?.extra?.safe_translation_outgoing;
                    let fallback = false;
                    let display = displayOf(cached);
                    let translated = cached?.signature === signature && cached.source === original ? cached.translatedText : null;
                    if (typeof translated !== 'string') {
                        while (true) {
                            if (!isCurrent()) throw new DOMException('Aborted', 'AbortError');
                            try {
                                const result = await translate(source, settings, signal);
                                translated = typeof result === 'string' ? result : result.prompt;
                                display = typeof result === 'string' ? result : result.display;
                                break;
                            }
                            catch (error) {
                                if (!isCurrent()) throw error;
                                const choice = await ask(error);
                                if (!isCurrent()) throw new DOMException('Aborted', 'AbortError');
                                if (choice === 'retry') continue;
                                if (choice === 'original') { translated = source; fallback = true; break; }
                                throw new DOMException('Cancelled', 'AbortError');
                            }
                        }
                    }
                    if (!isCurrent() || (live && live.mes !== original)) throw new DOMException('Message changed', 'AbortError');
                    prepared.push({item, live, original, source, signature, translated, display, fallback});
                }
                if (!isCurrent()) throw new DOMException('Aborted', 'AbortError');
                for (const p of prepared) {
                    if (p.live && (p.live.mes !== p.original || !scope.context.chat.includes(p.live))) throw new DOMException('Message changed', 'AbortError');
                }
                // Commit only after the whole history is ready. Never mutate message.mes.
                for (const p of prepared) {
                    p.item.mes = p.translated;
                    if (p.live && !p.fallback) {
                        const previous = p.live.extra.safe_translation_outgoing;
                        const showingTranslation = previous?.showingTranslation && p.live.extra.display_text === displayOf(previous);
                        p.live.extra.safe_translation_outgoing = {source:p.original, promptSource:p.source, signature:p.signature, translatedText:p.translated, displayText:p.display, provider:settings.provider, targetLanguage:settings.targetLanguage, showingTranslation:Boolean(showingTranslation)};
                        if (showingTranslation) {
                            p.live.extra.display_text = p.display;
                            update(scope.context.chat.indexOf(p.live), p.live, false);
                        }
                    }
                }
                if (prepared.some(p => p.live)) await scope.context.saveChat();
                if (!isCurrent()) throw new DOMException('Aborted', 'AbortError');
            } catch (error) {
                abort(true); // ST catches thrown interceptors and would otherwise continue!
                if (error.name !== 'AbortError' && isCurrent()) notify(error.message);
            } finally {
                if (generation === controller) generation = null;
            }
        },
    };
    return runtime;
}
