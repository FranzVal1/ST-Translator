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
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<\\/\\s*${escaped}\\s*>`, 'ig');
    re.lastIndex = from;
    const match = re.exec(source);
    return match ? match.index + match[0].length : source.length;
}

function findServiceBlockEnd(source, openingEnd, tagName) {
    let depth = 1;
    let cursor = openingEnd;
    while (cursor < source.length) {
        const nextTagStart = source.indexOf('<', cursor);
        if (nextTagStart < 0) return null;
        const nextTagEnd = readHtmlTag(source, nextTagStart);
        if (nextTagEnd < 0) return null;
        const rawTag = source.slice(nextTagStart, nextTagEnd);
        const match = rawTag.match(/^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/);
        const foundName = match?.[2]?.toLowerCase();
        if (foundName === tagName) {
            const closing = match[1] === '/';
            const selfClosing = /\/\s*>$/.test(rawTag);
            if (closing) {
                depth--;
                if (depth === 0) return nextTagEnd;
            } else if (!selfClosing) {
                depth++;
            }
        }
        cursor = nextTagEnd;
    }
    return null;
}

function findBalancedMacroEnd(source, start) {
    let depth = 0;
    let quote = null;
    for (let i = start; i < source.length - 1; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === quote && source[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        const pair = source.slice(i, i + 2);
        if (pair === '{{') {
            depth++;
            i++;
            continue;
        }
        if (pair === '}}') {
            depth--;
            i++;
            if (depth === 0) return i + 1;
        }
    }
    return null;
}

function matchProtectedAt(source, index, options) {
    const rest = source.slice(index);

    // Dialogue quotation marks are local formatting delimiters. Protect only
    // the mark itself; text between marks remains translatable.
    if ('"“”„«»'.includes(rest[0])) return index + 1;

    if (options.preserveCode && rest[0] === '`') {
        let fenceLength = 1;
        while (rest[fenceLength] === '`') fenceLength++;
        if (fenceLength === 1) return index + 1; // role-play inner thought
        const fence = '`'.repeat(fenceLength);
        const end = source.indexOf(fence, index + fenceLength);
        return end < 0 ? source.length : end + fenceLength;
    }

    if (options.preserveMacros && rest.startsWith('{{')) {
        return findBalancedMacroEnd(source, index);
    }

    if (options.preserveUrls) {
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
            const isKnownHtmlTag = Boolean(tagName && standardHtmlTags.has(tagName));

            // Any non-HTML <...> span is an instruction and remains byte-for-byte intact.
            if (options.preserveAngleInstructions && !isKnownHtmlTag) {
                if (tagName && !isClosingTag && !isSelfClosingTag) {
                    const serviceBlockEnd = findServiceBlockEnd(source, tagEnd, tagName);
                    if (serviceBlockEnd !== null) return serviceBlockEnd;
                }
                return tagEnd;
            }

            if (tagName && !isClosingTag && blockedWholeTags.has(tagName)) {
                return findClosingTag(source, tagEnd, tagName);
            }
            return tagEnd;
        }
    }
    return null;
}

function tokenizeMessage(source, options) {
    const tokens = [];
    let textStart = 0;
    let i = 0;
    const pushText = (end) => {
        if (end > textStart) tokens.push({ type: 'text', value: source.slice(textStart, end) });
    };
    while (i < source.length) {
        const protectedEnd = matchProtectedAt(source, i, options);
        if (protectedEnd !== null && protectedEnd > i) {
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

function parseTagAttributes(rawTag, options) {
    if (!options.translateAttributes || /^<\s*\//.test(rawTag)) return null;
    const tagName = rawTag.match(/^<\s*([a-zA-Z][\w:-]*)/)?.[1]?.toLowerCase();
    if (!tagName || !standardHtmlTags.has(tagName)) return null;
    const replacements = [];
    const attrRe = /\s([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = attrRe.exec(rawTag))) {
        const name = match[1].toLowerCase();
        if (!visibleAttributes.has(name)) continue;
        if (name === 'title' && options.translateTitle === false) continue;
        if (name === 'alt' && options.translateAlt === false) continue;
        if (name === 'placeholder' && options.translatePlaceholder === false) continue;
        if (name === 'aria-label' && options.translateAriaLabel === false) continue;
        const value = match[3] ?? match[4] ?? '';
        if (!value || isWhitespaceOrPunctuation(value)) continue;
        const quote = match[2][0];
        const valueOffset = match.index + match[0].indexOf(quote) + 1;
        replacements.push({ start: valueOffset, end: valueOffset + value.length, value });
    }
    return replacements.length ? replacements : null;
}

function splitOuterWhitespace(value) {
    const leading = value.match(/^\s*/u)?.[0] ?? '';
    const trailing = value.match(/\s*$/u)?.[0] ?? '';
    const start = leading.length;
    const end = Math.max(start, value.length - trailing.length);
    return { leading, core: value.slice(start, end), trailing };
}

export function buildPlan(source, options) {
    const tokens = tokenizeMessage(source, options);
    const units = [];
    for (const token of tokens) {
        if (token.type === 'text') {
            const parts = splitOuterWhitespace(token.value);
            if (!isWhitespaceOrPunctuation(parts.core) && parts.core.length >= options.minTextLength) {
                units.push({ kind: 'text', original: parts.core, translated: null });
                token.unit = units.length - 1;
                token.leading = parts.leading;
                token.trailing = parts.trailing;
            }
            continue;
        }
        if (token.value.startsWith('<')) {
            const attrs = parseTagAttributes(token.value, options);
            if (attrs) {
                for (const attr of attrs) {
                    units.push({ kind: 'attribute', original: attr.value, translated: null });
                    attr.unit = units.length - 1;
                }
                token.attributes = attrs;
            }
        }
    }
    return { source, tokens, units };
}

export function rebuild(plan) {
    return plan.tokens.map((token) => {
        if (token.type === 'text') {
            if (!Number.isInteger(token.unit)) return token.value;
            const translated = plan.units[token.unit].translated;
            return `${token.leading ?? ''}${translated}${token.trailing ?? ''}`;
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

export function validateIntegrity(plan, result) {
    if (typeof result !== 'string') throw new Error('Не удалось собрать переведённое сообщение.');
    const expectedProtected = plan.tokens.filter(t => t.type === 'protected').map(t => t.value);
    for (const value of expectedProtected) {
        if (!result.includes(value)) throw new Error('Защищённая разметка потеряна при сборке.');
    }
    for (const unit of plan.units) {
        if (typeof unit.translated !== 'string') throw new Error('Переводчик вернул неполный результат.');
    }
}

export const __test = { tokenizeMessage, findBalancedMacroEnd, splitOuterWhitespace };
