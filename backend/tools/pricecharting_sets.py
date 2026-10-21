#!/usr/bin/env python3
"""
Downloads PriceCharting's set-level price CSVs (the "Download price list" button on a set page) for chosen card games.

Why this exists: the big all-in-one CSVs cover Pokemon, Magic, Yu-Gi-Oh! and One Piece, but Lorcana and Digimon are only offered
one set at a time. This visits each set of those categories once a day and saves its CSV.

Needs a Legendary subscription. Run it only for your own account, slowly, once a day.

SETUP (Termux or Linux):
  pip install requests beautifulsoup4
  Put your secrets in a file named .env next to this script (never share it, never paste it in chat):
      PRICECHARTING_COOKIE=...      # the Cookie header of your logged-in browser session   (option A)
      PRICECHARTING_TOKEN=...       # your API token, if the download link takes ?t=TOKEN    (option B)
      DOWNLOAD_URL_TEMPLATE=...     # optional, once known, e.g. https://www.pricecharting.com/....{slug}....&t={token}

RUN:
  python pricecharting_sets.py --probe            # check ONE set: shows the download link it found (secrets hidden)
  python pricecharting_sets.py                    # download every set of the categories below
  python pricecharting_sets.py --categories lorcana-cards digimon-cards --limit 3

Note: a category page shows its "popular" sets; PriceCharting's Quick Jump may know a few more. Check the count in the log against the site.

Files go to ./downloads/<game>/<set>_<YYYY-MM-DD>.csv and everything is logged to download_log.txt.
"""
import argparse, datetime, os, random, re, sys, time
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qsl, urlencode, urlunparse

import requests
from bs4 import BeautifulSoup

BASE = 'https://www.pricecharting.com'
# What to download: PriceCharting category page -> the SetMaster game it feeds, and which sets of that page to keep (by /console/ slug prefix).
# (Pokemon, Magic, Yu-Gi-Oh! and One Piece come from the big all-in-one CSVs, so they are not listed here.)
TARGETS = {
    'lorcana-cards':     {'game': 'lorcana',    'prefixes': ['lorcana-']},
    'digimon-cards':     {'game': 'digimon',    'prefixes': ['digimon-']},
    'dragon-ball-cards': {'game': 'dragonball', 'prefixes': ['dragon-ball-']},
    'star-wars-cards':   {'game': 'swu',        'prefixes': ['star-wars-unlimited-']},
    'other-tcg-cards':   {'game': 'other',      'prefixes': ['riftbound-', 'gundam-']},   # Riftbound and Gundam live on this page
}
DEFAULT_CATEGORIES = list(TARGETS)
OUT = Path(__file__).parent / 'downloads'
LOG = Path(__file__).parent / 'download_log.txt'
UA = 'SetMaster price-sync (contact: support@lostpokecenter.com)'
CSV_HEAD = 'id,console-name,product-name'


def load_env():
    f = Path(__file__).parent / '.env'
    if f.exists():
        for line in f.read_text().splitlines():
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def log(msg):
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')}  {msg}"
    print(line)
    with LOG.open('a', encoding='utf-8') as fh:
        fh.write(line + '\n')


def hide(url):
    """The address with every query value hidden, so tokens never reach the log."""
    p = urlparse(url)
    return urlunparse(p._replace(query=urlencode([(k, 'XXXX') for k, _ in parse_qsl(p.query)])))


def session():
    s = requests.Session()
    s.headers['User-Agent'] = UA
    cookie = os.environ.get('PRICECHARTING_COOKIE')
    if cookie:
        s.headers['Cookie'] = cookie
    return s


def pause():
    time.sleep(random.uniform(2.0, 5.0))


def discover_sets(s, category):
    """Set pages of a category (public page, no login): /console/<slug>."""
    r = s.get(f'{BASE}/category/{category}', timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, 'html.parser')
    found = {}
    for a in soup.find_all('a', href=True):
        m = re.match(r'^(?:https://www\.pricecharting\.com)?(/console/[^?#]+)$', a['href'])
        if m:
            found.setdefault(m.group(1), a.get_text(' ', strip=True) or m.group(1).rsplit('/', 1)[-1])
    return found  # path -> name


def find_download_link(soup, page_url):
    """The 'Download price list' link on a set page."""
    for a in soup.find_all('a', href=True):
        text = a.get_text(' ', strip=True).lower()
        href = a['href'].lower()
        if ('download' in text and ('price' in text or 'csv' in text)) or 'csv' in href or 'download' in href:
            return urljoin(page_url, a['href'])
    return None


def with_token(url):
    tok = os.environ.get('PRICECHARTING_TOKEN')
    if tok and 't=' not in url:
        url += ('&' if '?' in url else '?') + 't=' + tok
    return url


def find_uid(html):
    """The set's code (like G98800) from its public page."""
    m = re.search(r'console-uids=([A-Za-z]?\d+)', html)
    if m:
        return m.group(1)
    for pat in (r'data-console-(?:id|uid)=["\']([A-Za-z]?\d+)', r'console[_-]?uid["\']?\s*[:=]\s*["\']([A-Za-z]?\d+)',
                r'["\'=/]([G]\d{4,6})["\'&/?]'):
        m = re.search(pat, html, re.I)
        if m:
            return m.group(1)
    return None


def fetch_set_csv(s, path):
    tok = os.environ.get('PRICECHARTING_TOKEN', '')
    page_url = BASE + path
    r = s.get(page_url, timeout=30)
    r.raise_for_status()
    uid = find_uid(r.text)
    if not uid:
        return None, 'no set code (console-uids) found on the set page'
    time.sleep(random.uniform(8, 14))
    url = f'{BASE}/price-guide/download-custom?t={tok}&console-uids={uid}'
    for attempt in range(6):
        r = s.get(url, timeout=60, headers={'Referer': page_url})
        if r.status_code != 429:
            break
        wait = max(120, int(r.headers.get('Retry-After', '0') or 0) + 5)
        log(f'  429 (too many requests): waiting {wait}s, then trying this set again ({attempt + 1}/5)')
        time.sleep(wait)
    r.raise_for_status()
    body = r.text
    if not body.lstrip('\ufeff').startswith(CSV_HEAD):
        return None, f'the answer was not a CSV (set code {uid}; token wrong or expired?)'
    return (body, hide(url)), None


BIG = {'pokemon': 'pokemon-cards', 'mtg': 'magic-cards', 'yugioh': 'yugioh-cards', 'onepiece': 'one-piece-cards'}


def fetch_big(s, today):
    """Whole-game files (Pokemon, Magic, Yu-Gi-Oh!, One Piece), one call each, 11 minutes apart (PriceCharting allows one per 10).
    The address form is a best guess from the per-set one, so a failure here is reported and does not stop anything else."""
    tok = os.environ.get('PRICECHARTING_TOKEN', '')
    done = 0
    for i, (game, cat) in enumerate(BIG.items()):
        dest = OUT / game / f'{cat}_{today}.csv'
        if dest.exists():
            log(f'skip {cat}: already downloaded today')
            continue
        if done:
            time.sleep(11 * 60)
        for attempt in range(3):
            r = s.get(f'{BASE}/price-guide/download-custom?t={tok}&category={cat}', timeout=300)
            if r.status_code == 429:
                log(f'  429 on {cat}: waiting 11 minutes')
                time.sleep(11 * 60)
                continue
            break
        done += 1
        if r.status_code != 200 or not r.text.lstrip('\ufeff').startswith(CSV_HEAD):
            log(f'FAIL big/{cat}: HTTP {r.status_code}, not a CSV (the whole-game address may differ; send the real link with the token as XXXX)')
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(r.text, encoding='utf-8')
        log(f'OK   big/{cat}: {r.text.count(chr(10))} lines -> {dest.relative_to(Path(__file__).parent)}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--big', action='store_true', help='download the whole-game files (Pokemon, Magic, Yu-Gi-Oh!, One Piece) instead of per-set files')
    ap.add_argument('--categories', nargs='*', default=DEFAULT_CATEGORIES)
    ap.add_argument('--probe', action='store_true', help='check one set and show the download link found')
    ap.add_argument('--limit', type=int, default=0, help='only the first N sets of each category')
    args = ap.parse_args()
    load_env()
    if not (os.environ.get('PRICECHARTING_COOKIE') or os.environ.get('PRICECHARTING_TOKEN')):
        log('STOP: set PRICECHARTING_COOKIE or PRICECHARTING_TOKEN in .env')
        return 2
    tok = os.environ.get('PRICECHARTING_TOKEN', '')
    if tok and not re.fullmatch(r'[A-Za-z0-9]{20,64}', tok):
        log('STOP: the saved token looks wrong (spaces or odd characters). Re-create .env with the token only.')
        return 2
    s = session()
    today = datetime.date.today().isoformat()
    if args.big:
        fetch_big(s, today)
        return 0
    bad_auth = 0
    for cat in args.categories:
        try:
            sets = discover_sets(s, cat)
        except Exception as e:
            log(f'FAIL {cat}: could not list sets ({e})')
            continue
        keep = TARGETS.get(cat, {}).get('prefixes')
        if keep:
            sets = {p: n for p, n in sets.items() if any(p.rsplit('/', 1)[-1].lower().startswith(k) for k in keep)}
        log(f'{cat}: {len(sets)} sets to download')
        items = list(sets.items())[: (1 if args.probe else (args.limit or None))]
        for path, name in items:
            slug = path.rsplit('/', 1)[-1]
            dest = OUT / (TARGETS.get(cat, {}).get('game', cat)) / f'{slug}_{today}.csv'
            if dest.exists() and not args.probe:
                log(f'skip {slug}: already downloaded today')
                continue
            try:
                got, err = fetch_set_csv(s, path)
            except Exception as e:
                msg = str(e)
                for secret in (os.environ.get('PRICECHARTING_TOKEN', ''), os.environ.get('PRICECHARTING_COOKIE', '')):
                    if secret:
                        msg = msg.replace(secret, 'XXXX')
                msg = re.sub(r't=[^&\s]+', 't=XXXX', msg)
                got, err = None, f'error: {msg}'
            if err:
                log(f'FAIL {cat}/{slug}: {err}')
                bad_auth += 'login' in err
                if args.probe:
                    return 1
            else:
                body, shown = got
                if args.probe:
                    log(f'PROBE OK {slug}: download link = {shown}; {body.count(chr(10))} lines; first line: {body.splitlines()[0][:80]}')
                    return 0
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(body, encoding='utf-8')
                log(f'OK   {cat}/{slug}: {body.count(chr(10))} lines -> {dest.relative_to(Path(__file__).parent)}')
            pause()
    if bad_auth:
        log('WARNING: some downloads looked like a login page. Your cookie/token may have expired.')
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
