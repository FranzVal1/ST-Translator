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
const PARSER_VERSION = 6;
const activeJobs = new Map();
const memoryCache = new Map();
const sourceSnapshots = new Map();
const editCheckTimers = new Map();

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
    preserveAngleInstructions: true,
    minTextLength: 1,
    timeoutMs: 30000,
    retries: 1,
    cache: true,
    debug: false,
});

const blockedWholeTags = new Set(['script', 'style', 'code', 'pre', 'textarea', 'template', 'svg', 'math']);
const standardHtmlTags = new Set([
    'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
    'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'col', 'colgroup',
    'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em',
    'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input',
    'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta',
    'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p',
    'picture', 'portal', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section',
    'select', 'slot', 'small', 'source', 'span', 'strong', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track',
    'u', 'ul', 'var', 'video', 'wbr',
]);
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
          <label class="checkbox_label"><input id="st_safe_angle" type="checkbox" ${s.preserveAngleInstructions ? 'checked' : ''}> Не переводить служебные блоки в &lt;...&gt;</label>
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
    bindCheckbox('#st_safe_angle', 'preserveAngleInstructions');
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

    if (settings().preserveCode && rest[0] === '`') {
        // In role-play messages a single backtick pair is commonly used for
        // inner thoughts: `this text must be translated`. Protect only each
        // delimiter, allowing the text between them to become a normal
        // translation segment. Two or more backticks are treated as an actual
        // Markdown code fence and the complete fenced span stays protected.
        let fenceLength = 1;
        while (rest[fenceLength] === '`') fenceLength++;

        if (fenceLength === 1) {
            return index + 1;
        }

        const fence = '`'.repeat(fenceLength);
        const end = source.indexOf(fence, index + fenceLength);
        return end < 0 ? source.length : end + fenceLength;
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
            const isClosingTag = /^<\s*\//.test(rawTag);
            const isSelfClosingTag = /\/\s*>$/.test(rawTag);

            if (tagName && !isClosingTag && blockedWholeTags.has(tagName)) {
                return findClosingTag(source, tagEnd, tagName);
            }

            // SillyTavern prompts and extensions often use XML-like service blocks:
            // <instruction>...</instruction>, <tool_call>...</tool_call>, etc.
            // They are not HTML and their contents must not be sent to a translator.
            // Real HTML tags remain structural only, so visible text inside div/span/button
            // is still translated.
            if (settings().preserveAngleInstructions
                && tagName
                && !isClosingTag
                && !isSelfClosingTag
                && !standardHtmlTags.has(tagName)) {
                const closingPattern = new RegExp(`<\/\s*${tagName}\s*>`, 'i');
                const remainder = source.slice(tagEnd);
                if (closingPattern.test(remainder)) {
                    return findClosingTag(source, tagEnd, tagName);
                }
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


function getMessageIdFromElement(element) {
    const messageElement = element?.closest?.('.mes');
    if (!messageElement) return null;
    const id = Number(messageElement.getAttribute('mesid'));
    return Number.isInteger(id) ? id : null;
}

function isEditControl(element) {
    if (!(element instanceof Element)) return false;
    return Boolean(element.closest([
        '.mes_edit',
        '.edit_message',
        '[data-action="edit"]',
        '[title="Edit"]',
        '[title="Редактировать"]',
        '.fa-pencil',
        '.fa-pen',
        '.fa-edit',
    ].join(',')));
}

function putOriginalIntoEditor(messageElement, original) {
    const candidates = [
        ...messageElement.querySelectorAll('textarea'),
        ...messageElement.querySelectorAll('[contenteditable="true"]'),
    ];
    if (!candidates.length) return false;

    let changed = false;
    for (const editor of candidates) {
        if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
            if (editor.value !== original) {
                editor.value = original;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                changed = true;
            }
            continue;
        }
        if (editor instanceof HTMLElement) {
            if (editor.textContent !== original) {
                editor.textContent = original;
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
                changed = true;
            }
        }
    }
    return changed;
}

function handleEditCapture(event) {
    const target = event.target;
    if (!isEditControl(target)) return;

    const messageElement = target.closest('.mes');
    const id = getMessageIdFromElement(target);
    if (!messageElement || id === null) return;

    const message = getContext().chat[id];
    if (!message || typeof message.mes !== 'string') return;

    // ST 1.18.0 may fill the editor from extra.display_text. Wait until the
    // core click handler has created the editor, then replace only the editor
    // value with the untouched source message. The visible translation remains
    // stored and is not written into message.mes.
    const applyOriginal = () => putOriginalIntoEditor(messageElement, message.mes);
    queueMicrotask(applyOriginal);
    requestAnimationFrame(applyOriginal);
    setTimeout(applyOriginal, 0);
    setTimeout(applyOriginal, 50);
}

function resolveMessageId(payload) {
    if (Number.isInteger(Number(payload))) return Number(payload);
    if (payload && typeof payload === 'object') {
        for (const key of ['messageId', 'mesId', 'id', 'index']) {
            if (Number.isInteger(Number(payload[key]))) return Number(payload[key]);
        }
    }
    return null;
}

function rememberCurrentSources() {
    const chat = getContext().chat ?? [];
    sourceSnapshots.clear();
    for (let id = 0; id < chat.length; id++) {
        const message = chat[id];
        if (message && typeof message.mes === 'string') {
            sourceSnapshots.set(id, message.mes);
        }
    }
}

async function checkEditedMessage(id) {
    const context = getContext();
    const message = context.chat[id];
    if (!message || message.is_system || message.is_user || typeof message.mes !== 'string') return;

    const previousSource = sourceSnapshots.get(id);
    const currentSource = message.mes;

    // First observation only establishes a baseline. Changes to display_text do
    // not affect message.mes, so our own rendering cannot trigger a translation loop.
    if (previousSource === undefined) {
        sourceSnapshots.set(id, currentSource);
        return;
    }
    if (previousSource === currentSource) return;

    sourceSnapshots.set(id, currentSource);
    activeJobs.get(id)?.abort();

    message.extra ??= {};
    delete message.extra.display_text;
    delete message.extra.safe_translation;
    updateMessageBlock(id, message);
    await context.saveChat();

    if (settings().enabled && settings().autoIncoming) {
        // Let SillyTavern finish saving and redrawing the edited message first.
        setTimeout(() => translateMessage(id, true), 100);
    }
}

function scheduleEditedMessageCheck(payload) {
    const id = resolveMessageId(payload);
    if (id === null) return;

    clearTimeout(editCheckTimers.get(id));
    const timer = setTimeout(async () => {
        editCheckTimers.delete(id);
        await checkEditedMessage(id);
    }, 75);
    editCheckTimers.set(id, timer);
}

async function handleMessageUpdated(payload) {
    scheduleEditedMessageCheck(payload);
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
    sourceSnapshots.set(id, source);
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
    const id = resolveMessageId(messageId);
    if (id === null) return;
    const message = getContext().chat[id];
    if (message && typeof message.mes === 'string') sourceSnapshots.set(id, message.mes);
    if (settings().autoIncoming) await translateMessage(id, false);
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
    document.removeEventListener('click', handleEditCapture, true);
    document.addEventListener('click', handleEditCapture, true);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleIncoming);
    eventSource.on(event_types.MESSAGE_SWIPED, handleIncoming);
    if (event_types.MESSAGE_UPDATED) {
        eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdated);
    }
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(() => {
        rememberCurrentSources();
        addButtons();
    }, 50));
    const observer = new MutationObserver(() => addButtons());
    const chat = document.getElementById('chat');
    if (chat) observer.observe(chat, { childList: true, subtree: true });
    rememberCurrentSources();
    addButtons();
    log('Initialized');
}
