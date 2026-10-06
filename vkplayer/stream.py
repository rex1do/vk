"""Загрузка трека в локальный кэш.

ВК отдаёт музыку как HLS (index.m3u8): плейлист из кусочков, часть которых
зашифрована AES-128. Скачиваем кусочки параллельно, расшифровываем и склеиваем
в один файл, который потом играет обычный медиаплеер.
"""

from __future__ import annotations

import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urljoin

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .vk import http_get


class Cancelled(Exception):
    pass


class ExpiredUrl(Exception):
    """Ссылка на трек протухла (403/404) — нужно запросить новую."""


@dataclass(frozen=True)
class Segment:
    url: str
    key_url: Optional[str] = None
    iv: Optional[bytes] = None


def _get(url: str) -> bytes:
    response = http_get(url, timeout=30)
    if response.status_code in (403, 404, 410):
        raise ExpiredUrl(f"HTTP {response.status_code}")
    if response.status_code >= 400:
        raise IOError(f"HTTP {response.status_code} при загрузке {url[:80]}")
    return response.content


def _attrs(line: str) -> dict[str, str]:
    value = line.split(":", 1)[1]
    return {m.group(1): m.group(2).strip('"') for m in re.finditer(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', value)}


def parse_playlist(url: str, text: str, depth: int = 0) -> list[Segment]:
    segments: list[Segment] = []
    variants: list[tuple[int, str]] = []
    pending_bandwidth: Optional[int] = None
    key_url: Optional[str] = None
    key_iv: Optional[bytes] = None
    sequence = 0
    last_map: Optional[str] = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-KEY"):
            a = _attrs(line)
            if a.get("METHOD", "NONE").upper() == "NONE":
                key_url, key_iv = None, None
            elif a["METHOD"].upper() == "AES-128":
                key_url = urljoin(url, a["URI"])
                iv = a.get("IV")
                key_iv = bytes.fromhex(iv[2:].zfill(32)) if iv else None
            else:
                raise IOError(f"Неподдерживаемое шифрование: {a['METHOD']}")
        elif line.startswith("#EXT-X-MEDIA-SEQUENCE"):
            sequence = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-STREAM-INF"):
            pending_bandwidth = int(_attrs(line).get("BANDWIDTH", "0"))
        elif line.startswith("#EXT-X-MAP"):
            map_url = urljoin(url, _attrs(line)["URI"])
            if map_url != last_map:
                segments.append(Segment(map_url, key_url, key_iv) if key_url and key_iv else Segment(map_url))
                last_map = map_url
        elif line.startswith("#"):
            continue
        elif pending_bandwidth is not None:
            variants.append((pending_bandwidth, urljoin(url, line)))
            pending_bandwidth = None
        else:
            iv = (key_iv or sequence.to_bytes(16, "big")) if key_url else None
            segments.append(Segment(urljoin(url, line), key_url, iv))
            sequence += 1

    if variants:
        if depth > 3:
            raise IOError("Слишком глубокая вложенность m3u8")
        best = max(variants)[1]
        return parse_playlist(best, _get(best).decode("utf-8", "replace"), depth + 1)
    return segments


def _decrypt(data: bytes, key: bytes, iv: bytes) -> bytes:
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    out = decryptor.update(data) + decryptor.finalize()
    pad = out[-1] if out else 0
    if 1 <= pad <= 16 and out[-pad:] == bytes([pad]) * pad:
        out = out[:-pad]
    return out


def _extension(head: bytes) -> str:
    if head[:1] == b"\x47":
        return ".ts"
    if b"ftyp" in head[:12] or b"moof" in head[:12] or b"styp" in head[:12]:
        return ".m4a"
    return ".mp3"


def cached(cache_dir: Path, key: str) -> Optional[Path]:
    for path in cache_dir.glob(f"{key}.*"):
        if path.suffix in (".mp3", ".ts", ".m4a"):
            return path
    return None


def download(url: str, cache_dir: Path, key: str, is_cancelled: Callable[[], bool] = lambda: False) -> Path:
    """Скачивает трек в cache_dir/<key>.<ext> (или берёт уже скачанный) и возвращает путь."""
    hit = cached(cache_dir, key)
    if hit:
        return hit
    if not url:
        raise ExpiredUrl("нет ссылки")
    cache_dir.mkdir(parents=True, exist_ok=True)

    if ".m3u8" in url:
        segments = parse_playlist(url, _get(url).decode("utf-8", "replace"))
        if not segments:
            raise IOError("Пустой плейлист трека")
        keys = {u: _get(u) for u in {s.key_url for s in segments if s.key_url}}

        def fetch(segment: Segment) -> bytes:
            if is_cancelled():
                raise Cancelled()
            data = _get(segment.url)
            if segment.key_url:
                data = _decrypt(data, keys[segment.key_url], segment.iv)
            return data

        with ThreadPoolExecutor(max_workers=6) as pool:
            parts = list(pool.map(fetch, segments))
        data = b"".join(parts)
    else:
        data = _get(url)

    if is_cancelled():
        raise Cancelled()
    target = cache_dir / f"{key}{_extension(data[:16])}"
    tmp = cache_dir / f"{key}.{uuid.uuid4().hex}.part"
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return target


def prune(cache_dir: Path, max_bytes: int, keep: set[Path] = frozenset()) -> None:
    """Удаляет самые старые файлы кэша, пока он больше max_bytes."""
    try:
        files = sorted((p for p in cache_dir.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime)
    except OSError:
        return
    total = sum(p.stat().st_size for p in files)
    for path in files:
        if total <= max_bytes:
            break
        if path in keep:
            continue
        try:
            size = path.stat().st_size
            path.unlink()
            total -= size
        except OSError:
            pass  # файл сейчас играет (Windows не даёт удалить) — пропускаем
