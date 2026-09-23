import { buildPlan, rebuild, validateIntegrity } from './parser.js';

export const providerChunkLimits = Object.freeze({ google: 5000, yandex: 5000, bing: 1000 });
export const PARSER_VERSION = 11;

export function splitForProvider(text, limit) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error('Invalid provider limit');
    const chunks = [];
    while (text.length > limit) {
        let cut = Math.max(text.lastIndexOf('\n', limit - 1), text.lastIndexOf(' ', limit - 1));
        cut = cut >= limit / 2 ? cut + 1 : limit;
        if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
        chunks.push(text.slice(0, cut));
        text = text.slice(cut);
    }
    if (text) chunks.push(text);
    return chunks;
}

// Pack whole units. No marker is ever split across requests.
export async function translateSafely(source, options, request, signal, limit = 1000) {
    const plan = buildPlan(source, options);
    for (const kind of ['text', 'attribute']) {
        const units = plan.units.filter(u => u.kind === kind);
        let nonce;
        do { nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 12); } while (source.includes(nonce));
        const marker = i => `[[ST_${nonce}_${i}]]`;
        const single = async unit => {
            let result = '';
            for (const chunk of splitForProvider(unit.original, limit)) {
                signal.throwIfAborted();
                // Keep chunk boundary whitespace: providers routinely trim it.
                const leading = chunk.match(/^\s*/)[0];
                const trailing = chunk.match(/\s*$/)[0];
                const core = chunk.trim();
                if (!core) { result += chunk; continue; }
                const translated = await request(core, signal);
                signal.throwIfAborted();
                if (typeof translated !== 'string' || !translated.trim()) throw new Error('Пустой перевод');
                result += leading + translated.trim() + trailing;
            }
            unit.translated = result;
        };
        let pending = [];
        let size = 0;
        const flush = async () => {
            if (!pending.length) return;
            if (pending.length === 1) { await single(pending[0].unit); pending = []; size = 0; return; }
            const payload = pending.map(({unit, id}) => `${marker(id)}\n${unit.original}\n`).join('') + marker('END');
            signal.throwIfAborted();
            const result = await request(payload, signal);
            signal.throwIfAborted();
            const expected = [...pending.map(x => marker(x.id)), marker('END')];
            const found = typeof result === 'string' ? result.match(/\[\[ST_[^\]\r\n]+\]\]/g) ?? [] : [];
            let valid = JSON.stringify(found) === JSON.stringify(expected);
            if (valid) valid = !result.slice(0, result.indexOf(expected[0])).trim() && !result.slice(result.indexOf(expected.at(-1)) + expected.at(-1).length).trim();
            const parts = valid ? pending.map((_, i) => result.slice(result.indexOf(expected[i]) + expected[i].length, result.indexOf(expected[i + 1])).trim()) : [];
            if (valid && parts.every(Boolean)) pending.forEach(({unit}, i) => { unit.translated = parts[i]; });
            else for (const {unit} of pending) await single(unit);
            pending = [];
            size = 0;
        };
        for (let id = 0; id < units.length; id++) {
            const unit = units[id];
            const cost = marker(id).length + unit.original.length + 2;
            if (size + cost + marker('END').length > limit) await flush();
            if (cost + marker('END').length > limit) await single(unit);
            else { pending.push({unit, id}); size += cost; }
        }
        await flush();
    }
    signal.throwIfAborted();
    const result = rebuild(plan);
    validateIntegrity(plan, result);
    return options.outputMode === 'both' ? {prompt:rebuild(plan, false, 'prompt'), display:result} : result;
}
