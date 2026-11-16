import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  exitCodeFor,
  findCondition,
  isLocalOrigin,
  parseDuration,
  parseTrace,
  renderExploreHtml,
  summarizeAction,
  type ExploreReport,
} from '../src/explore.js';

// Real `bombadil trace --json` output of two states; the second one violates noUncaughtExceptions.
const fixture = readFileSync(new URL('./fixtures/explore/trace.jsonl', import.meta.url), 'utf8');

describe('explore trace parsing', () => {
  const t = parseTrace(fixture);

  it('reads every state', () => {
    assert.equal(t.badLines, 0);
    assert.deepEqual(t.states.map((s) => s.index), [0, 1]);
    assert.equal(t.states[0]!.url, 'file:///C:/work/app/buggy.html');
    assert.equal(t.states[0]!.action, '');
    assert.equal(t.states[1]!.action, 'Click button#bad "Bad" @67,103');
  });

  it('makes screenshot paths relative to the explore dir, whatever separator the engine printed', () => {
    assert.deepEqual(t.states.map((s) => s.screenshot), ['states/0.jpeg', 'states/1.jpeg']);
  });

  it('extracts the violation with its innermost condition and snapshots', () => {
    assert.equal(t.violations.length, 1);
    const v = t.violations[0]!;
    assert.equal(v.name, 'noUncaughtExceptions');
    assert.equal(v.stateIndex, 1);
    assert.match(v.condition ?? '', /uncaughtExceptions\.current\.every/);
    assert.equal(v.snapshots.length, 1);
    assert.match(JSON.stringify(v.snapshots), /boom from bad button/);
    assert.deepEqual(t.states[1]!.violations, ['noUncaughtExceptions']);
    assert.deepEqual(t.states[0]!.violations, []);
  });

  it('ignores unknown fields, defaults missing ones and counts non-JSON lines', () => {
    const t2 = parseTrace('{"index":3,"future":{"x":1}}\nnot json\n[1]\n\n{"metadata":{"violations":[{"violation":{}}]}}\n');
    assert.equal(t2.badLines, 2);
    assert.deepEqual(t2.states.map((s) => s.index), [3, 1]);
    assert.equal(t2.states[0]!.url, '');
    assert.equal(t2.violations[0]!.name, 'unnamed');
    assert.deepEqual(t2.violations[0]!.snapshots, []);
  });
});

describe('explore helpers', () => {
  it('findCondition takes the deepest condition, tolerating other nesting', () => {
    const f = findCondition({ Eventually: { violation: { condition: 'outer', snapshots: [1] }, inner: [{ x: { condition: 'inner', snapshots: [2, 3] } }] } });
    assert.equal(f.condition, 'inner');
    assert.deepEqual(f.snapshots, [2, 3]);
    assert.deepEqual(findCondition('nothing'), { snapshots: [] });
  });

  it('summarizeAction copes with unknown shapes', () => {
    assert.equal(summarizeAction(null), '');
    assert.equal(summarizeAction('Back'), 'Back');
    assert.equal(summarizeAction({ Reload: null }), 'Reload');
    assert.equal(summarizeAction({ TypeText: { text: 'hi', fingerprint: { tag: 'input', id: 'n' } } }), 'TypeText input#n text="hi"');
    assert.equal(summarizeAction({ Weird: { a: 1 } }), 'Weird');
  });

  it('exitCodeFor trusts the trace, not the engine exit code', () => {
    assert.equal(exitCodeFor(1, 0, true), 1);
    assert.equal(exitCodeFor(2, 2, true), 1);
    assert.equal(exitCodeFor(0, 0, true), 0);
    assert.equal(exitCodeFor(0, 2, true), 2);
    assert.equal(exitCodeFor(0, null, true), 2);
    assert.equal(exitCodeFor(0, 0, false), 2);
    assert.equal(exitCodeFor(3, 0, false), 2);
  });

  it('parseDuration accepts the engine syntax only', () => {
    assert.equal(parseDuration('60s'), 60_000);
    assert.equal(parseDuration('2m'), 120_000);
    assert.equal(parseDuration('1.5h'), 5_400_000);
    for (const bad of ['60', 'abc', '5x', '-1s', '']) assert.throws(() => parseDuration(bad), /time-limit/);
  });

  it('isLocalOrigin', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1/', 'http://[::1]:8080/', 'http://app.localhost/', 'file:///a/b.html']) {
      assert.equal(isLocalOrigin(u), true, u);
    }
    for (const u of ['https://example.com', 'http://10.0.0.5/', 'http://localhost.example.com/', 'nonsense']) {
      assert.equal(isLocalOrigin(u), false, u);
    }
  });
});

describe('explore html', () => {
  const t = parseTrace(fixture);
  const report = (over: Partial<ExploreReport> = {}): ExploreReport => ({
    url: 'http://localhost:3000/',
    timeLimit: '30s',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1234,
    engineExitCode: 0,
    exitCode: 1,
    states: t.states,
    violations: t.violations,
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    ...over,
  });

  it('shows the violation with its screenshot and snapshots before the state strip', () => {
    const html = renderExploreHtml(report());
    assert.match(html, /noUncaughtExceptions/);
    assert.match(html, /<img src="states\/1\.jpeg"/);
    assert.match(html, /boom from bad button/);
    assert.ok(html.indexOf('noUncaughtExceptions') < html.indexOf('class="strip"'));
    assert.match(html, /FAIL/);
  });

  it('escapes everything it prints', () => {
    const evil = '<script>alert(1)</script>';
    const html = renderExploreHtml(
      report({
        url: evil,
        error: evil,
        pageErrors: [evil],
        violations: [{ name: evil, stateIndex: 1, condition: evil, snapshots: [{ v: evil }] }],
        states: [{ index: 1, timestamp: 0, url: evil, action: evil, screenshot: '"><img src=x onerror=1>', violations: [evil] }],
      }),
    );
    assert.ok(!html.includes('<script>alert'));
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});
