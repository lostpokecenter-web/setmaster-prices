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
