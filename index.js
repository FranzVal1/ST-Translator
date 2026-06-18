import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
    updateMessageBlock,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

const MODULE_ID = 'safe_translation';
const PARSER_VERSION = 2;
const activeJobs = new Map();
const memoryCache = new Map();

const defaults = Object.freeze({
    enabled: true,
    provider: 'google',
    targetLanguage: 'ru',
    autoIncoming: true,
    translateAttributes: false,
    translateTitle: true,
    translateAlt: true,
    translatePlaceholder: true,
    translateAriaLabel: true,
    preserveCode: true,
    preserveMacros: true,
    preserveUrls: true,
    minTextLength: 1,
    timeoutMs: 30000,
    retries: 1,
    cache: true,
    debug: false,
});

const blockedWholeTags = new Set(['script', 'style', 'code', 'pre', 'textarea', 'template', 'svg', 'math']);
const visibleAttributes = new Set(['title', 'alt', 'placeholder', 'aria-label']);

function settings() {
    if (!extension_settings[MODULE_ID] || typeof extension_settings[MODULE_ID] !== 'object') {
        extension_settings[MODULE_ID] = {};
    }
    for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(extension_settings[MODULE_ID], key)) {
            extension_settings[MODULE_ID][key] = value;
        }
    }
    return extension_settings[MODULE_ID];
}

function log(...args) {
    if (settings().debug) console.debug('[Safe Translation]', ...args);
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function makeSettingsHtml() {
    const s = settings();
    return `
    <div id="safe_translation_settings" class="safe-translation-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Safe Translation</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="st_safe_enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> Включить модуль</label>
          <label class="checkbox_label"><input id="st_safe_auto" type="checkbox" ${s.autoIncoming ? 'checked' : ''}> Автоматически переводить ответы персонажа</label>
          <label>Переводчик</label>
          <select id="st_safe_provider" class="text_pole">
            <option value="google" ${s.provider === 'google' ? 'selected' : ''}>Google</option>
            <option value="yandex" ${s.provider === 'yandex' ? 'selected' : ''}>Yandex</option>
            <option value="bing" ${s.provider === 'bing' ? 'selected' : ''}>Bing</option>
          </select>
          <label>Язык перевода</label>
          <select id="st_safe_language" class="text_pole">
            <option value="ru" ${s.targetLanguage === 'ru' ? 'selected' : ''}>Русский</option>
            <option value="en" ${s.targetLanguage === 'en' ? 'selected' : ''}>English</option>
            <option value="de" ${s.targetLanguage === 'de' ? 'selected' : ''}>Deutsch</option>
            <option value="fr" ${s.targetLanguage === 'fr' ? 'selected' : ''}>Français</option>
            <option value="es" ${s.targetLanguage === 'es' ? 'selected' : ''}>Español</option>
            <option value="zh-CN" ${s.targetLanguage === 'zh-CN' ? 'selected' : ''}>中文</option>
            <option value="ja" ${s.targetLanguage === 'ja' ? 'selected' : ''}>日本語</option>
          </select>
          <label class="checkbox_label"><input id="st_safe_attrs" type="checkbox" ${s.translateAttributes ? 'checked' : ''}> Переводить видимые атрибуты title/alt/placeholder/aria-label</label>
          <label class="checkbox_label"><input id="st_safe_cache" type="checkbox" ${s.cache ? 'checked' : ''}> Кешировать сегменты</label>
          <label class="checkbox_label"><input id="st_safe_debug" type="checkbox" ${s.debug ? 'checked' : ''}> Диагностический журнал</label>
          <div class="safe-translation-actions">
            <button id="st_safe_translate_chat" class="menu_button">Перевести текущий чат</button>
            <button id="st_safe_clear_chat" class="menu_button">Убрать переводы</button>
          </div>
          <small>HTML, макросы, код, URL и встроенные функции не отправляются переводчику.</small>
        </div>
      </div>
    </div>`;
}

function bindSettings() {
    const bindCheckbox = (id, key) => $(id).on('change', function () {
        settings()[key] = Boolean(this.checked);
        saveSettingsDebounced();
    });
    bindCheckbox('#st_safe_enabled', 'enabled');
    bindCheckbox('#st_safe_auto', 'autoIncoming');
    bindCheckbox('#st_safe_attrs', 'translateAttributes');
    bindCheckbox('#st_safe_cache', 'cache');
    bindCheckbox('#st_safe_debug', 'debug');
    $('#st_safe_provider').on('change', function () {
        settings().provider = String(this.value);
        saveSettingsDebounced();
    });
    $('#st_safe_language').on('change', function () {
        settings().targetLanguage = String(this.value);
        saveSettingsDebounced();
    });
    $('#st_safe_translate_chat').on('click', translateCurrentChat);
    $('#st_safe_clear_chat').on('click', clearCurrentChatTranslations);
}

function isWhitespaceOrPunctuation(text) {
    return !text.trim() || !/[\p{L}\p{N}]/u.test(text);
}

function readHtmlTag(source, start) {
    let quote = null;
    for (let i = start + 1; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === quote && source[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') return i + 1;
    }
    return -1;
}

function findClosingTag(source, from, tagName) {
    const re = new RegExp(`<\\/\\s*${tagName}\\s*>`, 'ig');
    re.lastIndex = from;
    const match = re.exec(source);
    return match ? match.index + match[0].length : source.length;
}

function matchProtectedAt(source, index) {
    const rest = source.slice(index);

    if (settings().preserveCode && rest.startsWith('```')) {
        const end = source.indexOf('```', index + 3);
        return end < 0 ? source.length : end + 3;
    }
    if (settings().preserveCode && rest[0] === '`') {
        const end = source.indexOf('`', index + 1);
        return end < 0 ? null : end + 1;
    }
    if (settings().preserveMacros && rest.startsWith('{{')) {
        const end = source.indexOf('}}', index + 2);
        return end < 0 ? null : end + 2;
    }
    if (settings().preserveUrls) {
        const url = rest.match(/^(?:https?:\/\/|data:|mailto:)[^\s<>()]+/i);
        if (url) return index + url[0].length;
        const markdownImage = rest.match(/^!\[[^\]]*]\([^)]*\)/);
        if (markdownImage) return index + markdownImage[0].length;
    }
    if (rest[0] === '<') {
        const tagEnd = readHtmlTag(source, index);
        if (tagEnd > 0) {
            const rawTag = source.slice(index, tagEnd);
            const nameMatch = rawTag.match(/^<\s*\/?\s*([a-zA-Z][\w:-]*)/);
            const tagName = nameMatch?.[1]?.toLowerCase();
            if (tagName && blockedWholeTags.has(tagName) && !/^<\s*\//.test(rawTag)) {
                return findClosingTag(source, tagEnd, tagName);
            }
            return tagEnd;
        }
    }
    return null;
}

function tokenizeMessage(source) {
    const tokens = [];
    let textStart = 0;
    let i = 0;

    const pushText = (end) => {
        if (end > textStart) tokens.push({ type: 'text', value: source.slice(textStart, end) });
    };

    while (i < source.length) {
        const protectedEnd = matchProtectedAt(source, i);
        if (protectedEnd !== null) {
            pushText(i);
            tokens.push({ type: 'protected', value: source.slice(i, protectedEnd) });
            i = protectedEnd;
            textStart = i;
            continue;
        }
        i++;
    }
    pushText(source.length);
    return tokens;
}

function parseTagAttributes(rawTag) {
    if (!settings().translateAttributes || /^<\s*\//.test(rawTag)) return null;
    const replacements = [];
    const attrRe = /\s([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = attrRe.exec(rawTag))) {
        const name = match[1].toLowerCase();
        if (!visibleAttributes.has(name)) continue;
        const value = match[3] ?? match[4] ?? '';
        if (!value || isWhitespaceOrPunctuation(value)) continue;
        const quote = match[2][0];
        const valueOffset = match.index + match[0].indexOf(quote) + 1;
        replacements.push({ start: valueOffset, end: valueOffset + value.length, value });
    }
    return replacements.length ? replacements : null;
}

function buildPlan(source) {
    const base = tokenizeMessage(source);
    const units = [];
    for (const token of base) {
        if (token.type === 'text') {
            if (!isWhitespaceOrPunctuation(token.value) && token.value.trim().length >= settings().minTextLength) {
                units.push({ kind: 'text', original: token.value, translated: null });
                token.unit = units.length - 1;
            }
            continue;
        }
        if (token.value.startsWith('<')) {
            const attrs = parseTagAttributes(token.value);
            if (attrs) {
                for (const attr of attrs) {
                    units.push({ kind: 'attribute', original: attr.value, translated: null });
                    attr.unit = units.length - 1;
                }
                token.attributes = attrs;
            }
        }
    }
    return { source, tokens: base, units };
}

function rebuild(plan) {
    return plan.tokens.map((token) => {
        if (token.type === 'text') {
            return Number.isInteger(token.unit) ? plan.units[token.unit].translated : token.value;
        }
        if (!token.attributes) return token.value;
        let result = token.value;
        for (const attr of [...token.attributes].reverse()) {
            const translated = plan.units[attr.unit].translated;
            result = result.slice(0, attr.start) + translated + result.slice(attr.end);
        }
        return result;
    }).join('');
}

async function providerRequest(text, language, provider, signal) {
    let url;
    let body;
    switch (provider) {
        case 'google':
            url = '/api/translate/google';
            body = { text, lang: language };
            break;
        case 'bing':
            url = '/api/translate/bing';
            body = { text, lang: language };
            break;
        case 'yandex':
            url = '/api/translate/yandex';
            body = { chunks: [text], lang: language };
            break;
        default:
            throw new Error(`Неизвестный переводчик: ${provider}`);
    }
    const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) throw new Error(`${provider}: HTTP ${response.status} ${response.statusText}`);
    return await response.text();
}

function cacheKey(text, language, provider) {
    return `${PARSER_VERSION}|${provider}|${language}|${text}`;
}

async function translateSegment(text, signal) {
    const s = settings();
    const key = cacheKey(text, s.targetLanguage, s.provider);
    if (s.cache && memoryCache.has(key)) return memoryCache.get(key);

    let lastError;
    for (let attempt = 0; attempt <= s.retries; attempt++) {
        try {
            const translated = await providerRequest(text, s.targetLanguage, s.provider, signal);
            if (typeof translated !== 'string' || !translated.length) throw new Error('Пустой ответ переводчика');
            if (s.cache) memoryCache.set(key, translated);
            return translated;
        } catch (error) {
            lastError = error;
            if (signal.aborted) throw error;
            if (attempt < s.retries) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
        }
    }
    throw lastError;
}

async function translateSafely(source, externalSignal) {
    const plan = buildPlan(source);
    if (!plan.units.length) return source;
    for (const unit of plan.units) {
        unit.translated = await translateSegment(unit.original, externalSignal);
    }
    const result = rebuild(plan);
    validateIntegrity(plan, result);
    return result;
}

function validateIntegrity(plan, result) {
    if (typeof result !== 'string') {
        throw new Error('Не удалось собрать переведённое сообщение.');
    }

    // Защищённые части никогда не отправляются провайдеру и вставляются обратно
    // непосредственно из исходного плана. Повторно токенизировать перевод нельзя:
    // обычный переведённый текст может законно содержать <, > или {{...}}, что
    // ранее вызывало ложное сообщение об изменённой разметке.
    const rebuiltProtected = plan.tokens
        .filter(token => token.type === 'protected')
        .map(token => token.value);
    const sourceProtected = tokenizeMessage(plan.source)
        .filter(token => token.type === 'protected')
        .map(token => token.value);

    if (rebuiltProtected.length !== sourceProtected.length
        || rebuiltProtected.some((value, index) => value !== sourceProtected[index])) {
        throw new Error('Внутренняя ошибка сборки защищённой разметки.');
    }

    for (const unit of plan.units) {
        if (typeof unit.translated !== 'string') {
            throw new Error('Переводчик вернул неполный результат.');
        }
    }
}

async function translateMessage(messageId, force = false) {
    const s = settings();
    if (!s.enabled) return;
    const context = getContext();
    const id = Number(messageId);
    const message = context.chat[id];
    if (!message || message.is_system || message.is_user || typeof message.mes !== 'string') return;

    message.extra ??= {};
    const source = message.mes;
    const signature = `${PARSER_VERSION}|${s.provider}|${s.targetLanguage}|${source}`;
    if (!force && message.extra.safe_translation?.signature === signature && message.extra.display_text) return;

    activeJobs.get(id)?.abort();
    const controller = new AbortController();
    activeJobs.set(id, controller);
    const timeout = setTimeout(() => controller.abort(new Error('Тайм-аут перевода')), s.timeoutMs);
    setMessageBusy(id, true);
    try {
        const translated = await translateSafely(source, controller.signal);
        if (activeJobs.get(id) !== controller) return;
        message.extra.safe_translation = {
            version: 1,
            signature,
            provider: s.provider,
            targetLanguage: s.targetLanguage,
            translatedAt: Date.now(),
        };
        message.extra.display_text = translated;
        updateMessageBlock(id, message);
        await context.saveChat();
    } catch (error) {
        if (!controller.signal.aborted || String(error).includes('Тайм-аут')) {
            console.error('[Safe Translation]', error);
            toastr.error(error instanceof Error ? error.message : String(error), 'Safe Translation');
        }
    } finally {
        clearTimeout(timeout);
        if (activeJobs.get(id) === controller) activeJobs.delete(id);
        setMessageBusy(id, false);
    }
}

function setMessageBusy(id, busy) {
    const button = $(`#chat .mes[mesid="${id}"] .safe_translate_button`);
    button.toggleClass('fa-spin', busy).toggleClass('disabled', busy);
}

async function handleIncoming(messageId) {
    if (settings().autoIncoming) await translateMessage(messageId, false);
}

async function onMessageButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const id = Number($(event.currentTarget).closest('.mes').attr('mesid'));
    const context = getContext();
    const message = context.chat[id];
    if (!message) return;
    if (message.extra?.display_text) {
        delete message.extra.display_text;
        updateMessageBlock(id, message);
        await context.saveChat();
        return;
    }
    await translateMessage(id, true);
}

function addButtons(root = document) {
    $(root).find('#chat .mes').each(function () {
        const message = $(this);
        if (message.find('.safe_translate_button').length) return;
        const target = message.find('.extraMesButtons, .mes_buttons').first();
        if (!target.length) return;
        target.append('<div class="mes_button safe_translate_button fa-solid fa-language interactable" title="Safe Translation" tabindex="0"></div>');
    });
}

async function translateCurrentChat() {
    const context = getContext();
    const toast = toastr.info('Перевод сообщений запущен', 'Safe Translation');
    try {
        for (let i = 0; i < context.chat.length; i++) {
            await translateMessage(i, false);
        }
    } finally {
        toastr.clear(toast);
    }
}

async function clearCurrentChatTranslations() {
    const context = getContext();
    for (const message of context.chat) {
        if (!message.extra) continue;
        delete message.extra.display_text;
        delete message.extra.safe_translation;
    }
    await context.saveChat();
    for (let i = 0; i < context.chat.length; i++) {
        updateMessageBlock(i, context.chat[i]);
    }
}

export async function init() {
    settings();
    if (!document.getElementById('safe_translation_settings')) {
        $('#extensions_settings2').append(makeSettingsHtml());
        bindSettings();
    }
    $(document).off('click.safeTranslation', '.safe_translate_button')
        .on('click.safeTranslation', '.safe_translate_button', onMessageButtonClick);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleIncoming);
    eventSource.on(event_types.MESSAGE_SWIPED, handleIncoming);
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => addButtons(), 50));
    const observer = new MutationObserver(() => addButtons());
    const chat = document.getElementById('chat');
    if (chat) observer.observe(chat, { childList: true, subtree: true });
    addButtons();
    log('Initialized');
}
