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
import { buildPlan, rebuild, validateIntegrity } from './parser.js';

const MODULE_ID = 'safe_translation';
const PARSER_VERSION = 9;
const activeJobs = new Map();
const memoryCache = new Map();
const sourceSnapshots = new Map();
const editCheckTimers = new Map();
let chatObserver = null;
let initialized = false;

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

function parserOptions() {
    const s = settings();
    return {
        preserveCode: s.preserveCode,
        preserveMacros: s.preserveMacros,
        preserveUrls: s.preserveUrls,
        preserveAngleInstructions: s.preserveAngleInstructions,
        translateAttributes: s.translateAttributes,
        translateTitle: s.translateTitle,
        translateAlt: s.translateAlt,
        translatePlaceholder: s.translatePlaceholder,
        translateAriaLabel: s.translateAriaLabel,
        minTextLength: s.minTextLength,
    };
}

const providerChunkLimits = Object.freeze({ google: 5000, yandex: 5000, bing: 1000 });

function splitForProvider(text, maxLength) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > maxLength) {
        let cut = rest.lastIndexOf('\n', maxLength);
        if (cut < Math.floor(maxLength * 0.5)) cut = rest.lastIndexOf(' ', maxLength);
        if (cut < Math.floor(maxLength * 0.5)) cut = maxLength;
        else cut += 1;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest);
    return chunks;
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
    if (!response.ok) {
        const details = (await response.text().catch(() => '')).slice(0, 300);
        throw new Error(`${provider}: HTTP ${response.status}${details ? ` — ${details}` : ''}`);
    }
    const result = await response.text();
    if (!result || /^<!doctype html/i.test(result.trim()) || /^<html/i.test(result.trim())) {
        throw new Error(`${provider}: сервер вернул некорректный ответ`);
    }
    return result;
}

function cacheKey(text, language, provider) {
    return `${PARSER_VERSION}|${provider}|${language}|${text}`;
}

async function translateSegment(text, signal) {
    const s = settings();
    const key = cacheKey(text, s.targetLanguage, s.provider);
    if (s.cache && memoryCache.has(key)) return memoryCache.get(key);

    const limit = providerChunkLimits[s.provider] ?? 1000;
    const chunks = splitForProvider(text, limit);
    let output = '';
    for (const chunk of chunks) {
        let lastError;
        let translated = null;
        for (let attempt = 0; attempt <= s.retries; attempt++) {
            try {
                translated = await providerRequest(chunk, s.targetLanguage, s.provider, signal);
                break;
            } catch (error) {
                lastError = error;
                if (signal.aborted) throw error;
                if (attempt < s.retries) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }
        if (translated === null) throw lastError;
        output += translated;
    }
    if (s.cache) memoryCache.set(key, output);
    return output;
}

async function translateSafely(source, externalSignal) {
    const plan = buildPlan(source, parserOptions());
    if (!plan.units.length) return source;
    for (const unit of plan.units) {
        if (externalSignal.aborted) throw externalSignal.reason ?? new DOMException('Aborted', 'AbortError');
        unit.translated = await translateSegment(unit.original, externalSignal);
    }
    const result = rebuild(plan);
    validateIntegrity(plan, result);
    return result;
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
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, s.timeoutMs);
    setMessageBusy(id, true);
    try {
        const translated = await translateSafely(source, controller.signal);
        if (activeJobs.get(id) !== controller) return;

        // Never write a result generated for an older revision of the message.
        const liveContext = getContext();
        const liveMessage = liveContext.chat[id];
        if (!liveMessage || liveMessage.mes !== source || liveMessage.is_user || liveMessage.is_system) return;
        liveMessage.extra ??= {};
        liveMessage.extra.safe_translation = {
            version: 1,
            signature,
            provider: s.provider,
            targetLanguage: s.targetLanguage,
            translatedAt: Date.now(),
        };
        liveMessage.extra.display_text = translated;
        updateMessageBlock(id, liveMessage);
        await liveContext.saveChat();
    } catch (error) {
        if (timedOut) {
            console.error('[Safe Translation] Timeout', error);
            toastr.error('Истекло время ожидания перевода.', 'Safe Translation');
        } else if (!controller.signal.aborted) {
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
    for (const controller of activeJobs.values()) controller.abort();
    activeJobs.clear();
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


function handleChatChanged() {
    for (const controller of activeJobs.values()) controller.abort();
    activeJobs.clear();
    for (const timer of editCheckTimers.values()) clearTimeout(timer);
    editCheckTimers.clear();
    setTimeout(() => {
        rememberCurrentSources();
        addButtons();
    }, 50);
}

export async function init() {
    if (initialized) return;
    initialized = true;
    settings();
    if (!document.getElementById('safe_translation_settings')) {
        $('#extensions_settings2').append(makeSettingsHtml());
        bindSettings();
    }
    $(document).off('click.safeTranslation', '.safe_translate_button')
        .on('click.safeTranslation', '.safe_translate_button', onMessageButtonClick);
    document.removeEventListener('click', handleEditCapture, true);
    document.addEventListener('click', handleEditCapture, true);

    // Defensive unsubscribe prevents duplicate handlers if ST reloads the module.
    eventSource.off?.(event_types.CHARACTER_MESSAGE_RENDERED, handleIncoming);
    eventSource.off?.(event_types.MESSAGE_SWIPED, handleIncoming);
    eventSource.off?.(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleIncoming);
    eventSource.on(event_types.MESSAGE_SWIPED, handleIncoming);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    if (event_types.MESSAGE_UPDATED) {
        eventSource.off?.(event_types.MESSAGE_UPDATED, handleMessageUpdated);
        eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdated);
    }

    chatObserver?.disconnect();
    chatObserver = new MutationObserver(() => addButtons());
    const chat = document.getElementById('chat');
    if (chat) chatObserver.observe(chat, { childList: true, subtree: true });
    rememberCurrentSources();
    addButtons();
    log('Initialized');
}
