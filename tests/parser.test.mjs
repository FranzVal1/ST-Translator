import assert from 'node:assert/strict';
import { buildPlan, rebuild, validateIntegrity } from '../parser.js';

const options = {
  preserveCode: true,
  preserveMacros: true,
  preserveUrls: true,
  preserveAngleInstructions: true,
  translateAttributes: false,
  translateTitle: true,
  translateAlt: true,
  translatePlaceholder: true,
  translateAriaLabel: true,
  minTextLength: 1,
};

function fakeTranslate(source, fn = (x) => `RU(${x})`) {
  const plan = buildPlan(source, options);
  for (const unit of plan.units) unit.translated = fn(unit.original);
  const result = rebuild(plan);
  validateIntegrity(plan, result);
  return { plan, result };
}

{
  const { result } = fakeTranslate('<div class="x">Hello <b>world</b></div>');
  assert.equal(result, '<div class="x">RU(Hello) <b>RU(world)</b></div>');
}
{
  const { plan, result } = fakeTranslate('Before <сделай что-то> After');
  assert.deepEqual(plan.units.map(x => x.original), ['Before', 'After']);
  assert.equal(result, 'RU(Before) <сделай что-то> RU(After)');
}
{
  const source = '<instruction>Do not translate <nested>this</nested></instruction> Visible';
  const { plan, result } = fakeTranslate(source);
  assert.deepEqual(plan.units.map(x => x.original), ['Visible']);
  assert.equal(result, '<instruction>Do not translate <nested>this</nested></instruction> RU(Visible)');
}
{
  const { plan, result } = fakeTranslate('`Inner thought` and ``code text``');
  assert.deepEqual(plan.units.map(x => x.original), ['Inner thought', 'and']);
  assert.equal(result, '`RU(Inner thought)` RU(and) ``code text``');
}
{
  const { result } = fakeTranslate('"Hello," she said.');
  assert.equal(result, '"RU(Hello,)" RU(she said.)');
}
{
  const macro = '{{outer::{{inner::value}}::tail}}';
  const { plan, result } = fakeTranslate(`A ${macro} B`);
  assert.deepEqual(plan.units.map(x => x.original), ['A', 'B']);
  assert.equal(result, `RU(A) ${macro} RU(B)`);
}
{
  const { result } = fakeTranslate('  Hello\n', x => x.toUpperCase());
  assert.equal(result, '  HELLO\n');
}
{
  const attrOptions = { ...options, translateAttributes: true };
  const plan = buildPlan('<button title="Open" onclick="x()">Click</button>', attrOptions);
  assert.deepEqual(plan.units.map(x => x.original), ['Open', 'Click']);
  plan.units[0].translated = 'Открыть';
  plan.units[1].translated = 'Нажать';
  assert.equal(rebuild(plan), '<button title="Открыть" onclick="x()">Нажать</button>');
}
{
  const url = 'https://example.com/a?q=1';
  const { plan, result } = fakeTranslate(`Open ${url} now`);
  assert.deepEqual(plan.units.map(x => x.original), ['Open', 'now']);
  assert.equal(result, `RU(Open) ${url} RU(now)`);
}

console.log('parser tests: OK');
