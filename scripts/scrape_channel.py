#!/usr/bin/env python3
"""
scrape_channel.py — v6
- Парсит мета-данные канала (подписчики, аватар) → data/channel.json
- Видео: сохраняет thumbnail + post_url (для ссылки «Смотреть в Telegram»)
- Документы: url = ссылка на пост (для открытия в Telegram)
- HTML-форматирование сохраняется
- --pages N для ретроспективы, --fresh для перезапуска
"""

import argparse
import json
import re
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup, NavigableString, Tag

CHANNEL = "celebasport"
OUTPUT_POSTS   = Path(__file__).resolve().parent.parent / "data" / "posts.json"
OUTPUT_CHANNEL = Path(__file__).resolve().parent.parent / "data" / "channel.json"
DEFAULT_PAGES  = 5
DELAY          = 1.5

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
}

ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "s", "del", "a", "code", "pre", "br", "blockquote"}


def fetch_channel_meta(channel: str) -> dict:
    url = f"https://t.me/{channel}"
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    meta = {"username": channel, "title": "", "description": "", "subscribers": 0, "subscribers_text": "", "avatar_url": ""}
    title_el = soup.select_one(".tgme_page_title span")
    if title_el:
        meta["title"] = title_el.get_text().strip()
    desc_el = soup.select_one(".tgme_page_description")
    if desc_el:
        meta["description"] = desc_el.get_text().strip()
    extra_el = soup.select_one(".tgme_page_extra")
    if extra_el:
        text = extra_el.get_text().strip()
        meta["subscribers_text"] = text
        nums = re.sub(r"[^\d]", "", text.split("sub")[0].split("member")[0])
        if nums:
            meta["subscribers"] = int(nums)
    img_el = soup.select_one(".tgme_page_photo_image img")
    if img_el:
        src = img_el.get("src", "")
        if src.startswith("//"):
            src = "https:" + src
        meta["avatar_url"] = src
    return meta


def fetch_page(channel: str, before=None) -> str:
    url = f"https://t.me/s/{channel}"
    params = {"before": before} if before else {}
    r = requests.get(url, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


def sanitize_html(element) -> str:
    if element is None:
        return ""
    parts = []
    for child in element.children:
        if isinstance(child, NavigableString):
            text = str(child).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            parts.append(text)
        elif isinstance(child, Tag):
            tn = child.name.lower()
            if tn == "br":
                parts.append("<br>")
            elif tn in ALLOWED_TAGS:
                attrs = ""
                if tn == "a":
                    href = child.get("href", "")
                    if href:
                        if href.startswith("//"):
                            href = "https:" + href
                        elif href.startswith("/"):
                            href = "https://t.me" + href
                        attrs = f' href="{href.replace(chr(34), "&quot;")}" target="_blank" rel="noopener"'
                parts.append(f"<{tn}{attrs}>{sanitize_html(child)}</{tn}>")
            else:
                parts.append(sanitize_html(child))
    return "".join(parts)


def html_to_plain(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    return soup.get_text().strip()


def parse_views(text: str):
    t = text.strip().upper()
    if not t:
        return None
    try:
        if t.endswith("K"): return int(float(t[:-1]) * 1000)
        if t.endswith("M"): return int(float(t[:-1]) * 1000000)
        return int(t)
    except ValueError:
        return None


def extract_bg_url(style: str):
    m = re.search(r"url\(['\"]?(.*?)['\"]?\)", style)
    if not m:
        return None
    url = m.group(1)
    if url.startswith("//"):
        url = "https:" + url
    return url


def parse_posts(html: str, channel: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    posts = []
    for msg in soup.select(".tgme_widget_message"):
        try:
            dp = msg.get("data-post", "")
            if "/" not in dp:
                continue
            pid = int(dp.split("/")[-1])
            post_url = f"https://t.me/{channel}/{pid}"

            text_el = msg.select_one(".tgme_widget_message_text")
            hc, pt = "", ""
            if text_el:
                hc = sanitize_html(text_el)
                pt = html_to_plain(hc)

            date_el = msg.select_one("time[datetime]")
            date_str = date_el["datetime"] if date_el else ""
            views_el = msg.select_one(".tgme_widget_message_views")
            views = parse_views(views_el.text) if views_el else None
            fwd_el = msg.select_one(".tgme_widget_message_forwards")
            forwards = parse_views(fwd_el.text) if fwd_el else None

            media = []

            # Фото
            for pw in msg.select(".tgme_widget_message_photo_wrap"):
                u = extract_bg_url(pw.get("style", ""))
                if u:
                    media.append({"type": "photo", "url": u})

            # Видео
            for vw in msg.select(".tgme_widget_message_video_wrap"):
                thumb = ""
                th = vw.select_one(".tgme_widget_message_video_thumb")
                if th:
                    thumb = extract_bg_url(th.get("style", "")) or ""
                if not thumb:
                    thumb = extract_bg_url(vw.get("style", "")) or ""
                dur_el = vw.select_one(".message_video_duration")
                duration = None
                if dur_el:
                    pp = dur_el.text.strip().split(":")
                    try:
                        if len(pp) == 2: duration = int(pp[0])*60+int(pp[1])
                        elif len(pp) == 3: duration = int(pp[0])*3600+int(pp[1])*60+int(pp[2])
                    except ValueError:
                        pass
                media.append({"type": "video", "thumbnail": thumb, "duration": duration, "post_url": post_url})

            # Документы — ссылка ведёт на пост в Telegram
            for dw in msg.select(".tgme_widget_message_document_wrap"):
                te = dw.select_one(".tgme_widget_message_document_title")
                ee = dw.select_one(".tgme_widget_message_document_extra")
                fn = te.text.strip() if te else "Файл"
                st = ee.text.strip() if ee else ""
                sb = None
                if st:
                    m2 = re.match(r"([\d.]+)\s*(KB|MB|GB|KБ|МБ|ГБ)", st, re.I)
                    if m2:
                        v = float(m2.group(1))
                        u = m2.group(2).upper()
                        if u in ("KB","KБ"): sb=int(v*1024)
                        elif u in ("MB","МБ"): sb=int(v*1048576)
                        elif u in ("GB","ГБ"): sb=int(v*1073741824)
                media.append({"type": "document", "url": post_url, "filename": fn, "size": sb})

            # Кружочки
            for rw in msg.select(".tgme_widget_message_roundvideo"):
                t2 = extract_bg_url(rw.get("style","")) or ""
                media.append({"type": "video", "thumbnail": t2, "duration": None, "post_url": post_url})

            # Стикеры
            for si in msg.select(".tgme_widget_message_sticker_wrap img"):
                src = si.get("data-src") or si.get("src","")
                if src:
                    if src.startswith("//"): src = "https:" + src
                    media.append({"type": "photo", "url": src})

            # Link preview
            if not media:
                for lp in msg.select(".link_preview_image"):
                    u = extract_bg_url(lp.get("style",""))
                    if u:
                        media.append({"type": "photo", "url": u})

            posts.append({"id": pid, "date": date_str, "text": pt, "html": hc,
                          "media": media, "views": views, "forwards": forwards, "url": post_url})
        except Exception as e:
            print(f"⚠️ {dp}: {e}")
            continue
    return posts


def scrape(channel, max_pages):
    all_posts, seen, before = [], set(), None
    for page in range(max_pages):
        print(f"📥 {page+1}/{max_pages}...")
        try:
            html = fetch_page(channel, before)
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                print("   ⏳ 429, жду 30 сек...")
                time.sleep(30)
                try: html = fetch_page(channel, before)
                except: print("   ❌ Стоп."); break
            else: raise
        posts = parse_posts(html, channel)
        if not posts: print("   Конец."); break
        new = [p for p in posts if p["id"] not in seen]
        if not new: break
        for p in new: seen.add(p["id"])
        all_posts.extend(new)
        before = min(p["id"] for p in new)
        print(f"   +{len(new)} (всего {len(all_posts)})")
        if page < max_pages-1: time.sleep(DELAY)
    all_posts.sort(key=lambda p: p["id"], reverse=True)
    return all_posts


def merge(new_posts, path):
    existing = []
    if path.exists():
        try: existing = json.loads(path.read_text("utf-8"))
        except: existing = []
    mm = {p["id"]: p for p in existing}
    added = 0
    for p in new_posts:
        if p["id"] not in mm:
            mm[p["id"]] = p; added += 1
        else:
            o = mm[p["id"]]
            if p.get("views"): o["views"] = p["views"]
            if p.get("forwards"): o["forwards"] = p["forwards"]
            if p.get("html") and not o.get("html"): o["html"] = p["html"]
            if p.get("media") and not o.get("media"): o["media"] = p["media"]
            # Обновляем media если в старых постах нет post_url у видео
            if p.get("media"):
                for nm in p["media"]:
                    if nm.get("type") == "video" and nm.get("post_url"):
                        for om in (o.get("media") or []):
                            if om.get("type") == "video" and not om.get("post_url"):
                                om["post_url"] = nm["post_url"]
                    if nm.get("type") == "document" and nm.get("url") and nm["url"] != "#":
                        for om in (o.get("media") or []):
                            if om.get("type") == "document" and (not om.get("url") or om["url"] == "#"):
                                om["url"] = nm["url"]
    merged = sorted(mm.values(), key=lambda p: p["id"], reverse=True)
    print(f"✅ Новых: {added} | Всего: {len(merged)}")
    return merged


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", type=int, default=DEFAULT_PAGES)
    parser.add_argument("--fresh", action="store_true")
    args = parser.parse_args()
    if args.fresh and OUTPUT_POSTS.exists():
        OUTPUT_POSTS.unlink(); print("🗑️ Удалён posts.json")

    print(f"📡 Мета @{CHANNEL}...")
    try:
        meta = fetch_channel_meta(CHANNEL)
        OUTPUT_CHANNEL.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_CHANNEL.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
        print(f"   {meta['title']}: {meta['subscribers']:,} подп.")
    except Exception as e:
        print(f"⚠️ Мета: {e}")

    print(f"🔍 Посты ({args.pages} стр.)...")
    posts = scrape(CHANNEL, args.pages)
    if not posts: print("❌ Нет постов."); return
    OUTPUT_POSTS.parent.mkdir(parents=True, exist_ok=True)
    merged = merge(posts, OUTPUT_POSTS)
    OUTPUT_POSTS.write_text(json.dumps(merged, ensure_ascii=False, indent=2), "utf-8")
    print(f"💾 → {OUTPUT_POSTS}")


if __name__ == "__main__":
    main()
