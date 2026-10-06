"""Работа с VK API: авторизация и получение аудиозаписей."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse

try:  # curl_cffi притворяется браузером на уровне TLS — так VK реже режет запросы
    from curl_cffi import requests as _http

    _HTTP_KW = {"impersonate": "chrome110"}
except ImportError:  # pragma: no cover
    import requests as _http

    _HTTP_KW = {}

API_URL = "https://api.vk.com/method/"
API_VERSION = "5.131"


@dataclass(frozen=True)
class Client:
    name: str
    user_agent: str
    client_id: str
    client_secret: str


KATE = Client(
    "kate",
    "KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)",
    "2685278",
    "lxhD8OD7dMsqtXIm5IUY",
)
VK_ANDROID = Client(
    "vk_android",
    "VKAndroidApp/4.13.1-1206 (Android 4.4.3; SDK 19; armeabi; ; ru)",
    "2274003",
    "hHbZxrka2uZ6jB1inYsH",
)
CLIENTS = {c.name: c for c in (KATE, VK_ANDROID)}

OAUTH_REDIRECT = "https://oauth.vk.com/blank.html"


def oauth_url(client: Client = KATE) -> str:
    """Адрес страницы входа ВК (implicit flow), токен вернётся во фрагменте blank.html."""
    return "https://oauth.vk.com/authorize?" + urlencode(
        {
            "client_id": client.client_id,
            "display": "page",
            "redirect_uri": OAUTH_REDIRECT,
            "scope": "audio,offline",
            "response_type": "token",
            "revoke": 1,
            "v": API_VERSION,
        }
    )


def parse_token_url(text: str) -> Optional[dict]:
    """Достаёт access_token/user_id из адреса вида blank.html#access_token=..."""
    text = text.strip()
    if "access_token=" not in text:
        return None
    parsed = urlparse(text)
    query = parsed.fragment or parsed.query or text
    values = {k: v[0] for k, v in parse_qs(query).items()}
    if "access_token" not in values:
        return None
    return values


def http_get(url: str, params: Optional[dict] = None, headers: Optional[dict] = None, timeout: float = 20):
    return _http.get(url, params=params, headers=headers, timeout=timeout, **_HTTP_KW)


class VKError(Exception):
    def __init__(self, code: int, message: str, data: Optional[dict] = None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.data = data or {}


# --- Прямая авторизация по логину и паролю -------------------------------------------------


def direct_auth(login: str, password: str, client: Client = VK_ANDROID, **extra) -> dict:
    """Один запрос к oauth.vk.com/token. Возвращает JSON как есть (токен или описание ошибки).

    extra: code (2FA), success_token (новая капча), captcha_sid/captcha_key (старая капча).
    """
    params = {
        "grant_type": "password",
        "client_id": client.client_id,
        "client_secret": client.client_secret,
        "username": login,
        "password": password,
        "scope": "audio,offline",
        "2fa_supported": 1,
        "force_sms": 1,
        "v": API_VERSION,
    }
    params.update({k: v for k, v in extra.items() if v})
    response = http_get("https://oauth.vk.com/token", params=params, headers={"User-Agent": client.user_agent})
    try:
        return response.json()
    except ValueError:
        return {"error": "bad_response", "error_description": f"HTTP {response.status_code}"}


def request_sms_code(sid: str, client: Client = VK_ANDROID) -> None:
    try:
        http_get(
            API_URL + "auth.validatePhone",
            params={"sid": sid, "v": API_VERSION},
            headers={"User-Agent": client.user_agent},
        )
    except Exception:
        pass  # код всё равно можно получить в приложении-генераторе


# --- Модели ---------------------------------------------------------------------------------


@dataclass
class Track:
    id: int
    owner_id: int
    artist: str
    title: str
    duration: int
    url: str
    access_key: str = ""

    @property
    def key(self) -> str:
        return f"{self.owner_id}_{self.id}"

    @property
    def full_id(self) -> str:
        return f"{self.key}_{self.access_key}" if self.access_key else self.key

    @property
    def name(self) -> str:
        return f"{self.artist} — {self.title}"

    @classmethod
    def from_json(cls, item: dict) -> "Track":
        return cls(
            id=int(item["id"]),
            owner_id=int(item["owner_id"]),
            artist=str(item.get("artist", "")),
            title=str(item.get("title", "")),
            duration=int(item.get("duration", 0)),
            url=str(item.get("url", "")),
            access_key=str(item.get("access_key", "")),
        )


@dataclass
class Playlist:
    id: int
    owner_id: int
    title: str
    count: int
    access_key: str = ""

    @classmethod
    def from_json(cls, item: dict) -> "Playlist":
        # Подписанные плейлисты ссылаются на оригинал — треки берём из него
        original = item.get("original") or {}
        return cls(
            id=int(original.get("playlist_id", item["id"])),
            owner_id=int(original.get("owner_id", item["owner_id"])),
            title=str(item.get("title", "")),
            count=int(item.get("count", 0)),
            access_key=str(original.get("access_key", item.get("access_key", ""))),
        )


# --- Клиент API -----------------------------------------------------------------------------


class VKClient:
    PAGE = 500

    def __init__(self, token: str, client_name: str = KATE.name, user_id: Optional[int] = None):
        self.token = token
        self.client = CLIENTS.get(client_name, KATE)
        self.user_id = user_id
        self._last_call = 0.0

    def call(self, method: str, **params):
        # Не чаще 3 запросов в секунду — ограничение VK
        wait = 0.34 - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

        query = {k: v for k, v in params.items() if v is not None and v != ""}
        query.update(access_token=self.token, v=API_VERSION, lang="ru", https=1)
        response = http_get(API_URL + method, params=query, headers={"User-Agent": self.client.user_agent})
        data = response.json()
        if "error" in data:
            err = data["error"]
            if isinstance(err, dict):
                raise VKError(int(err.get("error_code", 0)), str(err.get("error_msg", "")), err)
            raise VKError(0, str(err), data)
        return data.get("response")

    def me(self) -> dict:
        user = self.call("users.get")[0]
        self.user_id = int(user["id"])
        return user

    @staticmethod
    def _tracks(items) -> list[Track]:
        return [Track.from_json(i) for i in items or [] if "id" in i]

    def audio(self, owner_id: Optional[int] = None, album_id: Optional[int] = None, access_key: str = "") -> list[Track]:
        tracks: list[Track] = []
        offset = 0
        while True:
            resp = self.call(
                "audio.get",
                owner_id=owner_id or self.user_id,
                album_id=album_id,
                access_key=access_key,
                count=self.PAGE,
                offset=offset,
            )
            items = resp.get("items", [])
            tracks += self._tracks(items)
            offset += len(items)
            if not items or offset >= int(resp.get("count", 0)):
                return tracks

    def search(self, query: str) -> list[Track]:
        resp = self.call("audio.search", q=query, count=300, auto_complete=1)
        return self._tracks(resp.get("items"))

    def recommendations(self) -> list[Track]:
        resp = self.call("audio.getRecommendations", count=200)
        return self._tracks(resp.get("items"))

    def playlists(self) -> list[Playlist]:
        resp = self.call("audio.getPlaylists", owner_id=self.user_id, count=200)
        return [Playlist.from_json(i) for i in resp.get("items", [])]

    def by_id(self, tracks: list[Track]) -> list[Track]:
        resp = self.call("audio.getById", audios=",".join(t.full_id for t in tracks))
        return self._tracks(resp)
