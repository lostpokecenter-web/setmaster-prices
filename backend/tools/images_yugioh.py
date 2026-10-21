#!/usr/bin/env python3
"""Copies Yu-Gi-Oh! card pictures to the SetMaster picture storage, once each.

YGOPRODeck asks apps to download every picture once and host it themselves ("Please only pull an image once and then store
it locally"), so this job fetches only pictures the server does not have yet and goes slowly (about 4 a second).

  python images_yugioh.py            fetch what is missing and upload it
  python images_yugioh.py --dry-run  only say how many pictures are missing
  python images_yugioh.py --limit 500   stop after 500 uploads (a test run)

Settings (environment, never in chat): IMPORT_URL (https://api.lostpokecenter.com), IMPORT_TOKEN.
"""
import argparse, json, os, sys, time
import urllib.request, urllib.error

UA = 'SetMasterPriceJob/1.0 (+https://lostpokecenter.com)'
CARDS = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'
GAME = 'yugioh'


def get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def plan(cards, have):
    """[(image id, source url)] for every picture not stored yet, each id once."""
    out, seen = [], set()
    for c in cards:
        for im in c.get('card_images') or []:
            i, url = im.get('id'), im.get('image_url')
            if not i or not url or i in seen:
                continue
            seen.add(i)
            if f'{i}.jpg' not in have:
                out.append((i, url))
    return out


def stored(base, token):
    have, cursor = set(), None
    while True:
        q = f'{base}/img/list?game={GAME}' + (f'&cursor={cursor}' if cursor else '')
        j = json.loads(get(q, {'x-import-token': token}))
        have.update(j['names'])
        cursor = j.get('cursor')
        if not cursor:
            return have


def upload(base, token, name, data):
    req = urllib.request.Request(f'{base}/img/{GAME}/{name}', data=data, method='PUT', headers={'User-Agent': UA, 'x-import-token': token, 'content-type': 'image/jpeg'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status == 200


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    base, token = os.environ.get('IMPORT_URL', '').rstrip('/'), os.environ.get('IMPORT_TOKEN', '')
    if not base or not token:
        sys.exit('Set IMPORT_URL and IMPORT_TOKEN first.')
    have = stored(base, token)
    cards = json.loads(get(CARDS, timeout=180))['data']
    todo = plan(cards, have)
    print(f'{len(have)} pictures stored, {len(todo)} to fetch.', flush=True)
    if a.dry_run:
        return
    done = fails = 0
    for n, (i, url) in enumerate(todo, 1):
        if a.limit and done >= a.limit:
            break
        try:
            data = get(url)
            if len(data) < 1000:
                raise ValueError('picture too small')
            upload(base, token, f'{i}.jpg', data)
            done += 1
            fails = 0
        except Exception as e:  # one bad picture must not stop the run
            fails += 1
            print(f'skip {i}: {type(e).__name__}', flush=True)
            if fails >= 10:
                sys.exit('10 failures in a row: stopping.')
        if n % 200 == 0:
            print(f'{n}/{len(todo)}', flush=True)
        time.sleep(0.25)
    print(f'Uploaded {done} pictures.', flush=True)


if __name__ == '__main__':
    main()
