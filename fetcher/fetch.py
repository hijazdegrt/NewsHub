"""Fetch every source in config/sources.yaml and write site/data/news.json.

Run locally:   python fetcher/fetch.py
In GitHub Actions the previous news.json is read from the live site (PREV_URL)
so the hub keeps a few days of history even though each feed only lists its
latest items.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import parse_qsl, quote_plus, urlencode, urlsplit, urlunsplit

import feedparser
import httpx
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
OUT = ROOT / "site" / "data" / "news.json"

IST = timezone(timedelta(hours=5, minutes=30))
KEEP_DAYS = 7
MAX_ITEMS = 2500
SUMMARY_LEN = 220
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

# ---------------------------------------------------------------- tagging rules

EVENT_RULES: list[tuple[str, re.Pattern]] = [
    (tag, re.compile(rx, re.I))
    for tag, rx in [
        ("Results", r"\b(q[1-4]|quarterly|financial|half[- ]yearly) results?\b|\bearnings\b|\bprofit (rises|falls|jumps|drops|up|down)\b"),
        ("Board meeting", r"\b(outcome of )?board meeting\b"),
        ("Order win", r"\b(bags?|wins?|won|secures?|secured|receives?|received|bagged|bagging|bag)\b.{0,60}\b(orders?|contracts?)\b|\border (win|inflow|book)\b"),
        ("Block deal", r"\b(block|bulk) deals?\b"),
        ("Dividend", r"\bdividends?\b"),
        ("Buyback", r"\bbuy-?backs?\b"),
        ("Bonus / split", r"\bbonus (issue|shares?)\b|\bstock split\b|\bsub-?division\b"),
        ("Pledge", r"\bpledge[ds]?\b|\bencumbrance\b"),
        ("Fundraise", r"\bqip\b|\brights issue\b|\bpreferential (issue|allotment)\b|\bncds?\b|\bfund ?rais"),
        ("M&A", r"\bacquisition\b|\bacquires?\b|\bmerger\b|\bamalgamation\b|\bstake (sale|buy|in)\b|\bdemerger\b"),
        ("Management", r"\bresign(s|ed|ation)?\b|\bappoint(s|ed|ment)?\b|\bchange in (management|directors?|kmp)\b"),
        ("Insider", r"\binsider trading\b|\bsast\b"),
        ("Broker call", r"\btarget (price )?(of )?(rs|₹)\b|\b(buy|sell|accumulate|reduce|neutral)\b.{0,40}\btarget\b|\b(upgrade|downgrade)s?\b"),
        ("IPO", r"\bipos?\b|\blisting (day|gains?)\b|\bgmp\b"),
        ("RBI policy", r"\brepo rate\b|\bmonetary policy\b|\bmpc\b|\bcrr\b"),
        ("FII/DII", r"\bf[ip]is?\b|\bdiis?\b|\bforeign (fund|portfolio|institutional|investors?)\b"),
        ("Rates / Fed", r"\bfed(eral reserve)?\b|\brate (cut|hike)s?\b|\btreasury yields?\b|\binflation\b|\bcpi\b"),
        ("Crude", r"\bcrude\b|\bbrent\b|\boil prices?\b"),
    ]
]

# Filings that are almost never market moving. They are kept but hidden by default.
ROUTINE = re.compile(
    r"trading window|loss of share certificate|duplicate share|newspaper publication|"
    r"regulation 74\(5\)|74 ?\(5\)|compliance certificate|investor complaints|"
    r"copy of newspaper|closure of trading|certificate under reg|"
    r"analysts?/institutional investor meet|schedule of analyst|"
    r"general updates?$|updates?$|^.{0,60}: (clarification|news verification)",
    re.I,
)
# Daily RBI and SEBI releases that are rarely news.
ROUTINE_REGULATOR = re.compile(
    r"money market operations|auction (result|of)|weekly statistical supplement|reference rate|"
    r"treasury bills?|state government securities|variable rate (repo|reverse repo)|"
    r"lending rates? of|directions under section 35a|imposes monetary penalty|cancels? (the )?certificate",
    re.I,
)

# ---------------------------------------------------------------- helpers

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean(text: str | None) -> str:
    text = html.unescape(TAG_RE.sub(" ", text or ""))
    return WS_RE.sub(" ", text).strip()


def short(text: str, n: int = SUMMARY_LEN) -> str:
    return text if len(text) <= n else text[: n - 1].rsplit(" ", 1)[0] + "…"


def canon_link(url: str) -> str:
    """Drop tracking parameters so the same article from two feeds matches."""
    try:
        parts = urlsplit(url.strip())
        q = [(k, v) for k, v in parse_qsl(parts.query) if not k.lower().startswith(("utm_", "fbclid", "gclid", "from", "ref"))]
        return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path.rstrip("/"), urlencode(q), ""))
    except ValueError:
        return url.strip()


def item_id(link: str, title: str) -> str:
    return hashlib.sha1((canon_link(link) or title).encode()).hexdigest()[:12]


def parse_time(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        st = entry.get(key)
        if st:
            return datetime(*st[:6], tzinfo=timezone.utc)  # feedparser gives UTC
    raw = entry.get("published") or entry.get("updated") or ""
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d %b %Y %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw.strip(), fmt).replace(tzinfo=IST).astimezone(timezone.utc)
        except ValueError:
            pass
    try:
        dt = parsedate_to_datetime(raw)
        return (dt if dt.tzinfo else dt.replace(tzinfo=IST)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def words(title: str) -> frozenset[str]:
    return frozenset(w for w in re.findall(r"[a-z0-9₹]+", title.lower()) if len(w) > 2)


# ---------------------------------------------------------------- fetching


def source_url(src: dict) -> str:
    kind = src.get("type", "rss")
    if kind == "gnews":
        return f"https://news.google.com/rss/search?q={quote_plus(src['query'])}&hl=en-IN&gl=IN&ceid=IN:en"
    if kind == "youtube":
        return f"https://www.youtube.com/feeds/videos.xml?channel_id={src['channel']}"
    return src["url"]


def fetch_source(client: httpx.Client, src: dict) -> tuple[list[dict], dict]:
    url = source_url(src)
    status = {"id": src["id"], "name": src["name"], "category": src["category"], "optional": bool(src.get("optional"))}
    last_err = ""
    for attempt in range(2):
        try:
            r = client.get(url)
            if r.status_code != 200:
                last_err = f"HTTP {r.status_code}"
            else:
                feed = feedparser.parse(r.content)
                if not feed.entries:
                    last_err = "no items"
                else:
                    items = [i for i in (to_item(src, e) for e in feed.entries) if i]
                    status.update(ok=True, count=len(items))
                    return items, status
        except httpx.HTTPError as e:
            last_err = type(e).__name__
        if attempt == 0:
            time.sleep(2)
    status.update(ok=False, count=0, error=last_err)
    return [], status


def to_item(src: dict, e) -> dict | None:
    title = clean(e.get("title"))
    link = (e.get("link") or "").strip()
    if not title or not link:
        return None
    summary = clean(e.get("summary") or e.get("description"))
    source_name = src["name"]

    if src.get("type") == "gnews":
        publisher = clean((e.get("source") or {}).get("title"))
        if publisher:
            source_name = publisher
            if title.endswith(" - " + publisher):
                title = title[: -len(publisher) - 3].strip()
        summary = ""  # Google News summaries just repeat the title

    if src["id"].startswith("nse"):
        # "Company Ltd has informed the Exchange regarding ... |SUBJECT: Outcome of Board Meeting"
        m = re.search(r"\|\s*SUBJECT:\s*(.+)$", summary, re.I)
        if m:
            title = f"{title}: {m.group(1).strip()}"
            summary = summary[: m.start()].strip()

    if summary.lower().startswith(title.lower()[:60]):
        summary = ""

    published = parse_time(e)
    return {
        "id": item_id(link, title),
        "title": title,
        "link": link,
        "source": source_name,
        "source_id": src["id"],
        "category": src["category"],
        "official": src.get("type", "rss") == "rss" and src["category"] in ("filings", "regulators"),
        "time": iso(published) if published else None,
        "summary": short(summary),
    }


def fetch_snapshot(client: httpx.Client, symbols: list[dict]) -> list[dict]:
    out = []
    for s in symbols:
        try:
            r = client.get(
                f"https://query1.finance.yahoo.com/v8/finance/chart/{quote_plus(s['symbol'])}",
                params={"range": "5d", "interval": "1d"},
            )
            meta = r.json()["chart"]["result"][0]["meta"]
            price = meta.get("regularMarketPrice")
            prev = meta.get("previousClose") or meta.get("chartPreviousClose")
            change = round((price - prev) / prev * 100, 2) if price and prev else None
            t = meta.get("regularMarketTime")
            out.append({
                "label": s["label"],
                "price": price,
                "change_pct": change,
                "as_of": iso(datetime.fromtimestamp(t, tz=timezone.utc)) if t else None,
            })
        except Exception as e:  # noqa: BLE001 - one bad symbol shouldn't stop the run
            print(f"  snapshot {s['symbol']}: {type(e).__name__}", file=sys.stderr)
    return out


def load_previous(client: httpx.Client) -> dict:
    """The last published news.json (items plus FII/DII history), or {} on the first run."""
    prev_url = os.environ.get("PREV_URL")
    try:
        if prev_url:
            r = client.get(prev_url)
            if r.status_code == 200:
                return r.json()
            print(f"  previous data: HTTP {r.status_code} (first run?)")
        elif OUT.exists():
            return json.loads(OUT.read_text(encoding="utf-8"))
    except (httpx.HTTPError, ValueError) as e:
        print(f"  previous data unavailable: {type(e).__name__}")
    return {}


# ---------------------------------------------------------------- FII / DII
# NSE publishes provisional cash-market FII/FPI and DII figures (in Rs crore)
# every trading evening. The endpoint only returns the latest day, so each run
# adds that day to the history carried over in news.json.

FII_DII_URL = "https://www.nseindia.com/api/fiidiiTradeReact"
FII_DII_KEEP_DAYS = 120


def _num(v) -> float | None:
    try:
        return round(float(str(v).replace(",", "")), 2)
    except (TypeError, ValueError):
        return None


def fetch_fii_dii(client: httpx.Client) -> tuple[dict | None, dict]:
    status = {"id": "nse-fii-dii", "name": "NSE FII/DII", "category": "data", "optional": False}
    try:
        r = client.get(FII_DII_URL, headers={"Accept": "application/json", "Referer": "https://www.nseindia.com/reports/fii-dii"})
        if r.status_code != 200:
            status.update(ok=False, count=0, error=f"HTTP {r.status_code}")
            return None, status
        row: dict = {}
        for rec in r.json():
            key = "fii" if "FII" in rec.get("category", "").upper() else "dii" if "DII" in rec.get("category", "").upper() else None
            if not key:
                continue
            row["date"] = datetime.strptime(rec["date"], "%d-%b-%Y").strftime("%Y-%m-%d")
            row[key] = {"buy": _num(rec.get("buyValue")), "sell": _num(rec.get("sellValue")), "net": _num(rec.get("netValue"))}
        if "date" not in row:
            status.update(ok=False, count=0, error="unexpected format")
            return None, status
        status.update(ok=True, count=1)
        return row, status
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        status.update(ok=False, count=0, error=type(e).__name__)
        return None, status


def merge_fii_dii(previous: list[dict], latest: dict | None, now: datetime) -> list[dict]:
    by_date = {r["date"]: r for r in previous if r.get("date")}
    if latest:
        by_date[latest["date"]] = latest
    cutoff = (now - timedelta(days=FII_DII_KEEP_DAYS)).strftime("%Y-%m-%d")
    return sorted((r for d, r in by_date.items() if d >= cutoff), key=lambda r: r["date"], reverse=True)


# ---------------------------------------------------------------- processing


def compile_watchlist(stocks: list[dict]) -> list[tuple[str, re.Pattern]]:
    out = []
    for s in stocks or []:
        terms = [re.escape(t) for t in s.get("match") or [s["name"]]]
        out.append((s["name"], re.compile(r"(?<![\w&])(" + "|".join(terms) + r")(?![\w&])", re.I)))
    return out


def tag(item: dict, watch: list[tuple[str, re.Pattern]]) -> None:
    text = f"{item['title']} {item.get('summary', '')}"
    item["stocks"] = [name for name, rx in watch if rx.search(text)]
    item["tags"] = [t for t, rx in EVENT_RULES if rx.search(text)]
    routine = (item["category"] == "filings" and bool(ROUTINE.search(item["title"]))) or (
        item["category"] == "regulators" and bool(ROUTINE_REGULATOR.search(item["title"]))
    )
    item["routine"] = routine

    if routine:
        p = -1
    elif (item["category"] == "regulators" and item.get("official")) or "RBI policy" in item["tags"]:
        p = 2  # straight from RBI (news coverage of regulators stays in its category at normal priority)
    elif item["stocks"] and (item["category"] == "filings" or item["tags"]):
        p = 2
    elif item["stocks"]:
        p = 1
    elif item["category"] == "filings" and set(item["tags"]) & {"Results", "Order win", "Block deal", "Buyback", "M&A", "Pledge", "Fundraise"}:
        p = 1
    else:
        p = 0
    item["priority"] = p


def merge(previous: list[dict], fresh: list[dict], now: datetime) -> list[dict]:
    by_id: dict[str, dict] = {}
    for it in previous:
        if it.get("id"):
            by_id[it["id"]] = it
    for it in fresh:
        old = by_id.get(it["id"])
        it["first_seen"] = (old or {}).get("first_seen") or iso(now)
        if not it["time"]:
            it["time"] = (old or {}).get("time") or it["first_seen"]
        if old and old.get("also"):
            it["also"] = old["also"]
        by_id[it["id"]] = it

    cutoff = now - timedelta(days=KEEP_DAYS)
    future = now + timedelta(hours=1)
    items = []
    for it in by_id.values():
        try:
            t = datetime.strptime(it["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        if t > future:  # badly dated items would stick to the top forever
            t = now
            it["time"] = iso(now)
        if t >= cutoff:
            items.append(it)
    items.sort(key=lambda i: i["time"], reverse=True)
    return dedupe(items)[:MAX_ITEMS]


def dedupe(items: list[dict]) -> list[dict]:
    """Fold near-identical headlines (same story on several sites) into one item."""
    kept: list[dict] = []
    recent: list[tuple[frozenset[str], dict]] = []
    for it in items:  # newest first
        if it["category"] == "filings":
            kept.append(it)
            continue
        w = words(it["title"])
        dup = None
        if len(w) >= 4:
            for w2, other in recent:
                inter = len(w & w2)
                if inter and inter / len(w | w2) >= 0.7:
                    dup = other
                    break
        if dup:
            also = dup.setdefault("also", [])
            if it["source"] != dup["source"] and not any(a["source"] == it["source"] for a in also):
                also.append({"source": it["source"], "link": it["link"]})
            continue
        kept.append(it)
        recent.append((w, it))
        if len(recent) > 600:
            recent.pop(0)
    return kept


# ---------------------------------------------------------------- main


def main() -> int:
    cfg = yaml.safe_load((CONFIG / "sources.yaml").read_text(encoding="utf-8"))
    wl = yaml.safe_load((CONFIG / "watchlist.yaml").read_text(encoding="utf-8")) or {}
    watch = compile_watchlist(wl.get("stocks"))
    now = datetime.now(timezone.utc)

    with httpx.Client(headers={"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9"}, follow_redirects=True, timeout=25) as client:
        prev = load_previous(client)
        known = {src["id"] for src in cfg["sources"]}
        previous = [it for it in prev.get("items", []) if it.get("source_id") in known]  # drops removed sources
        fii_latest, fii_status = fetch_fii_dii(client)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda s: fetch_source(client, s), cfg["sources"]))
        snapshot = fetch_snapshot(client, cfg.get("snapshot", []))

    fresh = [it for items, _ in results for it in items]
    statuses = [st for _, st in results] + [fii_status]
    fii_dii = merge_fii_dii(prev.get("fii_dii", []), fii_latest, now)
    for st in statuses:
        mark = "ok " if st["ok"] else ("-- " if st["optional"] else "ERR")
        print(f"  {mark} {st['id']:28} {st.get('count', 0):4} {st.get('error', '')}")

    items = merge(previous, fresh, now)
    for it in items:
        tag(it, watch)

    if not fresh and not previous:
        print("Every source failed and there is no previous data. Not writing news.json.", file=sys.stderr)
        return 1

    for st in statuses:
        st["checked"] = iso(now)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": iso(now),
        "watchlist": [name for name, _ in watch],
        "snapshot": snapshot,
        "fii_dii": fii_dii,
        "links": cfg.get("links", []),
        "sources": statuses,
        "items": items,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(items)} items ({len(fresh)} fetched now, {len(previous)} carried over) to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
