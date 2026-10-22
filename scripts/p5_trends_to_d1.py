#!/usr/bin/env python3
"""Produce parameter-escaped Cloudflare D1 SQL for public Taiwan Google Trends RSS.

The output is discovery-only. It must not generate social_actions, publish posts,
inject arbitrary source HTML, or expose Cloudflare credentials.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import pathlib
import re
import sqlite3
import xml.etree.ElementTree as ET

UTC = dt.timezone.utc
LOCAL = dt.timezone(dt.timedelta(hours=8))
SOURCE = "https://trends.google.com/trending?geo=TW&hl=zh-TW"
NS = {"ht": "https://trends.google.com/trending/rss"}
HIGH_RISK = re.compile(
    r"(死亡|車禍|火災|地震|殺人|事故|性侵|性騷|貪污|爆料|指控|詐騙|恐嚇|自殺|戰爭|軍事|裸照|私密影像)",
    re.I,
)


def sql_string(value: str | None) -> str:
    if value is None:
        return "NULL"
    # sqlite's own quote() safely escapes embedded quotes and SQL metacharacters.
    con = sqlite3.connect(":memory:")
    try:
        return con.execute("SELECT quote(?)", (str(value),)).fetchone()[0]
    finally:
        con.close()


def lower_bound(label: str) -> int:
    value = re.sub(r"[,\s]", "", label.upper())
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([KMB萬億])?\+?", value)
    if not m:
        return 0
    return int(float(m.group(1)) * {
        None: 1, "K": 1000, "M": 1000000, "B": 1000000000,
        "萬": 10000, "億": 100000000
    }[m.group(2)])


def parse_rss(content: bytes, now: dt.datetime) -> list[dict]:
    root = ET.fromstring(content)
    if root.tag != "rss":
        raise ValueError("RSS root is not rss")
    seen: set[str] = set()
    output = []
    for item in root.findall("./channel/item")[:80]:
        keyword = (item.findtext("title") or "").strip()
        date = (item.findtext("pubDate") or "").strip()
        try:
            published_at = dt.datetime.strptime(date, "%a, %d %b %Y %H:%M:%S %z").astimezone(UTC)
        except ValueError:
            continue
        if not 2 <= len(keyword) <= 100 or keyword in seen:
            continue
        age = (now - published_at).total_seconds()
        if age < -300 or age > 48 * 3600:
            continue
        seen.add(keyword)
        volume = (item.findtext("ht:approx_traffic", default="", namespaces=NS) or "").strip()
        output.append({
            "keyword": keyword,
            "published": published_at.isoformat().replace("+00:00", "Z"),
            "volume": volume or None,
            "lower": lower_bound(volume),
            "moderation": "high_risk_review" if HIGH_RISK.search(keyword) else "unreviewed",
            "category": (
                "puppetry" if re.search("布袋戲|霹靂|偶戲", keyword)
                else "sports" if re.search("棒球|籃球|賽事|球員", keyword)
                else "entertainment" if re.search("演唱會|歌手|電影|演員|戲劇", keyword)
                else "unsorted"
            ),
        })
    return sorted(output, key=lambda a: a["lower"], reverse=True)[:45]


def generate_sql(content: bytes, now: dt.datetime) -> tuple[str, int]:
    items = parse_rss(content, now)
    time = now.isoformat().replace("+00:00", "Z")
    slot = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)
    slottext = slot.isoformat().replace("+00:00", "Z")
    sql = ["-- Google Trends TW first-party search signals; zero publication side effects.",
           "BEGIN TRANSACTION;"]
    for item in items:
        keyword = item["keyword"]
        uid = "gtrend-" + hashlib.sha256(("TW:" + keyword.lower()).encode("utf-8")).hexdigest()[:40]
        q = sql_string
        sql.append(
            "INSERT OR IGNORE INTO p5_search_trends "
            "(trend_id,keyword,region,source_url,first_seen_at,last_seen_at,"
            "published_at,traffic_label,traffic_lower_bound,category_hint,moderation,status) VALUES ("
            f"{q(uid)},{q(keyword)},'TW',{q(SOURCE)},{q(time)},{q(time)},"
            f"{q(item['published'])},{q(item['volume'])},{item['lower']},"
            f"{q(item['category'])},{q(item['moderation'])},'discovered');"
        )
        sql.append(
            "UPDATE p5_search_trends SET "
            f"last_seen_at={q(time)},traffic_label={q(item['volume'])},"
            f"traffic_lower_bound={item['lower']} WHERE trend_id={q(uid)};"
        )
    q = sql_string
    sql.append(
        "INSERT INTO p5_trend_radar_runs "
        "(slot,status,scanned,newly_detected,error,started_at,finished_at) VALUES ("
        f"{q(slottext)},'done',{len(items)},"
        f"(SELECT COUNT(*) FROM p5_search_trends WHERE first_seen_at={q(time)}),NULL,"
        f"{q(time)},{q(time)}) "
        "ON CONFLICT(slot) DO UPDATE SET status=excluded.status,scanned=excluded.scanned,"
        "newly_detected=excluded.newly_detected,error=NULL,finished_at=excluded.finished_at;"
    )
    cutoff = (now - dt.timedelta(days=30)).isoformat().replace("+00:00", "Z")
    sql.append(f"DELETE FROM p5_search_trends WHERE last_seen_at<{q(cutoff)};")
    sql.extend(["COMMIT;", ""])
    return "\n".join(sql), len(items)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--rss", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()
    now = dt.datetime.now(UTC)
    text, count = generate_sql(pathlib.Path(args.rss).read_bytes(), now)
    pathlib.Path(args.output).write_text(text, encoding="utf-8")
    print(f"TAIWAN_TRENDS_SOURCE_ITEMS={count} SQL_BYTES={len(text.encode('utf-8'))}")
    print("NO_SOCIAL_PUBLISHING=True")


if __name__ == "__main__":
    main()
