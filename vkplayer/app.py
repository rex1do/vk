"""Главное окно плеера."""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Callable, Optional

from PySide6.QtCore import (
    QAbstractListModel,
    QModelIndex,
    QObject,
    QRunnable,
    QSettings,
    QSize,
    QStandardPaths,
    Qt,
    QThreadPool,
    QTimer,
    QUrl,
    Signal,
    Slot,
)
from PySide6.QtGui import QFont, QGuiApplication, QKeySequence, QShortcut
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListView,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QSlider,
    QStackedWidget,
    QSystemTrayIcon,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from . import stream, ui, vk
from .auth import LoginDialog
from .ui import fmt_time

APP_NAME = "VK Player"
CACHE_LIMIT = 500 * 1024 * 1024


def data_dir() -> Path:
    path = Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppDataLocation))
    path.mkdir(parents=True, exist_ok=True)
    return path


def session_file() -> Path:
    return data_dir() / "session.json"


def load_session() -> Optional[dict]:
    try:
        return json.loads(session_file().read_text("utf-8"))
    except (OSError, ValueError):
        return None


def save_session(session: Optional[dict]) -> None:
    if session is None:
        session_file().unlink(missing_ok=True)
    else:
        session_file().write_text(json.dumps(session), "utf-8")


def plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


# --- Фоновые задачи ---------------------------------------------------------------------------


class _Task(QRunnable):
    class Bridge(QObject):
        done = Signal(object)
        failed = Signal(object)

        def __init__(self, on_done, on_fail):
            super().__init__()
            self.on_done, self.on_fail = on_done, on_fail
            self.done.connect(self._done)
            self.failed.connect(self._failed)

        @Slot(object)
        def _done(self, value):
            _alive.discard(self)
            if self.on_done:
                self.on_done(value)

        @Slot(object)
        def _failed(self, error):
            _alive.discard(self)
            if self.on_fail:
                self.on_fail(error)

    def __init__(self, fn, on_done, on_fail):
        super().__init__()
        self.fn = fn
        self.bridge = self.Bridge(on_done, on_fail)  # живёт в GUI-потоке → слоты вызываются там же
        _alive.add(self.bridge)

    def run(self):
        try:
            value = self.fn()
        except Exception as e:
            self.bridge.failed.emit(e)
        else:
            self.bridge.done.emit(value)


_alive: set = set()


def run_bg(fn: Callable, on_done: Optional[Callable] = None, on_fail: Optional[Callable] = None) -> None:
    QThreadPool.globalInstance().start(_Task(fn, on_done, on_fail))


# --- Список треков ----------------------------------------------------------------------------


class TrackModel(QAbstractListModel):
    def __init__(self):
        super().__init__()
        self.tracks: list[vk.Track] = []

    def set_tracks(self, tracks: list[vk.Track]) -> None:
        self.beginResetModel()
        self.tracks = tracks
        self.endResetModel()

    def rowCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.tracks)

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        track = self.tracks[index.row()]
        if role == ui.TRACK_ROLE:
            return track
        if role == Qt.ItemDataRole.DisplayRole:
            return track.name
        if role == Qt.ItemDataRole.ToolTipRole:
            return track.name if track.url else f"{track.name}\nТрек недоступен"
        return None


# --- Главное окно -----------------------------------------------------------------------------

REPEAT_OFF, REPEAT_ALL, REPEAT_ONE = range(3)
TITLE_ROLE = Qt.ItemDataRole.UserRole + 2


class PlayerWindow(QMainWindow):
    SECTION_MY, SECTION_RECS, SECTION_SEARCH = "my", "recs", "search"
    FIXED_NAV_ITEMS = 4  # три раздела + подпись «Плейлисты»

    def __init__(self, session: dict):
        super().__init__()
        self.session = session
        self.api = vk.VKClient(session["token"], session.get("client", vk.KATE.name), session.get("user_id"))
        self.settings = QSettings()
        self.cache_dir = data_dir() / "cache"

        self.queue: list[vk.Track] = []
        self.queue_pos = -1
        self.current: Optional[vk.Track] = None
        self.load_generation = 0
        self.history: list[int] = []
        self.repeat = int(self.settings.value("repeat", REPEAT_ALL))
        self.dragging = False
        self.failures = 0
        self.muted_volume = 0
        self.sections: dict[str, list[vk.Track]] = {}

        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.player.setAudioOutput(self.audio)
        self.player.positionChanged.connect(self.on_position)
        self.player.durationChanged.connect(self.on_duration)
        self.player.mediaStatusChanged.connect(self.on_media_status)
        self.player.playbackStateChanged.connect(self.on_state)
        self.player.errorOccurred.connect(self.on_player_error)

        self.build_ui()
        self.restore_settings()
        self.track_view.setFocus()
        self.load_section(self.SECTION_MY)
        self.load_playlists()

    # --- интерфейс ---

    @staticmethod
    def tool_button(name: str, tip: str, slot, size: int = 32, icon_size: int = 20, checkable: bool = False) -> QToolButton:
        b = QToolButton()
        b.setIcon(ui.icon(name, ui.TEXT))
        b.setIconSize(QSize(icon_size, icon_size))
        b.setFixedSize(size, size)
        b.setToolTip(tip)
        b.setCheckable(checkable)
        b.setCursor(Qt.CursorShape.PointingHandCursor)
        b.clicked.connect(slot)
        return b

    def build_sidebar(self) -> QWidget:
        sidebar = QFrame(objectName="sidebar")
        sidebar.setFixedWidth(250)
        layout = QVBoxLayout(sidebar)
        layout.setContentsMargins(14, 16, 14, 12)
        layout.setSpacing(10)

        logo_row = QHBoxLayout()
        logo_row.setSpacing(10)
        logo_icon = QLabel()
        logo_icon.setPixmap(ui.icon_pixmap("logo", size=30))
        logo_row.addWidget(logo_icon)
        logo_row.addWidget(QLabel(APP_NAME, objectName="logo"))
        logo_row.addStretch()
        layout.addLayout(logo_row)
        layout.addSpacing(4)

        self.search_edit = QLineEdit(placeholderText="Поиск музыки", clearButtonEnabled=True)
        self.search_edit.addAction(ui.icon("search", ui.MUTED), QLineEdit.ActionPosition.LeadingPosition)
        self.search_edit.returnPressed.connect(self.do_search)
        layout.addWidget(self.search_edit)

        self.nav = QListWidget(objectName="nav")
        self.nav.setIconSize(QSize(20, 20))
        self.nav.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.nav.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.nav.setCursor(Qt.CursorShape.PointingHandCursor)
        for key, title, icon_name in (
            (self.SECTION_MY, "Моя музыка", "music"),
            (self.SECTION_RECS, "Рекомендации", "sparkle"),
            (self.SECTION_SEARCH, "Поиск", "search"),
        ):
            item = QListWidgetItem(ui.icon(icon_name, ui.TEXT), "  " + title)
            item.setData(Qt.ItemDataRole.UserRole, key)
            item.setData(TITLE_ROLE, title)
            self.nav.addItem(item)
        caption = QListWidgetItem("ПЛЕЙЛИСТЫ")
        caption.setFlags(Qt.ItemFlag.NoItemFlags)
        caption.setForeground(Qt.GlobalColor.gray)
        font = QFont(caption.font())
        font.setPointSizeF(max(7.0, self.font().pointSizeF() * 0.8))
        font.setBold(True)
        caption.setFont(font)
        caption.setSizeHint(QSize(0, 44))
        self.nav.addItem(caption)
        self.nav.itemClicked.connect(self.on_nav)
        layout.addWidget(self.nav, 1)

        # Блок аккаунта внизу
        user_row = QHBoxLayout()
        user_row.setSpacing(10)
        avatar = QLabel()
        name = self.session.get("name", "") or "Аккаунт ВК"
        avatar.setPixmap(ui.avatar_pixmap(name, 34))
        names = QVBoxLayout()
        names.setSpacing(0)
        names.addWidget(self._name_label(name))
        names.addWidget(QLabel("ВКонтакте", objectName="userHint"))
        menu_btn = self.tool_button("more", "Меню", lambda: None)
        menu = QMenu(self)
        menu.addAction("Обновить списки", self.refresh, QKeySequence(QKeySequence.StandardKey.Refresh))
        menu.addAction("Очистить кэш", self.clear_cache)
        menu.addSeparator()
        menu.addAction("Выйти из аккаунта", self.logout)
        menu.addAction("Закрыть программу", self.quit, QKeySequence(QKeySequence.StandardKey.Quit))
        menu_btn.setMenu(menu)
        menu_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.addActions(menu.actions())  # чтобы горячие клавиши работали без открытия меню
        user_row.addWidget(avatar)
        user_row.addLayout(names, 1)
        user_row.addWidget(menu_btn)
        layout.addLayout(user_row)
        return sidebar

    @staticmethod
    def _name_label(name: str) -> QLabel:
        label = ui.ElidedLabel(name)
        label.setObjectName("userName")
        return label

    def build_content(self) -> QWidget:
        content = QWidget()
        layout = QVBoxLayout(content)
        layout.setContentsMargins(28, 22, 18, 0)
        layout.setSpacing(14)

        header = QHBoxLayout()
        titles = QVBoxLayout()
        titles.setSpacing(2)
        self.page_title = ui.ElidedLabel("Моя музыка")
        self.page_title.setObjectName("pageTitle")
        self.page_info = QLabel("", objectName="pageInfo")
        titles.addWidget(self.page_title)
        titles.addWidget(self.page_info)
        header.addLayout(titles, 1)

        self.status_label = ui.ElidedLabel("")
        self.status_label.setObjectName("status")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.status_timer = QTimer(self, singleShot=True, timeout=lambda: self.status_label.setText(""))
        header.addWidget(self.status_label, 1)

        self.play_all_btn = QPushButton(ui.icon("play", "#ffffff", 16), " Слушать")
        self.play_all_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.play_all_btn.clicked.connect(lambda: self.play_all(shuffle=False))
        self.shuffle_all_btn = QPushButton(ui.icon("shuffle", ui.TEXT, 16), " Перемешать", objectName="secondary")
        self.shuffle_all_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.shuffle_all_btn.clicked.connect(lambda: self.play_all(shuffle=True))
        header.addWidget(self.play_all_btn)
        header.addWidget(self.shuffle_all_btn)
        layout.addLayout(header)

        self.model = TrackModel()
        self.track_view = QListView(objectName="tracks")
        self.track_view.setModel(self.model)
        self.track_view.setItemDelegate(ui.TrackDelegate(self, self.track_view))
        self.track_view.setMouseTracking(True)
        self.track_view.setUniformItemSizes(True)
        self.track_view.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.track_view.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.track_view.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self.track_view.verticalScrollBar().setSingleStep(24)
        self.track_view.doubleClicked.connect(lambda index: self.play_from_view(index.row()))
        self.track_view.activated.connect(lambda index: self.play_from_view(index.row()))

        self.empty_label = QLabel("", objectName="empty")
        self.empty_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.stack = QStackedWidget()
        self.stack.addWidget(self.track_view)
        self.stack.addWidget(self.empty_label)
        layout.addWidget(self.stack, 1)
        return content

    def build_player_bar(self) -> QWidget:
        bar = QFrame(objectName="playerBar")
        bar.setFixedHeight(84)
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(16, 10, 20, 10)

        # Слева: обложка и название
        left = QHBoxLayout()
        left.setSpacing(12)
        self.cover_label = QLabel()
        self.cover_label.setPixmap(ui.cover_pixmap("", 52))
        texts = QVBoxLayout()
        texts.setSpacing(2)
        texts.addStretch()
        self.title_label = ui.ElidedLabel("Ничего не играет")
        self.title_label.setObjectName("trackTitle")
        self.artist_label = ui.ElidedLabel("Выберите трек двойным щелчком")
        self.artist_label.setObjectName("trackArtist")
        texts.addWidget(self.title_label)
        texts.addWidget(self.artist_label)
        texts.addStretch()
        left.addWidget(self.cover_label)
        left.addLayout(texts, 1)
        left_box = QWidget()
        left_box.setLayout(left)
        left_box.setFixedWidth(280)

        # Центр: кнопки и перемотка
        buttons = QHBoxLayout()
        buttons.setSpacing(10)
        self.shuffle_btn = self.tool_button("shuffle", "Перемешивать", self.on_shuffle, checkable=True)
        self.prev_btn = self.tool_button("prev", "Предыдущий (Ctrl+←)", self.prev_track, icon_size=18)
        self.play_btn = self.tool_button("play", "Играть / пауза (пробел)", self.toggle_play, size=40, icon_size=20)
        self.play_btn.setObjectName("play")
        self.play_btn.setIcon(ui.icon("play", ui.BG))
        self.next_btn = self.tool_button("next", "Следующий (Ctrl+→)", self.next_track, icon_size=18)
        self.repeat_btn = self.tool_button("repeat", "", self.cycle_repeat)
        buttons.addStretch()
        for w in (self.shuffle_btn, self.prev_btn, self.play_btn, self.next_btn, self.repeat_btn):
            buttons.addWidget(w)
        buttons.addStretch()

        seek_row = QHBoxLayout()
        seek_row.setSpacing(10)
        self.pos_label = QLabel("0:00", objectName="time")
        self.pos_label.setFixedWidth(40)
        self.pos_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.dur_label = QLabel("0:00", objectName="time")
        self.dur_label.setFixedWidth(40)
        self.seek = QSlider(Qt.Orientation.Horizontal)
        self.seek.setCursor(Qt.CursorShape.PointingHandCursor)
        self.seek.sliderPressed.connect(lambda: setattr(self, "dragging", True))
        self.seek.sliderReleased.connect(self.on_seek_released)
        self.seek.sliderMoved.connect(lambda v: self.pos_label.setText(fmt_time(v // 1000)))
        seek_row.addWidget(self.pos_label)
        seek_row.addWidget(self.seek, 1)
        seek_row.addWidget(self.dur_label)

        center = QVBoxLayout()
        center.setSpacing(2)
        center.addLayout(buttons)
        center.addLayout(seek_row)

        # Справа: громкость
        right = QHBoxLayout()
        right.setSpacing(6)
        right.addStretch()
        self.volume_btn = self.tool_button("volume", "Выключить звук", self.toggle_mute)
        self.volume = QSlider(Qt.Orientation.Horizontal)
        self.volume.setRange(0, 100)
        self.volume.setFixedWidth(110)
        self.volume.setCursor(Qt.CursorShape.PointingHandCursor)
        self.volume.valueChanged.connect(self.on_volume)
        right.addWidget(self.volume_btn)
        right.addWidget(self.volume)
        right_box = QWidget()
        right_box.setLayout(right)
        right_box.setFixedWidth(280)

        layout.addWidget(left_box)
        layout.addLayout(center, 1)
        layout.addWidget(right_box)
        return bar

    def build_ui(self) -> None:
        self.setWindowTitle(APP_NAME)
        self.setWindowIcon(ui.icon("logo", size=64))
        self.resize(1180, 740)
        self.setMinimumSize(960, 560)

        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)
        body.addWidget(self.build_sidebar())
        body.addWidget(self.build_content(), 1)

        central = QWidget()
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addLayout(body, 1)
        layout.addWidget(self.build_player_bar())
        self.setCentralWidget(central)

        # Горячие клавиши
        QShortcut(QKeySequence(Qt.Key.Key_Space), self, self.toggle_play)
        QShortcut(QKeySequence("Ctrl+Right"), self, self.next_track)
        QShortcut(QKeySequence("Ctrl+Left"), self, self.prev_track)
        QShortcut(QKeySequence("Ctrl+F"), self, self.search_edit.setFocus)
        QShortcut(QKeySequence(Qt.Key.Key_MediaPlay), self, self.toggle_play)
        QShortcut(QKeySequence(Qt.Key.Key_MediaTogglePlayPause), self, self.toggle_play)
        QShortcut(QKeySequence(Qt.Key.Key_MediaNext), self, self.next_track)
        QShortcut(QKeySequence(Qt.Key.Key_MediaPrevious), self, self.prev_track)

        # Значок в трее: можно свернуть окно и слушать дальше
        self.tray = QSystemTrayIcon(ui.icon("logo", size=64), self)
        tray_menu = QMenu(self)
        tray_menu.addAction("Показать", self.show_normal)
        tray_menu.addAction("Играть / пауза", self.toggle_play)
        tray_menu.addAction("Следующий", self.next_track)
        tray_menu.addAction("Предыдущий", self.prev_track)
        tray_menu.addSeparator()
        tray_menu.addAction("Закрыть", self.quit)
        self.tray.setContextMenu(tray_menu)
        self.tray.activated.connect(
            lambda reason: self.show_normal() if reason == QSystemTrayIcon.ActivationReason.Trigger else None
        )
        self.tray.setToolTip(APP_NAME)
        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray.show()

    def show_status(self, text: str, timeout: int = 0) -> None:
        self.status_label.setText(text)
        self.status_timer.stop()
        if timeout:
            self.status_timer.start(timeout)

    def show_normal(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def restore_settings(self) -> None:
        self.volume.setValue(int(self.settings.value("volume", 70)))
        self.on_volume(self.volume.value())
        self.shuffle_btn.setChecked(self.settings.value("shuffle", "false") in (True, "true"))
        self.on_shuffle()
        geometry = self.settings.value("geometry")
        if geometry is not None:
            self.restoreGeometry(geometry)
        self.update_repeat_button()

    def save_settings(self) -> None:
        self.settings.setValue("volume", self.volume.value())
        self.settings.setValue("shuffle", self.shuffle_btn.isChecked())
        self.settings.setValue("repeat", self.repeat)
        self.settings.setValue("geometry", self.saveGeometry())

    def on_shuffle(self) -> None:
        on = self.shuffle_btn.isChecked()
        self.shuffle_btn.setIcon(ui.icon("shuffle", ui.ACCENT if on else ui.MUTED))
        self.shuffle_btn.setToolTip("Перемешивание включено" if on else "Перемешивание выключено")
        self.save_settings()

    def toggle_mute(self) -> None:
        if self.volume.value() > 0:
            self.muted_volume = self.volume.value()
            self.volume.setValue(0)
        else:
            self.volume.setValue(self.muted_volume or 50)

    def set_now_playing(self, track: vk.Track) -> None:
        self.title_label.setText(track.title)
        self.artist_label.setText(track.artist)
        self.cover_label.setPixmap(ui.cover_pixmap(track.artist or track.title, 52))
        self.setWindowTitle(f"{track.name} — {APP_NAME}")
        self.tray.setToolTip(track.name)
        self.track_view.viewport().update()

    def is_playing(self) -> bool:
        return self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState

    def play_all(self, shuffle: bool) -> None:
        if not self.model.tracks:
            return
        self.shuffle_btn.setChecked(shuffle)
        self.on_shuffle()
        start = random.randrange(len(self.model.tracks)) if shuffle else 0
        self.play_from_view(start)

    # --- разделы и загрузка списков ---

    def current_nav_key(self) -> Optional[str]:
        item = self.nav.currentItem()
        return item.data(Qt.ItemDataRole.UserRole) if item else None

    def select_nav(self, key: str) -> None:
        for i in range(self.nav.count()):
            if self.nav.item(i).data(Qt.ItemDataRole.UserRole) == key:
                self.nav.setCurrentRow(i)
                return

    def on_nav(self, item: QListWidgetItem) -> None:
        key = item.data(Qt.ItemDataRole.UserRole)
        if not key:
            return
        if key == self.SECTION_SEARCH and key not in self.sections:
            self.show_tracks([])
            self.search_edit.setFocus()
            return
        if key in self.sections:
            self.show_tracks(self.sections[key])
        else:
            self.load_section(key, item.data(Qt.ItemDataRole.UserRole + 1))

    def show_tracks(self, tracks: list[vk.Track]) -> None:
        self.model.set_tracks(tracks)
        self.track_view.scrollToTop()
        item = self.nav.currentItem()
        self.page_title.setText(item.data(TITLE_ROLE) if item else "")
        if tracks:
            total = sum(t.duration for t in tracks)
            hours, minutes = total // 3600, total % 3600 // 60
            length = f"{hours} ч {minutes} мин" if hours else f"{minutes} мин"
            self.page_info.setText(f"{len(tracks)} {plural(len(tracks), 'трек', 'трека', 'треков')} · {length}")
            self.stack.setCurrentWidget(self.track_view)
        else:
            self.page_info.setText("")
            empty = "Введите запрос в поиске слева" if self.current_nav_key() == self.SECTION_SEARCH else "Здесь пока пусто"
            self.show_empty(empty)
        self.play_all_btn.setEnabled(bool(tracks))
        self.shuffle_all_btn.setEnabled(bool(tracks))

    def show_empty(self, text: str) -> None:
        self.empty_label.setText(text)
        self.stack.setCurrentWidget(self.empty_label)

    def load_section(self, key: str, playlist: Optional[vk.Playlist] = None, force: bool = False) -> None:
        if key in self.sections and not force:
            return
        self.select_nav(key)
        if key == self.SECTION_SEARCH:
            return
        loaders = {self.SECTION_MY: self.api.audio, self.SECTION_RECS: self.api.recommendations}
        if playlist is not None:
            loader = lambda: self.api.audio(playlist.owner_id, playlist.id, playlist.access_key)
        else:
            loader = loaders[key]
        item = self.nav.currentItem()
        self.page_title.setText(item.data(TITLE_ROLE) if item else "")
        self.page_info.setText("")
        self.model.set_tracks([])
        self.show_empty("Загрузка…")

        def done(tracks):
            self.sections[key] = tracks
            if self.current_nav_key() == key:
                self.show_tracks(tracks)

        run_bg(loader, done, self.on_api_error)

    def load_playlists(self) -> None:
        def done(playlists: list[vk.Playlist]):
            while self.nav.count() > self.FIXED_NAV_ITEMS:
                self.nav.takeItem(self.FIXED_NAV_ITEMS)
            for p in playlists:
                item = QListWidgetItem(ui.icon("playlist", ui.MUTED), "  " + p.title)
                item.setData(TITLE_ROLE, p.title)
                item.setToolTip(f"{p.title} — {p.count} {plural(p.count, 'трек', 'трека', 'треков')}")
                item.setData(Qt.ItemDataRole.UserRole, f"pl{p.owner_id}_{p.id}")
                item.setData(Qt.ItemDataRole.UserRole + 1, p)
                self.nav.addItem(item)

        run_bg(self.api.playlists, done, lambda e: None)

    def do_search(self) -> None:
        query = self.search_edit.text().strip()
        if not query:
            return
        self.select_nav(self.SECTION_SEARCH)
        self.model.set_tracks([])
        self.page_title.setText(f"Поиск: {query}")
        self.page_info.setText("")
        self.show_empty("Ищу…")

        def done(tracks):
            self.sections[self.SECTION_SEARCH] = tracks
            if self.current_nav_key() == self.SECTION_SEARCH:
                self.show_tracks(tracks)
                self.page_title.setText(f"Поиск: {query}")
                if not tracks:
                    self.show_empty("Ничего не нашлось")

        run_bg(lambda: self.api.search(query), done, self.on_api_error)

    def refresh(self) -> None:
        key = self.current_nav_key()
        self.sections.clear()
        self.load_playlists()
        if key and key != self.SECTION_SEARCH:
            item = self.nav.currentItem()
            self.load_section(key, item.data(Qt.ItemDataRole.UserRole + 1), force=True)
        elif key == self.SECTION_SEARCH:
            self.do_search()

    def on_api_error(self, error: Exception) -> None:
        if isinstance(error, vk.VKError) and error.code == 5:
            QMessageBox.warning(self, APP_NAME, "Сессия ВК истекла, войдите снова.")
            self.logout()
            return
        self.show_status(f"Ошибка: {error}", 8000)

    # --- воспроизведение ---

    def play_from_view(self, row: int) -> None:
        self.queue = list(self.model.tracks)
        self.history.clear()
        self.play_index(row)

    def play_index(self, index: int, retried: bool = False) -> None:
        if not (0 <= index < len(self.queue)):
            return
        track = self.queue[index]
        self.queue_pos = index
        self.current = track
        self.set_now_playing(track)
        self.player.stop()
        self.load_generation += 1
        generation = self.load_generation

        if not track.url and not stream.cached(self.cache_dir, track.key):
            if not retried:
                self.refresh_url_and_play(index, generation)
            else:
                self.show_status(f"Недоступен: {track.name}", 4000)
                self.skip_unavailable(generation)
            return

        self.show_status(f"Загрузка: {track.name}")

        def fetch():
            return stream.download(track.url, self.cache_dir, track.key, lambda: generation != self.load_generation)

        def done(path: Path):
            if generation != self.load_generation:
                return
            self.player.setSource(QUrl.fromLocalFile(str(path)))
            self.player.play()
            self.show_status("")
            self.prefetch_next()
            stream.prune(self.cache_dir, CACHE_LIMIT, keep={path})

        def failed(error):
            if generation != self.load_generation or isinstance(error, stream.Cancelled):
                return
            if isinstance(error, stream.ExpiredUrl) and not retried:
                self.refresh_url_and_play(index, generation)
                return
            self.show_status(f"Не удалось загрузить «{track.name}»: {error}", 6000)
            self.skip_unavailable(generation)

        run_bg(fetch, done, failed)

    def refresh_url_and_play(self, index: int, generation: int) -> None:
        """Ссылки на треки живут ограниченное время — запрашиваем свежую."""
        track = self.queue[index]

        def done(fresh: list[vk.Track]):
            if generation != self.load_generation:
                return
            if fresh and fresh[0].url:
                track.url = fresh[0].url
            self.play_index(index, retried=True)

        run_bg(lambda: self.api.by_id([track]), done, lambda e: done([]))

    def skip_unavailable(self, generation: int) -> None:
        self.failures += 1
        if self.failures >= 5:  # похоже, проблема не в треке, а в сети/доступе — не крутимся бесконечно
            self.failures = 0
            self.show_status("Несколько треков подряд не загрузились. Проверьте интернет.", 10000)
            return
        QTimer.singleShot(1500, lambda: generation == self.load_generation and self.next_track())

    def prefetch_next(self) -> None:
        nxt = self.peek_next()
        if nxt is None or self.shuffle_btn.isChecked():
            return
        track = self.queue[nxt]
        if track.url and not stream.cached(self.cache_dir, track.key):
            run_bg(lambda: stream.download(track.url, self.cache_dir, track.key))

    def peek_next(self) -> Optional[int]:
        if not self.queue:
            return None
        nxt = self.queue_pos + 1
        if nxt >= len(self.queue):
            return 0 if self.repeat == REPEAT_ALL else None
        return nxt

    def next_track(self, auto: bool = False) -> None:
        if not self.queue:
            return
        if auto and self.repeat == REPEAT_ONE:
            self.play_index(self.queue_pos)
            return
        self.history.append(self.queue_pos)
        if self.shuffle_btn.isChecked() and len(self.queue) > 1:
            choices = [i for i in range(len(self.queue)) if i != self.queue_pos]
            self.play_index(random.choice(choices))
            return
        nxt = self.peek_next()
        if nxt is None:
            self.player.stop()
            return
        self.play_index(nxt)

    def prev_track(self) -> None:
        if not self.queue:
            return
        if self.player.position() > 3000:
            self.player.setPosition(0)
            return
        if self.history:
            self.play_index(self.history.pop())
        else:
            self.play_index(max(0, self.queue_pos - 1))

    def toggle_play(self) -> None:
        if self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self.player.pause()
        elif self.player.source().isEmpty():
            rows = self.track_view.selectionModel().selectedIndexes()
            if self.model.tracks:
                self.play_from_view(rows[0].row() if rows else 0)
        else:
            self.player.play()

    def cycle_repeat(self) -> None:
        self.repeat = (self.repeat + 1) % 3
        self.update_repeat_button()
        self.save_settings()

    def update_repeat_button(self) -> None:
        name, color, tip = {
            REPEAT_OFF: ("repeat", ui.MUTED, "Повтор выключен"),
            REPEAT_ALL: ("repeat", ui.ACCENT, "Повтор списка"),
            REPEAT_ONE: ("repeat_one", ui.ACCENT, "Повтор трека"),
        }[self.repeat]
        self.repeat_btn.setIcon(ui.icon(name, color))
        self.repeat_btn.setToolTip(tip)

    # --- события плеера ---

    def on_position(self, ms: int) -> None:
        if not self.dragging:
            self.seek.setValue(ms)
            self.pos_label.setText(fmt_time(ms // 1000))

    def on_duration(self, ms: int) -> None:
        if ms <= 0 and self.current:
            ms = self.current.duration * 1000
        self.seek.setRange(0, ms)
        self.dur_label.setText(fmt_time(ms // 1000))

    def on_seek_released(self) -> None:
        self.dragging = False
        self.player.setPosition(self.seek.value())

    def on_volume(self, value: int) -> None:
        self.audio.setVolume(value / 100)
        self.settings.setValue("volume", value)
        name = "mute" if value == 0 else "volume_low" if value < 50 else "volume"
        self.volume_btn.setIcon(ui.icon(name, ui.TEXT if value else ui.MUTED))
        self.volume_btn.setToolTip("Включить звук" if value == 0 else "Выключить звук")

    def on_media_status(self, status) -> None:
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self.next_track(auto=True)

    def on_state(self, state) -> None:
        if state == QMediaPlayer.PlaybackState.PlayingState:
            self.failures = 0
        playing = state == QMediaPlayer.PlaybackState.PlayingState
        self.play_btn.setIcon(ui.icon("pause" if playing else "play", ui.BG))
        self.track_view.viewport().update()

    def on_player_error(self, error, message: str) -> None:
        if error == QMediaPlayer.Error.NoError:
            return
        self.show_status(f"Ошибка воспроизведения: {message}", 6000)
        if self.current:
            # Битый файл в кэше — удаляем, чтобы в следующий раз скачать заново
            path = stream.cached(self.cache_dir, self.current.key)
            self.player.setSource(QUrl())
            if path:
                path.unlink(missing_ok=True)
        self.skip_unavailable(self.load_generation)

    # --- аккаунт / выход ---

    def clear_cache(self) -> None:
        self.player.stop()
        self.player.setSource(QUrl())
        stream.prune(self.cache_dir, 0)
        self.show_status("Кэш очищен", 3000)

    def logout(self) -> None:
        save_session(None)
        self.player.stop()
        self.tray.hide()
        self.hide()
        self.deleteLater()
        start_app_window()

    def quit(self) -> None:
        self.save_settings()
        self.tray.hide()
        QApplication.quit()

    def closeEvent(self, event) -> None:
        self.save_settings()
        self.tray.hide()
        event.accept()
        QApplication.quit()


_window: Optional[PlayerWindow] = None


def start_app_window() -> None:
    global _window
    session = load_session()
    if session:
        # Быстрая проверка, что токен всё ещё жив
        try:
            vk.VKClient(session["token"], session.get("client", vk.KATE.name)).me()
        except vk.VKError:
            session = None
        except Exception:
            pass  # нет сети — попробуем работать дальше, ошибки покажутся в окне
    if not session:
        dialog = LoginDialog()
        if not dialog.exec() or not dialog.session:
            QApplication.quit()
            return
        session = dialog.session
        save_session(session)
    _window = PlayerWindow(session)
    _window.show()


def main() -> int:
    QApplication.setApplicationName(APP_NAME)
    QApplication.setOrganizationName("VKPlayer")
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setStyle("Fusion")
    try:  # тёмный заголовок окна в Windows 10/11 (Qt 6.8+)
        QGuiApplication.styleHints().setColorScheme(Qt.ColorScheme.Dark)
    except AttributeError:
        pass
    font = QFont()
    font.setFamilies(["Segoe UI Variable Text", "Segoe UI", "Inter", "Roboto", "Helvetica Neue", "Arial"])
    font.setPointSizeF(10)
    app.setFont(font)
    app.setStyleSheet(ui.STYLE)
    app.setWindowIcon(ui.icon("logo", size=64))
    start_app_window()
    if _window is None:
        return 0
    return app.exec()
