/**
 * docs/FORMAT.md against the codec.
 *
 * The specification exists so someone else can write an implementation that
 * reads and writes these files. Every conformance vector in it is therefore
 * asserted to be the exact bytes this codec produces. A vector transcribed by
 * hand is a vector that will be wrong eventually, and a wrong vector is worse
 * than no specification: it sends an implementer somewhere that never
 * interoperates. Run with:
 *   node --test test/format-spec.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const codec = require('../src/codec.js');

const SPEC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'FORMAT.md'), 'utf8');

const FIRST = new Date('2026-08-10T14:42:00Z');
const SECOND = new Date('2026-08-11T09:05:30Z');
const ID = 'a1b2c3d4';
const M = codec.anchorMarkers(ID);

function thread(overrides) {
  return Object.assign({
    id: ID,
    status: 'open',
    anchor: 'jumps over',
    replies: [{ author: 'pjdoland', date: FIRST, text: 'Is this right?' }]
  }, overrides || {});
}

/** Asserts the spec quotes this exact text somewhere. */
function specContains(text, what) {
  specQuotes(text, 1, what);
}

/**
 * Asserts the spec quotes this text at least `times` over.
 *
 * Sections 7 and 13 deliberately show the same output twice, once to explain a
 * rule and once as a vector. Counting is what keeps the explanatory copy honest:
 * checking only that the text appears somewhere would let the illustration rot
 * while the vector below it stayed right.
 */
function specQuotes(text, times, what) {
  let found = 0;
  let at = SPEC.indexOf(text);
  while (at !== -1) {
    found += 1;
    at = SPEC.indexOf(text, at + 1);
  }
  assert.ok(found >= times,
    what + ': expected docs/FORMAT.md to quote this ' + times + ' time(s), found ' +
    found + '. As the codec produces it:\n' + text);
}

test('13.1 one thread, one reply', () => {
  const body = 'The quick brown fox ' + M.open + 'jumps over' + M.close + ' the lazy dog.';
  specContains(codec.join(body, [thread()]), 'the minimal vector');
});

test('13.2 resolved, two replies, one spanning paragraphs', () => {
  const body = 'The quick brown fox ' + M.open + 'jumps over' + M.close + ' the lazy dog.';
  const out = codec.join(body, [thread({
    status: 'resolved',
    replies: [
      { author: 'pjdoland', date: FIRST, text: 'Is this right?' },
      { author: 'dreyes', date: SECOND, text: 'Points, not percent.\n\nFixing the wording now.' }
    ]
  })]);
  // The definition alone, which is what the section quotes. Note the colon:
  // the same token without it is the reference up in the body.
  const definition = out.slice(out.indexOf('[^mdc-' + ID + ']:'),
                               out.indexOf('\n\n<!-- mdc-comments-end'));
  // Twice: the rule in 7.1 and the vector in 13.2.
  specQuotes(definition, 2, 'the multi-reply definition');
});

test('13.3 block-initial anchor', () => {
  const body = '## ' + M.open + 'A heading' + M.close + '\n\nBody text.';
  const out = codec.join(body, [thread({ anchor: 'A heading' })]);
  specContains(out.slice(0, out.indexOf('\n\n<!-- mdc-comments-begin')), 'the block-initial vector');
});

test('13.4 orphaned thread', () => {
  const out = codec.join('No anchors left in this text at all.', [thread()]);
  specContains(out, 'the orphan vector');

  // The unanchored list is shown again as the rule in 7.2.
  const list = out.slice(out.indexOf('**Unanchored comments**'),
                         out.indexOf('\n\n<!-- mdc-comments-end'));
  specQuotes(list, 2, 'the unanchored list');
});

test('13.5 escaping', () => {
  const out = codec.join('Text ' + M.open + 'here' + M.close + '.', [thread({
    anchor: 'a > b',
    replies: [{ author: 'pjdoland', date: FIRST, text: 'careful: <!-- and --> and 5 > 3' }]
  })]);

  const jsonLine = out.split('\n').find(function (line) { return line.startsWith('{"anchor"'); });
  specContains(jsonLine, 'the escaped data line');
  // The escape has to survive into the document as six literal characters.
  assert.ok(jsonLine.includes('\\u003e'), 'codec escapes > in the data block');

  // The data block also contains "careful:", so match the visible layer by its
  // shape instead: four spaces, then the reply head.
  const visible = out.split('\n').find(function (line) { return line.startsWith('    **@'); });
  specContains(visible, 'the escaped visible line');
  assert.ok(visible.includes('&lt;!--') && visible.includes('--&gt;') && visible.includes('5 > 3'),
    'the visible layer escapes only the comment delimiters');
});

test('13.6 no threads leaves nothing behind', () => {
  const body = 'A ' + M.open + 'b' + M.close + '[^mdc-' + ID + '] c';
  assert.strictEqual(codec.join(body, []), 'A b c');
  specContains('yields\nexactly `A b c`', 'the empty-threads vector');
});

test('the literals in section 4 are the ones the codec uses', () => {
  specContains('`' + codec.BEGIN_SENTINEL + '`', 'the begin sentinel');
  specContains('`' + codec.END_SENTINEL + '`', 'the end sentinel');
  specContains('`' + M.open.replace(ID, '` *id* `') + '`', 'the open marker shape');
});

test('the declared version is the one written', () => {
  specContains('**Version ' + codec.FORMAT_VERSION + '.**', 'the version heading');
  const out = codec.join('x ' + M.open + 'y' + M.close + '.', [thread({ anchor: 'y' })]);
  assert.ok(out.includes('{"v":' + codec.FORMAT_VERSION + ',"threads":['));
});

// The reader contract in section 14, which is where an implementation is most
// likely to differ and least likely to be exercised by its own happy path.
test('14 reader robustness table holds', () => {
  const good = codec.join('x ' + M.open + 'y' + M.close + '.', [thread({ anchor: 'y' })]);

  assert.deepStrictEqual(codec.split('No region here.').threads, []);
  assert.strictEqual(codec.split('No region here.').body, 'No region here.');

  const unterminated = good.replace(codec.END_SENTINEL, '');
  assert.deepStrictEqual(codec.split(unterminated).threads, [], 'begin without end');
  assert.strictEqual(codec.split(unterminated).body, unterminated, 'body left whole');

  const brokenJSON = good.replace('{"v":1,"threads":[', '{"v":1,"threads":[ NOT JSON');
  assert.deepStrictEqual(codec.split(brokenJSON).threads, [], 'unparseable data block');

  const badID = good.replace('"id":"a1b2c3d4"', '"id":"NOT-AN-ID"');
  assert.deepStrictEqual(codec.split(badID).threads, [], 'malformed id discarded');

  const oddStatus = good.replace('"status":"open"', '"status":"whatever"');
  assert.strictEqual(codec.split(oddStatus).threads[0].status, 'open', 'unknown status');

  const badDate = good.replace('"at":"2026-08-10T14:42:00Z"', '"at":"not a date"');
  assert.strictEqual(codec.split(badDate).threads[0].replies[0].date.getTime(), 0, 'epoch fallback');
});
