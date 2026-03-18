#!/usr/bin/env python3
"""
scrape_channel.py — v10
Добавлено:
- --repair : проходит по ВСЕМ постам в posts.json,
  находит битые (обрезанный текст, нет даты, нет медиа)
  и дозагружает каждый через embed-страницу.
  
Использование:
  python scripts/scrape_channel.py                    # обычное обновление
  python scripts/scrape_channel.py --repair           # починить битые посты
  python scripts/scrape_channel.py --repair --all     # перепроверить ВСЕ посты
  python scripts/scrape_channel.py --pages 50         # ретроспектива
  python scripts/scrape_channel.py --fresh --pages 5  # с нуля
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
DELAY_EMBED    = 0.8

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.5",
}

ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "s", "del", "a", "code", "pre", "br", "blockquote"}


# ============================================================
# МЕТА-ДАННЫЕ КАНАЛА
# ============================================================

def fetch_channel_meta(channel: str) -> dict:
    url = f"https://t.me/{channel}"
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    meta = {"username": channel, "title": "", "description": "",
            "subscribers": 0, "subscribers_text": "", "avatar_url": ""}
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


# ============================================================
# УТИЛИТЫ
# ============================================================

def fetch_page(channel: str, before=None) -> str:
    url = f"https://t.me/s/{channel}"
    params = {"before": before} if before else {}
    r = requests.get(url, params=params, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


def fetch_embed(channel: str, post_id: int) -> str:
    """Загружает embed-страницу отдельного поста — полный текст, точная дата."""
    url = f"https://t.me/{channel}/{post_id}?embed=1&mode=tme"
    r = requests.get(url, headers=HEADERS, timeout=30)
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
                # Telegram оборачивает эмодзи в <i class="emoji"> —
                # не нужно делать их курсивом, просто выводим содержимое
                child_classes = child.get("class", [])
                if tn in ("i", "em") and "emoji" in child_classes:
                    parts.append(sanitize_html(child))
                    continue
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


def is_valid_date(date_str: str) -> bool:
    if not date_str or len(date_str) < 10:
        return False
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}", date_str))


def is_truncated(text: str) -> bool:
    if not text:
        return False
    s = text.rstrip()
    return s.endswith("...") or s.endswith("…")


def is_inside_reply(el) -> bool:
    """Проверяет, находится ли элемент внутри блока цитаты (reply)."""
    for parent in el.parents:
        if parent.get("class") and "tgme_widget_message_reply" in parent.get("class", []):
            return True
    return False


def strip_reply(msg):
    """
    Создаёт копию msg БЕЗ reply-блоков.
    Reply-блок (.tgme_widget_message_reply) содержит текст и медиа
    цитируемого поста — их нельзя путать с содержимым самого поста.
    """
    clone = BeautifulSoup(str(msg), "html.parser").select_one(".tgme_widget_message") or BeautifulSoup(str(msg), "html.parser")
    for reply_block in clone.select(".tgme_widget_message_reply"):
        reply_block.decompose()
    return clone


def get_post_text(msg):
    """
    Извлекает текст САМОГО поста, игнорируя текст из reply-цитаты.
    Ищет .tgme_widget_message_text, который НЕ внутри .tgme_widget_message_reply.
    """
    for text_el in msg.select(".tgme_widget_message_text"):
        if not is_inside_reply(text_el):
            return text_el
    return None

def extract_media(msg, post_url: str, channel: str) -> list[dict]:
    """Извлекает медиа, ИСКЛЮЧАЯ содержимое reply-блока."""
    # Работаем с копией без reply-блоков
    clean = strip_reply(msg)
    media = []

    for pw in clean.select(".tgme_widget_message_photo_wrap"):
        u = extract_bg_url(pw.get("style", ""))
        if u:
            media.append({"type": "photo", "url": u})

    for vw in clean.select(".tgme_widget_message_video_wrap"):
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
                if len(pp) == 2: duration = int(pp[0]) * 60 + int(pp[1])
                elif len(pp) == 3: duration = int(pp[0]) * 3600 + int(pp[1]) * 60 + int(pp[2])
            except ValueError:
                pass
        # Прямой URL видеофайла из тега <video>
        video_url = ""
        vid_el = vw.select_one("video")
        if vid_el:
            # src может быть в src или data-src (lazy loading / blurred)
            video_url = vid_el.get("src", "") or vid_el.get("data-src", "")
            if video_url.startswith("//"):
                video_url = "https:" + video_url
            # poster из <video> — надёжнее чем background-image
            poster = vid_el.get("poster", "") or vid_el.get("data-poster", "")
            if poster:
                if poster.startswith("//"):
                    poster = "https:" + poster
                thumb = poster
        media.append({
            "type": "video",
            "url": video_url,
            "thumbnail": thumb,
            "duration": duration,
            "post_url": post_url,
            "video_available": bool(video_url),
        })

    for dw in clean.select(".tgme_widget_message_document_wrap"):
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
                if u in ("KB", "KБ"): sb = int(v * 1024)
                elif u in ("MB", "МБ"): sb = int(v * 1048576)
                elif u in ("GB", "ГБ"): sb = int(v * 1073741824)
        media.append({"type": "document", "url": post_url, "filename": fn, "size": sb})

    for rw in clean.select(".tgme_widget_message_roundvideo"):
        t2 = extract_bg_url(rw.get("style", "")) or ""
        video_url = ""
        vid_el = rw.select_one("video")
        if vid_el:
            video_url = vid_el.get("src", "") or vid_el.get("data-src", "")
            if video_url.startswith("//"):
                video_url = "https:" + video_url
            poster = vid_el.get("poster", "") or vid_el.get("data-poster", "")
            if poster:
                if poster.startswith("//"):
                    poster = "https:" + poster
                t2 = poster
        media.append({
            "type": "video",
            "url": video_url,
            "thumbnail": t2,
            "duration": None,
            "post_url": post_url,
            "video_available": bool(video_url),
        })

    for si in clean.select(".tgme_widget_message_sticker_wrap img"):
        src = si.get("data-src") or si.get("src", "")
        if src:
            if src.startswith("//"): src = "https:" + src
            media.append({"type": "photo", "url": src})

    if not media:
        for lp in clean.select(".link_preview_image"):
            u = extract_bg_url(lp.get("style", ""))
            if u:
                media.append({"type": "photo", "url": u})

    return media


def normalize_video_flags(posts: list[dict]) -> list[dict]:
    """Гарантирует, что у каждого video есть video_available, согласованный с url."""
    for post in posts:
        media = post.get("media") or []
        for m in media:
            if m.get("type") == "video":
                m["video_available"] = bool(m.get("url"))
    return posts


# ============================================================
# ПАРСИНГ EMBED-СТРАНИЦЫ ОДНОГО ПОСТА (надёжный источник)
# ============================================================

def fetch_post_via_embed(channel: str, post_id: int) -> dict | None:
    """
    Загружает один пост через embed.
    Это НАДЁЖНЫЙ источник: полный текст, точная дата, медиа.
    """
    try:
        html = fetch_embed(channel, post_id)
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 404:
            return None  # пост удалён
        raise

    soup = BeautifulSoup(html, "html.parser")

    # Пробуем несколько селекторов — структура embed может отличаться
    msg = (soup.select_one(".tgme_widget_message_wrap .tgme_widget_message")
           or soup.select_one(".tgme_widget_message"))
    if not msg:
        return None

    post_url = f"https://t.me/{channel}/{post_id}"

    # Текст — ИСКЛЮЧАЕМ текст из reply-цитаты
    text_el = get_post_text(msg)
    hc, pt = "", ""
    if text_el:
        hc = sanitize_html(text_el)
        pt = html_to_plain(hc)

    # Дата — ищем ВСЕ time[datetime] и берём ту, которая в footer
    date_str = ""
    # Приоритет 1: дата из footer (это дата публикации в канале)
    footer = msg.select_one(".tgme_widget_message_footer")
    if footer:
        time_el = footer.select_one("time[datetime]")
        if time_el:
            date_str = time_el.get("datetime", "")

    # Приоритет 2: любой time[datetime] если footer не дал результат
    if not date_str:
        time_el = msg.select_one("time[datetime]")
        if time_el:
            date_str = time_el.get("datetime", "")

    # Просмотры
    views_el = msg.select_one(".tgme_widget_message_views")
    views = parse_views(views_el.text) if views_el else None
    fwd_el = msg.select_one(".tgme_widget_message_forwards")
    forwards = parse_views(fwd_el.text) if fwd_el else None

    # Реакции — реальная структура Telegram:
    # <span class="tgme_reaction"><i class="emoji"><b>❤</b></i>61</span>
    reactions = []
    for react_el in msg.select(".tgme_reaction"):
        emoji_tag = react_el.select_one("i.emoji")
        if not emoji_tag:
            continue
        emoji = emoji_tag.get_text().strip()
        # Счётчик — текстовый узел после <i>, не внутри тега
        count_text = ""
        for child in react_el.children:
            if isinstance(child, NavigableString):
                count_text += str(child).strip()
        count = parse_views(count_text) or 0
        if emoji and count:
            reactions.append({"emoji": emoji, "count": count})

    # Медиа
    media = extract_media(msg, post_url, channel)

    if not date_str and not pt and not media:
        return None  # совсем пустой — скорее всего часть альбома

    return {
        "id": post_id,
        "date": date_str,
        "text": pt,
        "html": hc,
        "media": media,
        "views": views,
        "forwards": forwards,
        "reactions": reactions,
        "url": post_url,
    }


# ============================================================
# РЕЖИМ REPAIR — починка существующих постов
# ============================================================

def is_post_broken(post: dict) -> tuple[bool, str]:
    """Определяет, нужно ли чинить пост. Возвращает (broken, reason)."""
    reasons = []

    # 1. Обрезанный текст
    if is_truncated(post.get("text", "")):
        reasons.append("обрезан текст")

    # 2. Нет даты или невалидная
    if not is_valid_date(post.get("date", "")):
        reasons.append("нет даты")

    # 3. Пустой текст при отсутствии медиа
    if not post.get("text") and not post.get("html") and not post.get("media"):
        reasons.append("пустой пост")

    # 4. Нет html но есть text (старый формат скрейпера)
    if post.get("text") and not post.get("html"):
        reasons.append("нет html")

    # 5. Медиа содержат только битые записи (type=video без thumbnail и без post_url)
    for m in (post.get("media") or []):
        if m.get("type") == "video" and not m.get("post_url"):
            reasons.append("битое видео")
            break
        if m.get("type") == "video" and not m.get("url"):
            reasons.append("видео без url")
            break
        if m.get("type") == "document" and (not m.get("url") or m["url"] == "#"):
            reasons.append("битый документ")
            break

    if reasons:
        return True, ", ".join(reasons)
    return False, ""


def repair_posts(channel: str, posts: list[dict], repair_all: bool = False) -> list[dict]:
    """
    Проходит по всем постам и чинит битые через embed-запросы.
    repair_all=True — перепроверяет ВСЕ посты, не только битые.
    """
    to_repair = []
    for p in posts:
        if repair_all:
            to_repair.append((p, "полная перепроверка"))
        else:
            broken, reason = is_post_broken(p)
            if broken:
                to_repair.append((p, reason))

    if not to_repair:
        print("✅ Битых постов не найдено!")
        return posts

    print(f"\n🔧 Найдено постов для починки: {len(to_repair)}")
    for p, reason in to_repair[:10]:  # показываем первые 10
        print(f"   #{p['id']}: {reason}")
    if len(to_repair) > 10:
        print(f"   ... и ещё {len(to_repair) - 10}")

    posts_map = {p["id"]: p for p in posts}
    fixed = 0
    deleted = 0
    errors = 0

    for i, (post, reason) in enumerate(to_repair):
        pid = post["id"]
        print(f"\n   [{i+1}/{len(to_repair)}] Пост #{pid} ({reason})...")

        try:
            embed_data = fetch_post_via_embed(channel, pid)

            if embed_data is None:
                # Пост удалён или недоступен — удаляем из базы
                print(f"      ❌ Пост удалён из Telegram, удаляю")
                posts_map.pop(pid, None)
                deleted += 1
                time.sleep(DELAY_EMBED)
                continue

            old = posts_map[pid]
            changes = []

            # Обновляем дату (embed — надёжный источник)
            if is_valid_date(embed_data["date"]):
                if old.get("date") != embed_data["date"]:
                    changes.append(f"дата: {old.get('date', '?')[:10]} → {embed_data['date'][:10]}")
                    old["date"] = embed_data["date"]

            # Обновляем текст если embed дал более длинный
            if embed_data.get("text"):
                old_len = len(old.get("text", ""))
                new_len = len(embed_data["text"])
                if new_len > old_len:
                    changes.append(f"текст: {old_len} → {new_len} символов")
                    old["text"] = embed_data["text"]
                    old["html"] = embed_data.get("html", "")
                elif not old.get("html") and embed_data.get("html"):
                    # Текст той же длины, но html не было
                    changes.append("добавлен html")
                    old["html"] = embed_data["html"]

            # Обновляем медиа если embed дал больше
            if embed_data.get("media"):
                old_media_count = len(old.get("media") or [])
                new_media_count = len(embed_data["media"])
                if new_media_count > old_media_count:
                    changes.append(f"медиа: {old_media_count} → {new_media_count}")
                    old["media"] = embed_data["media"]
                elif old_media_count > 0:
                    # Обновляем post_url у видео и url у документов
                    for nm in embed_data["media"]:
                        if nm.get("type") == "video" and nm.get("post_url"):
                            for om in (old.get("media") or []):
                                if om.get("type") == "video" and not om.get("post_url"):
                                    om["post_url"] = nm["post_url"]
                        # Обновляем url у видео без прямой ссылки
                        if nm.get("type") == "video" and nm.get("url"):
                            for om in (old.get("media") or []):
                                if om.get("type") == "video" and not om.get("url"):
                                    om["url"] = nm["url"]
                                    om["video_available"] = True
                                    if nm.get("thumbnail") and not om.get("thumbnail"):
                                        om["thumbnail"] = nm["thumbnail"]
                                    break
                        if nm.get("type") == "document" and nm.get("url") and nm["url"] != "#":
                            for om in (old.get("media") or []):
                                if om.get("type") == "document" and (not om.get("url") or om["url"] == "#"):
                                    om["url"] = nm["url"]

            # Views/forwards
            if embed_data.get("views"):
                old["views"] = embed_data["views"]
            if embed_data.get("forwards"):
                old["forwards"] = embed_data["forwards"]
            if embed_data.get("reactions"):
                old["reactions"] = embed_data["reactions"]

            if changes:
                print(f"      ✅ {'; '.join(changes)}")
                fixed += 1
            else:
                print(f"      — без изменений")

        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                print(f"      ⏳ 429 — жду 30 сек...")
                time.sleep(30)
                errors += 1
            else:
                print(f"      ⚠️ HTTP {e.response.status_code if e.response else '?'}")
                errors += 1
        except Exception as e:
            print(f"      ⚠️ Ошибка: {e}")
            errors += 1

        time.sleep(DELAY_EMBED)

    # Удаляем посты без валидной даты
    before_len = len(posts_map)
    posts_map = {pid: p for pid, p in posts_map.items() if is_valid_date(p.get("date", ""))}
    date_removed = before_len - len(posts_map)

    result = sorted(posts_map.values(), key=lambda p: p["id"], reverse=True)
    result = normalize_video_flags(result)
    print(f"\n📊 Итого: починено {fixed} | удалено {deleted} | ошибок {errors} | без даты удалено {date_removed} | всего {len(result)}")
    return result


# ============================================================
# ПАРСИНГ СТРАНИЦЫ ЛЕНТЫ (с обработкой групп)
# ============================================================

def parse_single_message(msg, channel: str) -> dict | None:
    dp = msg.get("data-post", "")
    if "/" not in dp:
        return None
    pid = int(dp.split("/")[-1])
    post_url = f"https://t.me/{channel}/{pid}"

    # Текст — ИСКЛЮЧАЕМ текст из reply-цитаты
    text_el = get_post_text(msg)
    hc, pt = "", ""
    if text_el:
        hc = sanitize_html(text_el)
        pt = html_to_plain(hc)

    date_str = ""
    footer = msg.select_one(".tgme_widget_message_footer")
    if footer:
        date_el = footer.select_one("time[datetime]")
        if date_el:
            date_str = date_el.get("datetime", "")

    views_el = msg.select_one(".tgme_widget_message_views")
    views = parse_views(views_el.text) if views_el else None
    fwd_el = msg.select_one(".tgme_widget_message_forwards")
    forwards = parse_views(fwd_el.text) if fwd_el else None

    # Реакции — реальная структура Telegram:
    # <span class="tgme_reaction"><i class="emoji"><b>❤</b></i>61</span>
    reactions = []
    for react_el in msg.select(".tgme_reaction"):
        emoji_tag = react_el.select_one("i.emoji")
        if not emoji_tag:
            continue
        emoji = emoji_tag.get_text().strip()
        count_text = ""
        for child in react_el.children:
            if isinstance(child, NavigableString):
                count_text += str(child).strip()
        count = parse_views(count_text) or 0
        if emoji and count:
            reactions.append({"emoji": emoji, "count": count})

    media = extract_media(msg, post_url, channel)

    return {
        "id": pid, "date": date_str, "text": pt, "html": hc,
        "media": media, "views": views, "forwards": forwards,
        "reactions": reactions, "url": post_url, "_truncated": is_truncated(pt),
    }


def parse_posts(html: str, channel: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    posts = []

    grouped_ids = set()
    for group_wrap in soup.select(".tgme_widget_message_grouped_wrap"):
        group_msgs = group_wrap.select(".tgme_widget_message")
        if len(group_msgs) < 2:
            continue

        all_media, group_text_html, group_text_plain = [], "", ""
        group_date, group_views, group_forwards, group_id = "", None, None, None
        group_truncated = False
        group_reactions = []

        for gm in group_msgs:
            parsed = parse_single_message(gm, channel)
            if not parsed:
                continue
            grouped_ids.add(parsed["id"])
            all_media.extend(parsed["media"])
            if parsed["date"]:       group_date = parsed["date"]
            if parsed["html"]:       group_text_html = parsed["html"]; group_text_plain = parsed["text"]; group_truncated = parsed.get("_truncated", False)
            if parsed["views"]:      group_views = parsed["views"]
            if parsed["forwards"]:   group_forwards = parsed["forwards"]
            if parsed.get("reactions"): group_reactions = parsed["reactions"]
            if group_id is None or parsed["id"] > group_id:
                group_id = parsed["id"]

        if group_id is None or not is_valid_date(group_date):
            continue

        posts.append({
            "id": group_id, "date": group_date,
            "text": group_text_plain, "html": group_text_html,
             "media": all_media, "views": group_views, "forwards": group_forwards,
            "reactions": group_reactions, "url": f"https://t.me/{channel}/{group_id}",
            "_truncated": group_truncated,
        })

    for msg in soup.select(".tgme_widget_message"):
        try:
            dp = msg.get("data-post", "")
            if "/" not in dp: continue
            pid = int(dp.split("/")[-1])
            if pid in grouped_ids: continue
            parsed = parse_single_message(msg, channel)
            if not parsed: continue
            if not is_valid_date(parsed["date"]): continue
            if not parsed["text"] and not parsed["html"] and not parsed["media"]: continue
            posts.append(parsed)
        except Exception as e:
            print(f"   ⚠️ {dp}: {e}")
            continue

    return posts


# ============================================================
# СКРЕЙПИНГ
# ============================================================

def scrape(channel, max_pages):
    all_posts, seen, before = [], set(), None
    for page in range(max_pages):
        print(f"📥 {page+1}/{max_pages}...")
        try:
            html = fetch_page(channel, before)
        except requests.exceptions.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                print("   ⏳ 429, жду 30 сек..."); time.sleep(30)
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
        if page < max_pages - 1: time.sleep(DELAY)

    # Дозагрузка обрезанных
    truncated = [p for p in all_posts if p.get("_truncated")]
    if truncated:
        print(f"\n📝 Дозагрузка полного текста: {len(truncated)} постов...")
        for i, post in enumerate(truncated):
            print(f"   {i+1}/{len(truncated)}: #{post['id']}...")
            embed = fetch_post_via_embed(channel, post["id"])
            if embed:
                if embed.get("text") and len(embed["text"]) > len(post.get("text", "")):
                    post["text"] = embed["text"]; post["html"] = embed.get("html", "")
                if is_valid_date(embed.get("date", "")):
                    post["date"] = embed["date"]
                if embed.get("media") and len(embed["media"]) > len(post.get("media", [])):
                    post["media"] = embed["media"]
            post.pop("_truncated", None)
            time.sleep(DELAY_EMBED)

    for p in all_posts:
        p.pop("_truncated", None)

    all_posts.sort(key=lambda p: p["id"], reverse=True)
    return all_posts


# ============================================================
# MERGE
# ============================================================

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
            if is_valid_date(p.get("date","")) and not is_valid_date(o.get("date","")):
                o["date"] = p["date"]
            if p.get("text") and len(p["text"]) > len(o.get("text","")):
                o["text"] = p["text"]; o["html"] = p.get("html","")
            if p.get("views"):    o["views"] = p["views"]
            if p.get("forwards"): o["forwards"] = p["forwards"]
            if p.get("reactions"): o["reactions"] = p["reactions"]
            if p.get("media") and (not o.get("media") or len(p["media"]) > len(o.get("media",[]))):
                o["media"] = p["media"]

    before_count = len(mm)
    mm = {pid: p for pid, p in mm.items() if is_valid_date(p.get("date",""))}
    removed = before_count - len(mm)

    for p in mm.values(): p.pop("_truncated", None)
    merged = sorted(mm.values(), key=lambda p: p["id"], reverse=True)
    merged = normalize_video_flags(merged)
    print(f"✅ Новых: {added} | Удалено без дат: {removed} | Всего: {len(merged)}")
    return merged


# ============================================================
# MAIN
# ============================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", type=int, default=DEFAULT_PAGES)
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--repair", action="store_true",
                        help="Починить битые посты в posts.json через embed")
    parser.add_argument("--all", action="store_true",
                        help="С --repair: перепроверить ВСЕ посты, не только битые")
    args = parser.parse_args()

    if args.fresh and OUTPUT_POSTS.exists():
        OUTPUT_POSTS.unlink(); print("🗑️ Удалён posts.json")

    # Мета
    print(f"📡 Мета @{CHANNEL}...")
    try:
        meta = fetch_channel_meta(CHANNEL)
        OUTPUT_CHANNEL.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_CHANNEL.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
        print(f"   {meta['title']}: {meta['subscribers']:,} подп.")
    except Exception as e:
        print(f"⚠️ Мета: {e}")

    # ============ РЕЖИМ REPAIR ============
    if args.repair:
        if not OUTPUT_POSTS.exists():
            print("❌ Нет posts.json для починки. Сначала запустите без --repair.")
            return

        posts = json.loads(OUTPUT_POSTS.read_text("utf-8"))
        print(f"📂 Загружено {len(posts)} постов из posts.json")
        repaired = repair_posts(CHANNEL, posts, repair_all=args.all)
        OUTPUT_POSTS.write_text(json.dumps(repaired, ensure_ascii=False, indent=2), "utf-8")
        print(f"💾 → {OUTPUT_POSTS}")
        return

    # ============ ОБЫЧНЫЙ РЕЖИМ ============
    print(f"🔍 Посты ({args.pages} стр.)...")
    posts = scrape(CHANNEL, args.pages)
    if not posts: print("❌ Нет постов."); return

    OUTPUT_POSTS.parent.mkdir(parents=True, exist_ok=True)
    merged = merge(posts, OUTPUT_POSTS)
    OUTPUT_POSTS.write_text(json.dumps(merged, ensure_ascii=False, indent=2), "utf-8")
    print(f"💾 → {OUTPUT_POSTS}")


if __name__ == "__main__":
    main()
