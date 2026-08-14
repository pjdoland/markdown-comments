#!/usr/bin/env bash
#
# Builds the ZIP to upload to the Chrome Web Store.
#
# The list of what goes in is explicit rather than a set of exclusions. An
# exclude list fails silently the day someone adds a directory nobody thought
# to exclude, and the failure is shipping a file that should not have left the
# machine. This way, anything new is absent until it is named here.
set -euo pipefail

cd "$(dirname "$0")"

INCLUDE=(
  manifest.json
  icons
  src
  options
)

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/markdown-comments-${VERSION}.zip"

# Refuse to build something that will not load.
python3 - <<'PY'
import json, os, sys

manifest = json.load(open('manifest.json'))
referenced = []
referenced += list(manifest.get('icons', {}).values())
referenced += list(manifest.get('action', {}).get('default_icon', {}).values())
referenced.append(manifest['background']['service_worker'])
referenced.append(manifest['options_page'])
for entry in manifest.get('content_scripts', []):
    referenced += entry.get('js', []) + entry.get('css', [])

missing = [p for p in referenced if not os.path.exists(p)]
if missing:
    sys.exit('manifest references files that do not exist: ' + ', '.join(missing))

# A NUL byte or invalid UTF-8 in a shipped source file is the kind of anomaly
# that automated review flags and nobody can explain afterwards. One was in this
# repository from its first commit, unnoticed until a grep quietly returned
# nothing, so it is checked on the way out from now on.
for root in ('src', 'options'):
    for base, dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            raw = open(path, 'rb').read()
            if b'\x00' in raw:
                sys.exit(f'{path} contains a NUL byte')
            try:
                raw.decode('utf-8')
            except UnicodeDecodeError as error:
                sys.exit(f'{path} is not valid UTF-8: {error}')
print('manifest and sources look sane')
PY

rm -rf dist
mkdir -p dist
zip -r -q "$OUT" "${INCLUDE[@]}" -x '*.DS_Store'

echo
echo "$OUT"
# -Z1 lists bare paths and is the same on BSD and GNU unzip.
unzip -Z1 "$OUT" | sed 's/^/  /'
echo
echo "$(unzip -Z1 "$OUT" | grep -vc '/$') files, $(du -h "$OUT" | cut -f1 | tr -d ' ')"
