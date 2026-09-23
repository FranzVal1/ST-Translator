import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, rebuild, validateIntegrity } from '../parser.js';
const options = { preserveCode: true, preserveMacros: true, preserveUrls: true, preserveAngleInstructions: true, translateAttributes: true, minTextLength: 1 };
test('translated attributes pass integrity and cannot create HTML attributes', () => {
    const plan = buildPlan('<button title="Open">Click</button>', options);
    for (const unit of plan.units) unit.translated = unit.kind === 'attribute' ? 'Say "hello" & go' : 'Нажать';
    const result = rebuild(plan);
    assert.equal(result, '<button title="Say &quot;hello&quot; &amp; go">Нажать</button>');
    assert.doesNotThrow(() => validateIntegrity(plan, result));
    assert.throws(() => validateIntegrity(plan, result.replace('</button>', '')));
});

test('hidden, service and configured blocks are opaque even with attribute translation', () => {
    for (const source of [
        '<div hidden title="Secret">Do not translate <div>nested</div></div>',
        '<span style="display: none !important" title="Secret">Instruction</span>',
        '<div style="visibility:hidden">Instruction</div>',
        '<div class="secret other">Instruction</div>',
        '<aside>Instruction</aside>',
        '<instruction title="Secret">Instruction</instruction>',
        '<script title="Secret">const x = "Secret";</script>',
        '<!-- hidden > instruction -->',
    ]) {
        const plan = buildPlan(source + ' Visible', { ...options, protectedTags: ['aside'], protectedClasses: ['secret'] });
        assert.deepEqual(plan.units.map(u => u.original), ['Visible'], source);
        plan.units[0].translated = 'Видно';
        assert.equal(rebuild(plan), source + ' Видно');
    }
});

test('macros, URLs and entities in visible attributes stay local', () => {
    const source = '<img alt="Hello {{user}} &amp; https://example.com">';
    const plan = buildPlan(source, options);
    assert.deepEqual(plan.units.map(u => u.original), ['Hello']);
    plan.units[0].translated = 'Привет "друг"';
    const result = rebuild(plan);
    assert.equal(result, '<img alt="Привет &quot;друг&quot; {{user}} &amp; https://example.com">');
    validateIntegrity(plan, result);
});

test('ambiguous hidden styles, duplicate attrs and incomplete macros fail closed', () => {
    for (const source of [
        '<div style="display:&#110;one">SECRET</div>',
        '<div style="display:none" style="color:red">SECRET</div>',
        '<div style="d\\69splay:none">SECRET</div>',
        '{{unfinished SECRET',
        '<instruction>SECRET',
    ]) assert.deepEqual(buildPlan(source, options).units, [], source);
});

test('hidden HTML boundaries ignore commented closing tags and non-void self-closing slashes', () => {
    for (const source of [
        '<div hidden><!-- > </div> -->SECRET</div>',
        '<div hidden/>SECRET</div>',
        '<div hidden><script>"</div>"</script>SECRET</div>',
    ]) {
        const plan = buildPlan(source + ' Visible', options);
        assert.deepEqual(plan.units.map(x=>x.original), ['Visible']);
    }
});
