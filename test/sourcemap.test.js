/**
 * The source map is the riskiest piece of the extension: a wrong offset would
 * anchor a comment to the wrong words. These lock down the projection and the
 * refusal cases. How faithfully the projection matches GitHub's real renderer
 * is not covered here, since that needs a DOM.
 */
const test = require('node:test');
const assert = require('node:assert');
const map = require('../src/content/sourcemap.js');

function projectText(source) {
  return map.project(source).text;
}

test('projection strips inline emphasis but keeps the words', () => {
  assert.strictEqual(projectText('Please review **this bold** part now.'),
                     'Please review this bold part now.');
  assert.strictEqual(projectText('Some *italic* and ~~struck~~ and `code` here.'),
                     'Some italic and struck and code here.');
});

test('projection keeps link labels and drops targets', () => {
  assert.strictEqual(projectText('See [the docs](https://example.com) now.'),
                     'See the docs now.');
  assert.strictEqual(projectText('A [ref link][id] here.'), 'A ref link here.');
});

test('projection drops images entirely, matching the rendered DOM', () => {
  assert.strictEqual(projectText('Before ![alt text](img.png) after.'), 'Before after.');
});

test('projection drops block structure', () => {
  assert.strictEqual(projectText('## A heading'), 'A heading');
  assert.strictEqual(projectText('- item one\n- item two'), 'item one item two');
  assert.strictEqual(projectText('> quoted claim'), 'quoted claim');
  assert.strictEqual(projectText('- [ ] todo\n- [x] done'), 'todo done');
  assert.strictEqual(projectText('Text\n\n---\n\nMore'), 'Text More');
});

test('projection keeps fenced code content but not the fences', () => {
  assert.strictEqual(projectText('```js\nconst x = 1;\n```'), 'const x = 1;');
});

test('projection drops our anchor markers and footnote refs', () => {
  assert.strictEqual(
    projectText('The quick <!--mdc:1a2b3c4d-->brown fox<!--/mdc:1a2b3c4d-->[^mdc-1a2b3c4d] ran.'),
    'The quick brown fox ran.'
  );
});

test('projection flattens table rows to text', () => {
  assert.strictEqual(projectText('| A | B |\n| --- | --- |\n| one | two |'), 'A B one two');
});

test('finds a plain phrase', () => {
  const source = 'Hello brave new world.';
  const span = map.findSourceSpan(source, 'brave', 0);
  assert.strictEqual(source.slice(span.start, span.end), 'brave');
});

test('maps through inline markup to the source offsets', () => {
  const source = 'Please review **this bold** part now.';
  const span = map.findSourceSpan(source, 'this bold', 0);
  assert.strictEqual(source.slice(span.start, span.end), 'this bold');
});

test('maps a link label back to the label, not the url', () => {
  const source = 'See [the docs](https://example.com) now.';
  const span = map.findSourceSpan(source, 'the docs', 0);
  assert.strictEqual(source.slice(span.start, span.end), 'the docs');
});

test('maps inside a heading and a list item', () => {
  const heading = '## A heading\n\nBody.';
  assert.strictEqual(
    heading.slice(...Object.values(pick(map.findSourceSpan(heading, 'A heading', 0)))),
    'A heading'
  );
  const list = '- item one\n- item two';
  const span = map.findSourceSpan(list, 'item two', 0);
  assert.strictEqual(list.slice(span.start, span.end), 'item two');
});

function pick(span) {
  return { start: span.start, end: span.end };
}

test('ordinal disambiguates a repeated phrase', () => {
  const source = 'the fox ran. Later, the fox slept.';
  const first = map.findSourceSpan(source, 'the fox', 0);
  const second = map.findSourceSpan(source, 'the fox', 1);
  assert.strictEqual(first.start, 0);
  assert.strictEqual(second.start, source.indexOf('the fox', 1));
  assert.strictEqual(first.ambiguous, true);
});

test('an out of range ordinal clamps rather than throwing', () => {
  const source = 'the fox ran.';
  const span = map.findSourceSpan(source, 'the fox', 9);
  assert.strictEqual(source.slice(span.start, span.end), 'the fox');
});

// Anchors cannot nest: the rich editor skips text already inside a comment
// span, so inner markers would be lost on the next save from there.
test('refuses selections that overlap an existing anchor', () => {
  const source = 'The quick <!--mdc:1a2b3c4d-->brown fox<!--/mdc:1a2b3c4d--> ran fast.';
  const cases = [
    ['brown fox ran', 'straddling the closing marker'],
    ['quick brown', 'straddling the opening marker'],
    ['brown', 'wholly inside the anchor'],
    ['brown fox', 'exactly the anchor'],
    ['quick brown fox ran', 'containing the anchor']
  ];
  for (const pair of cases) {
    const span = map.findSourceSpan(source, pair[0], 0);
    assert.ok(span.error, pair[1] + ': expected refusal, got ' + JSON.stringify(span));
    assert.match(span.error, /cannot be nested/);
  }
});

test('accepts a selection adjacent to but outside an anchor', () => {
  const source = 'The quick <!--mdc:1a2b3c4d-->brown fox<!--/mdc:1a2b3c4d--> ran fast.';
  const span = map.findSourceSpan(source, 'ran fast', 0);
  assert.ok(!span.error, JSON.stringify(span));
  assert.strictEqual(source.slice(span.start, span.end), 'ran fast');
});

test('refuses text that is not in the source', () => {
  const span = map.findSourceSpan('Some prose.', 'not present here', 0);
  assert.ok(span.error);
});

test('refuses an empty selection', () => {
  assert.ok(map.findSourceSpan('Some prose.', '   ', 0).error);
});

test('whitespace differences do not defeat matching', () => {
  const source = 'A sentence broken\nacross two source lines.';
  const span = map.findSourceSpan(source, 'broken across two', 0);
  assert.strictEqual(source.slice(span.start, span.end), 'broken\nacross two');
});

test('an anchor inserted at the mapped span wraps exactly the selection', () => {
  const codec = require('../src/codec.js');
  const source = 'Please review **this bold** part now.';
  const span = map.findSourceSpan(source, 'this bold', 0);
  const updated = codec.insertAnchor(source, 'deadbeef', span.start, span.end);
  assert.strictEqual(updated, 'Please review **<!--mdc:deadbeef-->this bold<!--/mdc:deadbeef-->** part now.');
});

// MARK: - Recovering an orphan

test('a lightly edited sentence is found', () => {
  const source = 'Intro paragraph.\n\nActivation rose 11 % against the control group, and it held.';
  const found = map.findFuzzySpan(source, '11% against control');
  assert.ok(found, 'expected a candidate');
  assert.ok(found.score >= 0.7);
  assert.ok(source.slice(found.start, found.end).includes('against'));
});

test('a phrase that is simply gone returns null', () => {
  const source = 'Nothing in this document resembles the missing sentence at all.';
  assert.strictEqual(map.findFuzzySpan(source, 'activation rose eleven percent'), null);
});

test('two equally good candidates are refused', () => {
  const source = 'The deploy failed twice today.\n\nThe deploy failed twice today.';
  assert.strictEqual(map.findFuzzySpan(source, 'deploy failed twice'), null);
});

test('a one word anchor is never fuzzy matched', () => {
  assert.strictEqual(map.findFuzzySpan('the activation number moved', 'activation'), null);
});

test('a candidate overlapping an existing anchor is refused', () => {
  const source = 'Activation rose <!--mdc:aaaaaaaa-->11 % against the control<!--/mdc:aaaaaaaa--> group.';
  assert.strictEqual(map.findFuzzySpan(source, '11% against control'), null);
});

test('the candidate maps back to a span an anchor can wrap', () => {
  const source = 'Lead in.\n\nActivation rose 11 % against the control group, and it held.';
  const found = map.findFuzzySpan(source, '11% against control');
  const wrapped = source.slice(0, found.start) + '[[' + source.slice(found.start, found.end) + ']]' +
                  source.slice(found.end);
  assert.ok(wrapped.includes('[['), 'span is insertable');
  assert.ok(!source.slice(found.start, found.end).includes('<!--'));
});
