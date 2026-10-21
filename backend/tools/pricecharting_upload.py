#!/usr/bin/env python3
"""Turns PriceCharting CSV files into one small file per set and uploads them to the SetMaster server.

  python pricecharting_upload.py FILE_OR_FOLDER [...]        upload
  python pricecharting_upload.py --dry-run FILE_OR_FOLDER    only report what would be uploaded (nothing is sent)

Settings (environment, or a .env file next to this script; never put them in chat):
  IMPORT_URL     https://api.lostpokecenter.com
  IMPORT_TOKEN   the server's import secret
Games are decided by each set's name (console-name), never by which file it came from.
"""
import argparse, csv, datetime, json, os, re, sys, time
from pathlib import Path
import urllib.request, urllib.error

# console-name prefix -> game (checked in this order, case-insensitive)
GAME_PREFIXES = [
    ('pokemon', 'pokemon'), ('magic', 'mtg'), ('yugioh', 'yugioh'), ('lorcana', 'lorcana'), ('one piece', 'onepiece'),
    ('digimon', 'digimon'), ('flesh and blood', 'fab'), ('star wars unlimited', 'swu'), ('star wars', 'swu'),
    ('dragon ball', 'dragonball'), ('riftbound', 'riftbound'), ('gundam', 'gundam'),
]
PRICE_COLS = {'l': 'loose-price', 'c': 'cib-price', 'w': 'new-price', 'g': 'graded-price', 'b': 'box-only-price', 'm': 'manual-only-price', 'x': 'bgs-10-price'}
MAX_BYTES = 7_500_000


def game_of(console):
    low = console.lower()
    for prefix, game in GAME_PREFIXES:
        if low.startswith(prefix):
            return game
    return 'other'


def slug_of(console):
    return re.sub(r'[^a-z0-9]+', '-', console.lower()).strip('-')[:120] or 'unknown'


def cents(v):
    v = (v or '').strip().replace('$', '').replace(',', '')
    if not v:
        return None
    try:
        return int(round(float(v) * 100))
    except ValueError:
        return None


def item_of(row):
    it = {'i': int(row['id']), 'n': row['product-name']}
    for k, col in PRICE_COLS.items():
        c = cents(row.get(col))
        if c is not None:
            it[k] = c
    extra = {}
    for n in range(9, 23):  # condition-9..22 price columns (kept raw until the grade mapping is confirmed)
        c = cents(row.get(f'condition-{n}-price'))
        if c is not None:
            extra[str(n)] = c
    if extra:
        it['k'] = extra
    if (row.get('tcg-id') or '').strip().isdigit():
        it['t'] = int(row['tcg-id'])
    if (row.get('sales-volume') or '').strip().isdigit():
        it['v'] = int(row['sales-volume'])
    if (row.get('genre') or '').strip().lower() == 'sealed product':
        it['s'] = 1
    if (row.get('release-date') or '').strip():
        it['r'] = row['release-date'].strip()
    return it


def read_files(paths):
    files = []
    for p in map(Path, paths):
        files += sorted(p.rglob('*.csv')) if p.is_dir() else [p]
    return files


def build(files, date):
    """{(game, slug): file dict} from every row of every CSV."""
    sets = {}
    for f in files:
        with open(f, encoding='utf-8-sig', newline='') as fh:
            rd = csv.DictReader(fh)
            if not rd.fieldnames or rd.fieldnames[:3] != ['id', 'console-name', 'product-name']:
                print(f'skip {f.name}: not a PriceCharting price list')
                continue
            for row in rd:
                try:
                    it = item_of(row)
                except (ValueError, KeyError):
                    continue
                name = row['console-name']
                key = (game_of(name), slug_of(name))
                d = sets.setdefault(key, {'v': 1, 'game': key[0], 'slug': key[1], 'name': name, 'date': date, 'items': []})
                d['items'].append(it)
    return sets


def post(url, token, game, slug, body):
    req = urllib.request.Request(f'{url}/prices/pc/import?game={game}&console={slug}', data=body, method='PUT',
                                 headers={'x-import-token': token, 'content-type': 'application/json', 'user-agent': 'SetMasterPriceJob/1.0 (+https://lostpokecenter.com)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--date', default=datetime.date.today().isoformat())
    a = ap.parse_args()
    envf = Path(__file__).with_name('.env')
    if envf.exists():
        for line in envf.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())
    url, token = os.environ.get('IMPORT_URL', '').rstrip('/'), os.environ.get('IMPORT_TOKEN', '')
    if not a.dry_run and not (url and token):
        print('STOP: set IMPORT_URL and IMPORT_TOKEN')
        return 2
    sets = build(read_files(a.paths), a.date)
    print(f'{len(sets)} sets to send', flush=True)
    per_game = {}
    ok = bad = streak = 0
    for (game, slug), d in sorted(sets.items()):
        body = json.dumps(d, separators=(',', ':'), ensure_ascii=False).encode()
        per_game[game] = per_game.get(game, 0) + len(d['items'])
        if len(body) > MAX_BYTES:
            print(f'FAIL {game}/{slug}: file too large ({len(body)} bytes)')
            bad += 1
            continue
        if a.dry_run:
            ok += 1
            continue
        try:
            post(url, token, game, slug, body)
            ok += 1
            streak = 0
        except urllib.error.HTTPError as e:
            print(f'FAIL {game}/{slug}: HTTP {e.code} {e.read()[:160]!r}')
            bad += 1
            streak += 1
        except Exception as e:
            print(f'FAIL {game}/{slug}: {type(e).__name__}')
            bad += 1
            streak += 1
        if streak >= 5:
            print('STOP: 5 failures in a row, so the setting is wrong (see the FAIL lines above). Nothing more was sent.')
            break
        if (ok + bad) % 20 == 0:
            print(f'... {ok + bad} of {len(sets)} sets sent', flush=True)
        time.sleep(0.05)
    print(('DRY RUN: ' if a.dry_run else '') + f'{ok} sets ok, {bad} failed; items per game: {per_game}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
