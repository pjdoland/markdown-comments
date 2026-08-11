#!/bin/bash
#
# Guards the interop guarantee: the Swift and JavaScript codecs must emit
# byte-identical files. They edit the same documents, so any divergence shows
# up as spurious diffs and churned commits.
#
# The Swift codec lives in the separate RepoNotepad repository. Point
# REPO_NOTEPAD at that checkout, or keep the two side by side. With neither
# there is nothing to compare against, so this skips rather than failing.
#
# Usage: test/parity.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_REPO="${REPO_NOTEPAD:-$(cd "$ROOT/.." && pwd)/repo-notepad}"

if [ ! -f "$SWIFT_REPO/RepoNotepad/Services/CommentCodec.swift" ]; then
  echo "Skipping parity check: no RepoNotepad checkout at $SWIFT_REPO."
  echo "Set REPO_NOTEPAD=/path/to/repo-notepad to compare the two codecs."
  exit 0
fi
if ! command -v swiftc > /dev/null 2>&1; then
  echo "Skipping parity check: swiftc is not available."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/main.swift" <<'SWIFT'
import Foundation

let d1 = Date(timeIntervalSince1970: 1_786_286_520)
let d2 = Date(timeIntervalSince1970: 1_786_372_920)
func reply(_ a: String, _ d: Date, _ t: String) -> CommentReply {
    CommentReply(author: a, date: d, text: t)
}

let threads: [CommentThread] = [
    CommentThread(id: "1a2b3c4d", status: .open, anchor: "jumps over the lazy dog",
                  replies: [reply("pjdoland", d1, "Is \"jumps\" right here?"),
                            reply("alice", d2, "Yes, present tense is intentional.")]),
    CommentThread(id: "aaaaaaaa", status: .resolved, anchor: "second phrase",
                  replies: [reply("bob", d1, "Multi\nline\n\nreply with a blank line.")]),
    CommentThread(id: "bbbbbbbb", status: .open, anchor: "a list item",
                  replies: [reply("dana", d1, "Anchored at the start of a block.")]),
    CommentThread(id: "deadbeef", status: .open, anchor: "vanished text",
                  replies: [reply("carol", d2, "Orphan with <!-- markers --> and émoji 🎉 plus > angle.")])
]

let m1 = CommentCodec.anchorMarkers(for: "1a2b3c4d")
let m2 = CommentCodec.anchorMarkers(for: "aaaaaaaa")
let m3 = CommentCodec.anchorMarkers(for: "bbbbbbbb")
let body = """
# Heading

The quick brown fox \(m1.open)jumps over the lazy dog\(m1.close) every morning.

A \(m2.open)second phrase\(m2.close) in another paragraph, with **bold** text.

- \(m3.open)a list item\(m3.close) anchored at a block start
- another item
"""

print(CommentCodec.join(body: body, threads: threads), terminator: "")
SWIFT

cat > "$WORK/emit.js" <<'JS'
const codec = require(process.argv[2]);
const d1 = new Date(1786286520 * 1000);
const d2 = new Date(1786372920 * 1000);
const r = (a, d, t) => ({ author: a, date: d, text: t });

const threads = [
  { id: '1a2b3c4d', status: 'open', anchor: 'jumps over the lazy dog',
    replies: [r('pjdoland', d1, 'Is "jumps" right here?'),
              r('alice', d2, 'Yes, present tense is intentional.')] },
  { id: 'aaaaaaaa', status: 'resolved', anchor: 'second phrase',
    replies: [r('bob', d1, 'Multi\nline\n\nreply with a blank line.')] },
  { id: 'bbbbbbbb', status: 'open', anchor: 'a list item',
    replies: [r('dana', d1, 'Anchored at the start of a block.')] },
  { id: 'deadbeef', status: 'open', anchor: 'vanished text',
    replies: [r('carol', d2, 'Orphan with <!-- markers --> and émoji 🎉 plus > angle.')] }
];

const m1 = codec.anchorMarkers('1a2b3c4d');
const m2 = codec.anchorMarkers('aaaaaaaa');
const m3 = codec.anchorMarkers('bbbbbbbb');
const body = [
  '# Heading', '',
  'The quick brown fox ' + m1.open + 'jumps over the lazy dog' + m1.close + ' every morning.', '',
  'A ' + m2.open + 'second phrase' + m2.close + ' in another paragraph, with **bold** text.', '',
  '- ' + m3.open + 'a list item' + m3.close + ' anchored at a block start',
  '- another item'
].join('\n');

process.stdout.write(codec.join(body, threads));
JS

swiftc -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos14.0 \
  -o "$WORK/emit_swift" \
  "$SWIFT_REPO/RepoNotepad/Models/CommentThread.swift" \
  "$SWIFT_REPO/RepoNotepad/Services/CommentCodec.swift" \
  "$WORK/main.swift"

"$WORK/emit_swift" > "$WORK/swift.out"
node "$WORK/emit.js" "$ROOT/src/codec.js" > "$WORK/js.out"

if diff -u "$WORK/swift.out" "$WORK/js.out"; then
  echo "Codecs agree byte for byte ($(wc -c < "$WORK/swift.out" | tr -d ' ') bytes)."
else
  echo "DIVERGENCE between the Swift and JavaScript codecs." >&2
  exit 1
fi
