import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced, updateMessageBlock } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { createTranslator } from './provider.js';
import { createRuntime } from './runtime.js';

const MODULE_ID = 'safe_translation';
const defaults = Object.freeze({
    enabled:true, provider:'google', targetLanguage:'ru', autoIncoming:true,
    autoOutgoing:false, outgoingLanguage:'en', translateAttributes:false,
    translateTitle:true, translateAlt:true, translatePlaceholder:true, translateAriaLabel:true,
    preserveCode:true, preserveMacros:true, preserveUrls:true, preserveAngleInstructions:true,
    protectedTags:[], protectedClasses:[], minTextLength:1, timeoutMs:30000, retries:1, cache:true, debug:false,
});
let initialized = false;
let chatObserver;
let buttonUpdatePending = false;
const editObservers = new Set();

function settings() {
    extension_settings[MODULE_ID] ??= {};
    for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(extension_settings[MODULE_ID], key)) extension_settings[MODULE_ID][key] = structuredClone(value);
    }
    return extension_settings[MODULE_ID];
}
const translate = createTranslator({headers:getRequestHeaders});
const reportError = error => toastr.error(String(error?.message ?? error), 'Safe Translation');
// Invoke before jQuery continues dispatch and reuses event.currentTarget.
// Async functions run synchronously up to their first await; catch both sync
// throws and rejected promises without deferring the event handling itself.
const safely = fn => async (...args) => {
    try { return await fn(...args); }
    catch (error) { reportError(error); }
};

const runtime = createRuntime({
    getContext, getSettings:settings, translate,
    update(id, message, busy) {
        // Do not rerender the message while its editor is open.
        const node = document.querySelector(`#chat .mes[mesid="${id}"]`);
        if (!busy && !node?.querySelector('textarea, [contenteditable="true"]')) updateMessageBlock(id, message);
        const button = node?.querySelector('.safe_translate_button');
        if (button) {
            button.classList.toggle('fa-spin', busy);
            button.classList.toggle('disabled', busy);
            button.setAttribute('aria-busy', String(busy));
        }
    },
    notify:reportError,
    progress({running, done, total, failed}) {
        $('#st_safe_progress').text(`Обработано ${done} из ${total} · Ошибок: ${failed}`);
        $('#st_safe_translate_chat').prop('disabled', running);
        $('#st_safe_stop').prop('disabled', !running);
        $('#st_safe_retry').prop('disabled', running || !failed);
    },
    async ask() {
        // No server response or source text is inserted as HTML into the dialog.
        const choice = await callGenericPopup('Не удалось перевести реплику игрока. Генерация ожидает решения. «Отправить оригинал» разрешает использовать исходный текст только в этой генерации.', POPUP_TYPE.CONFIRM, '', {
            okButton:'Повторить', cancelButton:'Отмена', defaultResult:0,
            customButtons:[{text:'Отправить оригинал', result:1001}],
        });
        return choice === 1 ? 'retry' : choice === 1001 ? 'original' : 'cancel';
    },
});

function makeSettingsHtml() {
    return `<div id="safe_translation_settings" class="safe-translation-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>Safe Translation</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <label class="checkbox_label"><input id="st_safe_enabled" type="checkbox"> Включить модуль</label>
        <label class="checkbox_label"><input id="st_safe_auto" type="checkbox"> Автоперевод ответов персонажа</label>
        <label for="st_safe_provider">Переводчик</label><select id="st_safe_provider" class="text_pole"><option value="google">Google</option><option value="yandex">Yandex</option><option value="bing">Bing</option></select>
        <label for="st_safe_language">Язык отображения ответов</label><select id="st_safe_language" class="text_pole"></select>
        <label class="checkbox_label"><input id="st_safe_outgoing" type="checkbox"> Переводить реплики игрока для LLM</label>
        <label for="st_safe_outgoing_language">Язык реплик игрока для LLM</label><select id="st_safe_outgoing_language" class="text_pole"></select>
        <small>Оригинал остаётся в чате и редакторе. При генерации переводятся реплики игрока в истории; кнопка сообщения показывает сохранённую версию для LLM. Это отправляет их текст выбранному переводчику. Код, макросы и защищённые инструкции не переводятся.</small>
        <label class="checkbox_label"><input id="st_safe_attrs" type="checkbox"> Переводить title, alt, placeholder, aria-label</label>
        <label class="checkbox_label"><input id="st_safe_angle" type="checkbox"> Защищать служебные блоки &lt;...&gt;</label>
        <label for="st_safe_tags">Дополнительные защищённые теги (через запятую)</label><input id="st_safe_tags" class="text_pole" placeholder="aside, custom-block">
        <label for="st_safe_classes">Защищённые CSS-классы (через запятую)</label><input id="st_safe_classes" class="text_pole" placeholder="secret, hidden-instruction">
        <small>hidden и явные inline-стили display:none / visibility:hidden защищены автоматически. Внешние CSS-правила не вычисляются — добавьте их классы выше.</small>
        <label class="checkbox_label"><input id="st_safe_cache" type="checkbox"> Кэшировать переводы в памяти</label>
        <div class="safe-translation-actions">
          <button id="st_safe_translate_chat" class="menu_button">Перевести ответы в чате</button>
          <button id="st_safe_stop" class="menu_button" disabled>Остановить</button>
          <button id="st_safe_retry" class="menu_button" disabled>Повторить ошибки</button>
          <button id="st_safe_clear_chat" class="menu_button">Удалить переводы</button>
          <button id="st_safe_clear_cache" class="menu_button">Очистить кэш</button>
        </div>
        <div id="st_safe_progress" role="status" aria-live="polite"></div>
        <small>Отключите автоматические режимы встроенного Chat Translation: два автопереводчика одновременно не поддерживаются.</small>
      </div>
    </div></div>`;
}

function bindSettings() {
    const languages = {ru:'Русский', en:'English', de:'Deutsch', fr:'Français', es:'Español', 'zh-CN':'中文', ja:'日本語'};
    for (const selector of ['#st_safe_language', '#st_safe_outgoing_language']) {
        for (const [value, text] of Object.entries(languages)) $(selector).append($('<option>').val(value).text(text));
    }
    const bindings = {
        st_safe_enabled:'enabled', st_safe_auto:'autoIncoming', st_safe_outgoing:'autoOutgoing',
        st_safe_provider:'provider', st_safe_language:'targetLanguage', st_safe_outgoing_language:'outgoingLanguage',
        st_safe_attrs:'translateAttributes', st_safe_angle:'preserveAngleInstructions', st_safe_cache:'cache',
        st_safe_tags:'protectedTags', st_safe_classes:'protectedClasses',
    };
    for (const [id, key] of Object.entries(bindings)) {
        const input = $(`#${id}`);
        const isCheckbox = input.attr('type') === 'checkbox';
        const isList = ['protectedTags','protectedClasses'].includes(key);
        if (isCheckbox) input.prop('checked', settings()[key]);
        else input.val(isList ? settings()[key].join(', ') : settings()[key]);
        input.on('change', function () {
            let value = isCheckbox ? this.checked : String(this.value);
            if (isList) value = value.split(/[\s,]+/).map(x => key === 'protectedTags' ? x.toLowerCase() : x).filter(Boolean);
            settings()[key] = value;
            runtime.invalidate();
            saveSettingsDebounced();
        });
    }
    $('#st_safe_translate_chat').on('click', safely(() => runtime.translateChat()));
    $('#st_safe_retry').on('click', safely(() => runtime.translateChat(true)));
    $('#st_safe_stop').on('click', () => runtime.stop());
    $('#st_safe_clear_chat').on('click', safely(async () => {
        const confirmed = await callGenericPopup('Удалить сохранённые переводы Safe Translation? Оригиналы и переводы других расширений останутся.', POPUP_TYPE.CONFIRM);
        if (confirmed === 1) await runtime.clear();
    }));
    $('#st_safe_clear_cache').on('click', () => { translate.clearCache(); toastr.info('Кэш очищен', 'Safe Translation'); });
}

function resolveId(payload) {
    const value = payload && typeof payload === 'object' ? payload.messageId ?? payload.mesId ?? payload.id ?? payload.index : payload;
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? id : null;
}
function prepareMessages() {
    for (const message of getContext().chat ?? []) {
        message.extra ??= {};
        // v1.2 owned display migration: keep it reversible after upgrading.
        const record = message.extra.safe_translation;
        if (record?.version === 1 && !record.translatedText && typeof message.extra.display_text === 'string') {
            record.source = message.mes; record.translatedText = message.extra.display_text;
        }
    }
}
function addButtons(root = document) {
    const messages = [...(root.matches?.('.mes') ? [root] : []), ...root.querySelectorAll('.mes')];
    for (const message of messages) {
        if (!message.closest('#chat') || message.querySelector('.safe_translate_button')) continue;
        const target = message.querySelector('.extraMesButtons, .mes_buttons');
        if (!target) continue;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'mes_button safe_translate_button fa-solid fa-language interactable';
        button.title = 'Safe Translation: оригинал / перевод'; button.setAttribute('aria-label', button.title);
        target.append(button);
    }
}
function editCapture(event) {
    const target = event.target instanceof Element ? event.target.closest('.mes_edit, .edit_message, [data-action="edit"]') : null;
    if (!target) return;
    const node = target.closest('.mes');
    const id = resolveId(node?.getAttribute('mesid'));
    const message = id === null ? null : getContext().chat[id];
    if (!message || !node) return;
    const original = message.mes;
    let timer;
    const observer = new MutationObserver(putOriginal);
    const disconnect = () => { observer.disconnect(); clearTimeout(timer); editObservers.delete(disconnect); };
    function putOriginal() {
        const editor = node.querySelector('textarea.edit_textarea, [contenteditable="true"]');
        if (!editor) return;
        disconnect();
        if (editor instanceof HTMLTextAreaElement) editor.value = original;
        else editor.textContent = original;
        editor.dispatchEvent(new Event('input', {bubbles:true}));
    }
    editObservers.add(disconnect);
    observer.observe(node, {childList:true, subtree:true});
    timer = setTimeout(disconnect, 2000);
    putOriginal();
}

export async function init() {
    if (initialized) return;
    initialized = true;
    settings(); prepareMessages();
    $('#extensions_settings2').append(makeSettingsHtml()); bindSettings();
    $(document).on('click.safeTranslation', '.safe_translate_button', safely(async event => {
        event.preventDefault(); event.stopPropagation();
        const id = resolveId(event.currentTarget.closest('.mes')?.getAttribute('mesid'));
        if (id !== null) await runtime.toggle(id);
    }));
    document.addEventListener('click', editCapture, true);
    const incoming = safely(async payload => {
        const id = resolveId(payload);
        if (id === null) return;
        prepareMessages(); addButtons();
        if (settings().autoIncoming) await runtime.translateMessage(id);
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, incoming);
    eventSource.on(event_types.MESSAGE_SWIPED, incoming);
    eventSource.on(event_types.MESSAGE_SENT, prepareMessages);
    if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, safely(async payload => {
        const id = resolveId(payload); if (id !== null) await runtime.edited(id);
    }));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        runtime.invalidate();
        for (const disconnect of [...editObservers]) disconnect();
        prepareMessages(); addButtons();
    });
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, () => runtime.invalidate());
    chatObserver = new MutationObserver(() => {
        if (buttonUpdatePending) return;
        buttonUpdatePending = true;
        queueMicrotask(() => { buttonUpdatePending = false; addButtons(); });
    });
    const chat = document.getElementById('chat');
    if (chat) chatObserver.observe(chat, {childList:true, subtree:true});
    addButtons();
}

// manifest.generate_interceptor resolves a global function, not an ES module export.
globalThis.safeTranslationInterceptor = async (chat, _contextSize, abort, _type) => {
    const builtin = extension_settings.translate?.auto_mode;
    if (settings().enabled && settings().autoOutgoing && ['inputs','both'].includes(builtin)) {
        abort(true); reportError('Отключите исходящий автоперевод встроенного Chat Translation.'); return;
    }
    await runtime.intercept(chat, abort);
};
