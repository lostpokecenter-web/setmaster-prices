#!/usr/bin/env python3
"""Keeps SetMaster's own price history. Run after pricecharting_upload.py with the same CSV folder.

  python pricecharting_history.py FILE_OR_FOLDER [...]

For every set it reads each history shard from the server, adds today's prices (only when they changed since the last row),
and stores the shard again. PriceCharting offers no history, so the chart starts the first day this runs and grows daily.
Settings (environment or .env next to this script): IMPORT_URL, IMPORT_TOKEN.

A shard holds many items: {"v":1,"items":{"<id>":[[day, loose, cib, new, graded, box_only, psa10, bgs10, cgc10, sgc10, cgc10_pristine, bgs10_black, tag10, ace10], ...]}}
(day = days since 2020-01-01, prices in cents, trailing empty values left off). A row is written only when something changed.
"""
import argparse, datetime, json, os, sys, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from pricecharting_upload import build, read_files

SHARDS = 4  # the server's HIST_SHARDS
KEEP_DAYS = 400
EPOCH = datetime.date(2020, 1, 1)
UA = 'SetMasterPriceJob/1.0 (+https://lostpokecenter.com)'
K_KEYS = ('17', '18', '19', '20', '21', '22')


def daynum(d):
    return (d - EPOCH).days


def row_of(it):
    vals = [it.get(c) for c in 'lcwgbmx'] + [(it.get('k') or {}).get(k) for k in K_KEYS]
    while vals and vals[-1] is None:
        vals.pop()
    return vals


def merge(shard, items, day, keep=KEEP_DAYS):
    """Adds today's rows to a shard (dict). Returns how many items changed."""
    changed = 0
    store = shard.setdefault('items', {})
    for it in items:
        r = row_of(it)
        rows = store.get(str(it['i']))
        if not rows and not r:
            continue
        rows = store.setdefault(str(it['i']), [])
        last = rows[-1] if rows else None
        if last and last[0] == day:
            if last[1:] != r:
                rows[-1] = [day] + r
                changed += 1
        elif last is None or last[1:] != r:
            rows.append([day] + r)
            changed += 1
    cutoff = day - keep
    for k in list(store):
        rows = store[k]
        old = [x for x in rows if x[0] < cutoff]
        if old:  # keep the last old row so the line starts at the cutoff with the price that applied then
            rows = [[cutoff] + old[-1][1:]] + [x for x in rows if x[0] >= cutoff]
            store[k] = rows
    return changed


def call(url, token, method, path, body=None):
    req = urllib.request.Request(url + path, data=body, method=method, headers={'x-import-token': token, 'user-agent': UA, 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def process(args):
    url, token, game, slug, n, items, day = args
    q = f'?game={game}&console={slug}&shard={n}'
    try:
        try:
            shard = json.loads(call(url, token, 'GET', '/prices/pc/hist' + q))
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            shard = {'v': 1, 'items': {}}
        changed = merge(shard, items, day)
        if changed or not shard.get('items'):
            shard['v'] = 1
            body = json.dumps({'v': 1, 'items': shard['items']}, separators=(',', ':')).encode()
            call(url, token, 'PUT', '/prices/pc/hist' + q, body)
        return changed, None
    except urllib.error.HTTPError as e:
        return 0, f'{game}/{slug}/{n}: HTTP {e.code} {e.read()[:100]!r}'
    except Exception as e:
        return 0, f'{game}/{slug}/{n}: {type(e).__name__}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--date', default=datetime.date.today().isoformat())
    a = ap.parse_args()
    envf = Path(__file__).with_name('.env')
    if envf.exists():
        for line in envf.read_text().splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())
    url, token = os.environ.get('IMPORT_URL', '').rstrip('/'), os.environ.get('IMPORT_TOKEN', '')
    if not (url and token):
        print('STOP: set IMPORT_URL and IMPORT_TOKEN')
        return 2
    day = daynum(datetime.date.fromisoformat(a.date))
    sets = build(read_files(a.paths), a.date)
    jobs = []
    for (game, slug), d in sets.items():
        by = {}
        for it in d['items']:
            by.setdefault(it['i'] % SHARDS, []).append(it)
        for n, items in by.items():
            jobs.append((url, token, game, slug, n, items, day))
    print(f'{len(sets)} sets, {len(jobs)} history shards', flush=True)
    changed = bad = done = 0
    with ThreadPoolExecutor(6) as ex:
        for c, err in ex.map(process, jobs):
            done += 1
            changed += c
            if err:
                bad += 1
                if bad <= 10:
                    print('FAIL', err, flush=True)
            if done % 500 == 0:
                print(f'... {done} of {len(jobs)} shards', flush=True)
            if bad >= 25 and bad == done:
                print('STOP: every shard failed, so the setting is wrong')
                return 1
    print(f'{done - bad} shards ok, {bad} failed, {changed} price changes recorded')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
