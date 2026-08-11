/**
 * The file format. Mirrored by a Swift implementation that must agree byte
 * for byte; see test/parity.sh. Run with:
 *   node --test chrome-extension/test/
 */
const test = require('node:test');
const assert = require('node:assert');
const codec = require('../src/codec.js');

const EPOCH = new Date('2026-08-10T14:42:00Z');

function thread(overrides) {
  const o = overrides || {};
  const texts = o.texts || ['Is "jumps" right here?'];
  return {
    id: o.id || '1a2b3c4d',
    status: o.status || 'open',
    anchor: o.anchor || 'jumps over the lazy dog',
    replies: texts.map((text, i) => ({
      author: i === 0 ? 'pjdoland' : 'alice',
      date: EPOCH,
      text: text
    })),
    isOrphaned: false
  };
}

function anchoredBody(id) {
  const m = codec.anchorMarkers(id || '1a2b3c4d');
  return 'The quick brown fox ' + m.open + 'jumps over the lazy dog' + m.close + ' every morning.';
}

test('uncommented document is untouched', () => {
  const body = '# Title\n\nSome prose.\n';
  const result = codec.split(body);
  assert.strictEqual(result.body, body);
  assert.strictEqual(result.threads.length, 0);
  assert.strictEqual(codec.join(body, []), body);
});

test('join with no threads adds no footprint', () => {
  assert.strictEqual(codec.join('no trailing newline', []), 'no trailing newline');
});

test('split of join recovers body and threads', () => {
  const joined = codec.join(anchoredBody(), [thread()]);
  const result = codec.split(joined);

  assert.strictEqual(result.body, anchoredBody());
  assert.strictEqual(result.threads.length, 1);
  assert.strictEqual(result.threads[0].id, '1a2b3c4d');
  assert.strictEqual(result.threads[0].anchor, 'jumps over the lazy dog');
  assert.strictEqual(result.threads[0].replies[0].author, 'pjdoland');
  assert.strictEqual(result.threads[0].replies[0].text, 'Is "jumps" right here?');
  assert.strictEqual(result.threads[0].isOrphaned, false);
});

// The whole design depends on this: a commented file must not open dirty.
test('join is idempotent', () => {
  const once = codec.join(anchoredBody(), [thread({ texts: ['First.', 'Second.'] })]);
  const reparsed = codec.split(once);
  const twice = codec.join(reparsed.body, reparsed.threads);
  assert.strictEqual(twice, once);
});

test('footnote reference follows the closing anchor', () => {
  const out = codec.join(anchoredBody(), [thread()]);
  assert.ok(out.includes('<!--/mdc:1a2b3c4d-->[^mdc-1a2b3c4d]'));
  assert.ok(out.includes('[^mdc-1a2b3c4d]:'));
});

test('references do not accumulate across saves', () => {
  let out = codec.join(anchoredBody(), [thread()]);
  for (let i = 0; i < 3; i++) {
    const s = codec.split(out);
    out = codec.join(s.body, s.threads);
  }
  assert.strictEqual(out.split('[^mdc-1a2b3c4d]').length - 1, 2);
});

test('mid-line multi-span anchor gets one reference, on the final marker', () => {
  const m = codec.anchorMarkers('1a2b3c4d');
  const body = 'A ' + m.open + 'first part' + m.close + ' and B ' + m.open + 'second part' + m.close;
  const out = codec.join(body, [thread()]);
  assert.strictEqual(out.split('[^mdc-1a2b3c4d]').length - 1, 2); // one ref, one definition
  assert.ok(out.includes('second part' + m.close + '[^mdc-1a2b3c4d]'));
});

// Each block-initial marker would open its own HTML block, so each needs its
// own reference in front of it. GFM allows repeated references to one footnote.
test('multi-span anchor across blocks gets a reference per block', () => {
  const m = codec.anchorMarkers('1a2b3c4d');
  const body = m.open + 'First para' + m.close + '\n\n' + m.open + 'second para' + m.close;
  const out = codec.join(body, [thread()]);
  assert.strictEqual(out.split('[^mdc-1a2b3c4d]').length - 1, 3); // two refs, one definition
  for (const line of out.split('\n')) {
    assert.ok(!/^\s{0,3}<!--mdc:/.test(line), 'line opens an HTML block: ' + JSON.stringify(line));
  }
});

// A line starting with "<!--" is an HTML block in CommonMark. GitHub swallows
// the rest of the line, strips the markers, and renders "[^mdc-id]" as literal
// text in the prose. Leading with the reference keeps the line as markdown.
test('reference precedes an anchor that starts a block', () => {
  const m = codec.anchorMarkers('1a2b3c4d');
  const cases = [
    '- ' + m.open + 'Second item' + m.close + ' in a list',
    '> ' + m.open + 'A quoted claim' + m.close + ' worth it',
    '## ' + m.open + 'A heading' + m.close,
    m.open + 'Whole paragraph.' + m.close,
    '1. ' + m.open + 'Numbered item' + m.close
  ];
  for (const body of cases) {
    const out = codec.join(body, [thread()]);
    const line = out.split('\n').find(l => l.includes('mdc:1a2b3c4d'));
    assert.ok(line.includes('[^mdc-1a2b3c4d]' + m.open),
      'reference should lead the marker in: ' + JSON.stringify(line));
    assert.ok(!/^\s*(?:[-*+>]|\d+[.)]|#{1,6})?\s*<!--/.test(line),
      'line must not begin with an HTML comment: ' + JSON.stringify(line));
  }
});

test('reference still trails a mid-line anchor', () => {
  const out = codec.join(anchoredBody(), [thread()]);
  assert.ok(out.includes('<!--/mdc:1a2b3c4d-->[^mdc-1a2b3c4d]'));
});

test('block-initial anchors stay idempotent', () => {
  const m = codec.anchorMarkers('1a2b3c4d');
  const once = codec.join('- ' + m.open + 'Second item' + m.close + ' in a list', [thread()]);
  const reparsed = codec.split(once);
  assert.strictEqual(codec.join(reparsed.body, reparsed.threads), once);
});

test('adjacent anchor pairs are merged', () => {
  const m = codec.anchorMarkers('1a2b3c4d');
  const body = m.open + 'one' + m.close + m.open + 'two' + m.close;
  assert.ok(codec.join(body, [thread()]).includes(m.open + 'onetwo' + m.close));
});

test('anchors with no thread are dropped', () => {
  const out = codec.join(anchoredBody('deadbeef'), []);
  assert.strictEqual(out, 'The quick brown fox jumps over the lazy dog every morning.');
});

test('thread without an anchor is marked orphaned', () => {
  const rewritten = codec.join('Entirely new text.', [thread()]);
  const reread = codec.split(rewritten);
  assert.strictEqual(reread.threads.length, 1);
  assert.strictEqual(reread.threads[0].isOrphaned, true);
});

// An unreferenced footnote definition renders as literal text on GitHub.
test('orphan emits no footnote definition', () => {
  const out = codec.join('Entirely new text.', [thread()]);
  assert.ok(!out.includes('[^mdc-1a2b3c4d]'));
  assert.ok(out.includes('**Unanchored comments**'));
  assert.ok(out.includes('jumps over the lazy dog'));
});

test('resolved status survives a round trip', () => {
  const joined = codec.join(anchoredBody(), [thread({ status: 'resolved' })]);
  assert.ok(joined.includes('_(resolved)_'));
  assert.strictEqual(codec.split(joined).threads[0].status, 'resolved');
});

test('reply text cannot forge a sentinel', () => {
  const hostile = thread({ texts: ['look: <!-- mdc-comments-end --> and --> too'] });
  const joined = codec.join(anchoredBody(), [hostile]);

  assert.strictEqual(joined.split(codec.END_SENTINEL).length - 1, 1);
  assert.strictEqual(joined.split(codec.BEGIN_SENTINEL).length - 1, 1);

  const result = codec.split(joined);
  assert.strictEqual(result.threads.length, 1);
  assert.strictEqual(result.threads[0].replies[0].text, 'look: <!-- mdc-comments-end --> and --> too');
});

test('JSON block never contains a comment terminator', () => {
  const joined = codec.join(anchoredBody(), [thread({ anchor: 'a --> b', texts: ['c --> d'] })]);
  const start = joined.indexOf('<!-- mdc-comments-data');
  const end = joined.indexOf('-->', start + 1);
  assert.ok(start !== -1 && end !== -1);
  assert.ok(!joined.slice(start + '<!-- mdc-comments-data'.length, end).includes('>'));
});

test('text below the region is preserved', () => {
  const joined = codec.join(anchoredBody(), [thread()]);
  const tampered = joined + '\nA stray line someone typed at the bottom.\n';
  const result = codec.split(tampered);
  assert.ok(result.body.includes('A stray line someone typed at the bottom.'));
  assert.strictEqual(result.threads.length, 1);
});

test('ordered anchor ids follow document order', () => {
  const a = codec.anchorMarkers('aaaaaaaa');
  const b = codec.anchorMarkers('bbbbbbbb');
  const body = a.open + 'one' + a.close + ' then ' + b.open + 'two' + b.close;
  assert.deepStrictEqual(codec.orderedAnchorIDs(body), ['aaaaaaaa', 'bbbbbbbb']);
});

test('unpaired anchor is not reported', () => {
  assert.strictEqual(codec.anchorIDs('text <!--mdc:aaaaaaaa--> with no close').size, 0);
});

test('insertAnchor wraps a source range', () => {
  const body = 'Hello brave new world.';
  const out = codec.join(codec.insertAnchor(body, 'deadbeef', 6, 11), [
    thread({ id: 'deadbeef', anchor: 'brave' })
  ]);
  assert.ok(out.includes('Hello <!--mdc:deadbeef-->brave<!--/mdc:deadbeef-->[^mdc-deadbeef] new world.'));
});

test('newID produces a valid 8 hex char id', () => {
  for (let i = 0; i < 50; i++) assert.match(codec.newID(), /^[0-9a-f]{8}$/);
});

test('display dates ignore the host locale and time zone', () => {
  assert.strictEqual(codec.displayDate(new Date('2026-08-10T23:30:00Z')), 'Aug 10, 2026');
  assert.strictEqual(codec.displayDate(new Date('2026-01-01T00:00:00Z')), 'Jan 1, 2026');
});
