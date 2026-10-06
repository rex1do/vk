"""Главное окно плеера."""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from typing import Callable, Optional

from PySide6.QtCore import (
    QAbstractTableModel,
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
from PySide6.QtGui import QAction, QColor, QFont, QIcon, QKeySequence, QPainter, QPainterPath, QPixmap, QShortcut
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QMessageBox,
    QSlider,
    QSplitter,
    QStyle,
    QSystemTrayIcon,
    QTableView,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from . import stream, vk
from .auth import LoginDialog

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


def fmt_time(seconds: int) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def media_icon(kind: str, color: str = "#e1e3e6", size: int = 48) -> QIcon:
    """Рисуем иконки сами: системные почти не видны на тёмной теме."""
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(Qt.PenStyle.NoPen)
    painter.setBrush(QColor(color))
    s = size / 48

    def triangle(x1, x2, y1=12, y2=36):
        path = QPainterPath()
        path.moveTo(x1 * s, y1 * s)
        path.lineTo(x2 * s, (y1 + y2) / 2 * s)
        path.lineTo(x1 * s, y2 * s)
        path.closeSubpath()
        painter.drawPath(path)

    if kind == "play":
        triangle(17, 37)
    elif kind == "pause":
        painter.drawRoundedRect(int(14 * s), int(12 * s), int(7 * s), int(24 * s), 2 * s, 2 * s)
        painter.drawRoundedRect(int(27 * s), int(12 * s), int(7 * s), int(24 * s), 2 * s, 2 * s)
    elif kind == "next":
        triangle(12, 32)
        painter.drawRoundedRect(int(32 * s), int(12 * s), int(5 * s), int(24 * s), 2 * s, 2 * s)
    elif kind == "prev":
        path = QPainterPath()
        path.moveTo(36 * s, 12 * s)
        path.lineTo(16 * s, 24 * s)
        path.lineTo(36 * s, 36 * s)
        path.closeSubpath()
        painter.drawPath(path)
        painter.drawRoundedRect(int(11 * s), int(12 * s), int(5 * s), int(24 * s), 2 * s, 2 * s)
    painter.end()
    return QIcon(pixmap)


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


# --- Таблица треков ---------------------------------------------------------------------------


class TrackModel(QAbstractTableModel):
    HEADERS = ["", "Исполнитель", "Название", "Время"]

    def __init__(self):
        super().__init__()
        self.tracks: list[vk.Track] = []
        self.playing_key: Optional[str] = None

    def set_tracks(self, tracks: list[vk.Track]) -> None:
        self.beginResetModel()
        self.tracks = tracks
        self.endResetModel()

    def set_playing(self, key: Optional[str]) -> None:
        self.playing_key = key
        if self.tracks:
            self.dataChanged.emit(self.index(0, 0), self.index(len(self.tracks) - 1, 3))

    def rowCount(self, parent=QModelIndex()):
        return 0 if parent.isValid() else len(self.tracks)

    def columnCount(self, parent=QModelIndex()):
        return 4

    def headerData(self, section, orientation, role=Qt.ItemDataRole.DisplayRole):
        if role == Qt.ItemDataRole.DisplayRole and orientation == Qt.Orientation.Horizontal:
            return self.HEADERS[section]
        return None

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        track = self.tracks[index.row()]
        col = index.column()
        playing = track.key == self.playing_key
        if role == Qt.ItemDataRole.DisplayRole:
            return ["▶" if playing else str(index.row() + 1), track.artist, track.title, fmt_time(track.duration)][col]
        if role == Qt.ItemDataRole.FontRole and playing:
            font = QFont()
            font.setBold(True)
            return font
        if role == Qt.ItemDataRole.ForegroundRole and not track.url:
            return Qt.GlobalColor.gray  # трек недоступен (изъят правообладателем и т.п.)
        if role == Qt.ItemDataRole.TextAlignmentRole and col in (0, 3):
            return Qt.AlignmentFlag.AlignCenter
        if role == Qt.ItemDataRole.ToolTipRole:
            return track.name if track.url else "Трек недоступен"
        return None


# --- Главное окно -----------------------------------------------------------------------------

REPEAT_OFF, REPEAT_ALL, REPEAT_ONE = range(3)


class PlayerWindow(QMainWindow):
    SECTION_MY, SECTION_RECS, SECTION_SEARCH = "my", "recs", "search"

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
        self.statusBar().showMessage(f"Вы вошли как {session.get('name', '')}")
        self.load_section(self.SECTION_MY)
        self.load_playlists()

    # --- интерфейс ---

    def build_ui(self) -> None:
        self.setWindowTitle(APP_NAME)
        self.resize(1000, 650)
        style = self.style()

        # Левая колонка: разделы и плейлисты
        self.search_edit = QLineEdit(placeholderText="Поиск музыки…", clearButtonEnabled=True)
        self.search_edit.returnPressed.connect(self.do_search)
        self.nav = QListWidget()
        for key, title in ((self.SECTION_MY, "Моя музыка"), (self.SECTION_RECS, "Рекомендации"), (self.SECTION_SEARCH, "Поиск")):
            item = QListWidgetItem(title)
            item.setData(Qt.ItemDataRole.UserRole, key)
            self.nav.addItem(item)
        header = QListWidgetItem("Плейлисты")
        header.setFlags(Qt.ItemFlag.NoItemFlags)
        font = header.font()
        font.setBold(True)
        header.setFont(font)
        self.nav.addItem(header)
        self.nav.itemClicked.connect(self.on_nav)

        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.addWidget(self.search_edit)
        left_layout.addWidget(self.nav)

        # Таблица треков
        self.model = TrackModel()
        self.table = QTableView()
        self.table.setModel(self.model)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setShowGrid(False)
        self.table.setAlternatingRowColors(True)
        self.table.verticalHeader().hide()
        self.table.verticalHeader().setDefaultSectionSize(28)
        h = self.table.horizontalHeader()
        h.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        h.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        h.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        h.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.doubleClicked.connect(lambda index: self.play_from_view(index.row()))
        self.table.activated.connect(lambda index: self.play_from_view(index.row()))

        splitter = QSplitter()
        splitter.addWidget(left)
        splitter.addWidget(self.table)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([230, 770])

        # Нижняя панель управления
        def button(std, tip, slot, checkable=False, text=None, icon=None):
            b = QToolButton()
            if text:
                b.setText(text)
            else:
                b.setIcon(icon or style.standardIcon(std))
                b.setIconSize(QSize(22, 22))
            b.setToolTip(tip)
            b.setCheckable(checkable)
            b.setAutoRaise(True)
            b.setMinimumSize(36, 36)
            b.clicked.connect(slot)
            return b

        self.prev_btn = button(None, "Предыдущий", self.prev_track, icon=media_icon("prev"))
        self.play_btn = button(None, "Играть / пауза (пробел)", self.toggle_play, icon=media_icon("play", "#ffffff"))
        self.play_btn.setObjectName("play")
        self.play_btn.setFixedSize(44, 44)
        self.next_btn = button(None, "Следующий", self.next_track, icon=media_icon("next"))
        self.shuffle_btn = button(None, "Перемешать", self.save_settings, checkable=True, text="🔀")
        self.repeat_btn = button(None, "", self.cycle_repeat, text="🔁")

        self.title_label = QLabel("—")
        self.title_label.setMinimumWidth(200)
        self.pos_label = QLabel("0:00")
        self.dur_label = QLabel("0:00")
        self.seek = QSlider(Qt.Orientation.Horizontal)
        self.seek.sliderPressed.connect(lambda: setattr(self, "dragging", True))
        self.seek.sliderReleased.connect(self.on_seek_released)
        self.seek.sliderMoved.connect(lambda v: self.pos_label.setText(fmt_time(v // 1000)))
        self.volume = QSlider(Qt.Orientation.Horizontal)
        self.volume.setRange(0, 100)
        self.volume.setFixedWidth(110)
        self.volume.valueChanged.connect(self.on_volume)
        vol_icon = QLabel()
        vol_icon.setPixmap(style.standardIcon(QStyle.StandardPixmap.SP_MediaVolume).pixmap(18, 18))

        controls = QHBoxLayout()
        for w in (self.prev_btn, self.play_btn, self.next_btn, self.shuffle_btn, self.repeat_btn):
            controls.addWidget(w)
        controls.addSpacing(10)
        info = QVBoxLayout()
        info.addWidget(self.title_label)
        seek_row = QHBoxLayout()
        seek_row.addWidget(self.pos_label)
        seek_row.addWidget(self.seek, 1)
        seek_row.addWidget(self.dur_label)
        info.addLayout(seek_row)
        controls.addLayout(info, 1)
        controls.addSpacing(10)
        controls.addWidget(vol_icon)
        controls.addWidget(self.volume)

        central = QWidget()
        layout = QVBoxLayout(central)
        layout.addWidget(splitter, 1)
        layout.addLayout(controls)
        self.setCentralWidget(central)

        # Меню
        menu = self.menuBar().addMenu("Аккаунт")
        refresh = QAction("Обновить", self, shortcut=QKeySequence(QKeySequence.StandardKey.Refresh), triggered=self.refresh)
        logout = QAction("Выйти из аккаунта", self, triggered=self.logout)
        clear = QAction("Очистить кэш", self, triggered=self.clear_cache)
        quit_action = QAction("Закрыть", self, shortcut=QKeySequence(QKeySequence.StandardKey.Quit), triggered=self.quit)
        for a in (refresh, clear, logout):
            menu.addAction(a)
        menu.addSeparator()
        menu.addAction(quit_action)

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
        self.tray = QSystemTrayIcon(self.windowIcon() if not self.windowIcon().isNull() else style.standardIcon(QStyle.StandardPixmap.SP_MediaPlay), self)
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

    def show_normal(self) -> None:
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def restore_settings(self) -> None:
        self.volume.setValue(int(self.settings.value("volume", 70)))
        self.shuffle_btn.setChecked(self.settings.value("shuffle", "false") in (True, "true"))
        geometry = self.settings.value("geometry")
        if geometry is not None:
            self.restoreGeometry(geometry)
        self.update_repeat_button()

    def save_settings(self) -> None:
        self.settings.setValue("volume", self.volume.value())
        self.settings.setValue("shuffle", self.shuffle_btn.isChecked())
        self.settings.setValue("repeat", self.repeat)
        self.settings.setValue("geometry", self.saveGeometry())

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
        self.model.set_playing(self.current.key if self.current else None)
        self.table.scrollToTop()

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
        self.statusBar().showMessage("Загрузка…")
        self.model.set_tracks([])

        def done(tracks):
            self.sections[key] = tracks
            if self.current_nav_key() == key:
                self.show_tracks(tracks)
            self.statusBar().showMessage(f"Треков: {len(tracks)}", 4000)

        run_bg(loader, done, self.on_api_error)

    def load_playlists(self) -> None:
        def done(playlists: list[vk.Playlist]):
            while self.nav.count() > 4:
                self.nav.takeItem(4)
            for p in playlists:
                item = QListWidgetItem(f"{p.title}  ({p.count})")
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
        self.statusBar().showMessage(f"Ищу «{query}»…")

        def done(tracks):
            self.sections[self.SECTION_SEARCH] = tracks
            if self.current_nav_key() == self.SECTION_SEARCH:
                self.show_tracks(tracks)
            self.statusBar().showMessage(f"Найдено: {len(tracks)}", 4000)

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
        self.statusBar().showMessage(f"Ошибка: {error}", 8000)

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
        self.model.set_playing(track.key)
        self.title_label.setText(track.name)
        self.setWindowTitle(f"{track.name} — {APP_NAME}")
        self.tray.setToolTip(track.name)
        self.player.stop()
        self.load_generation += 1
        generation = self.load_generation

        if not track.url and not stream.cached(self.cache_dir, track.key):
            if not retried:
                self.refresh_url_and_play(index, generation)
            else:
                self.statusBar().showMessage(f"Недоступен: {track.name}", 4000)
                self.skip_unavailable(generation)
            return

        self.statusBar().showMessage(f"Загрузка: {track.name}")

        def fetch():
            return stream.download(track.url, self.cache_dir, track.key, lambda: generation != self.load_generation)

        def done(path: Path):
            if generation != self.load_generation:
                return
            self.player.setSource(QUrl.fromLocalFile(str(path)))
            self.player.play()
            self.statusBar().clearMessage()
            self.prefetch_next()
            stream.prune(self.cache_dir, CACHE_LIMIT, keep={path})

        def failed(error):
            if generation != self.load_generation or isinstance(error, stream.Cancelled):
                return
            if isinstance(error, stream.ExpiredUrl) and not retried:
                self.refresh_url_and_play(index, generation)
                return
            self.statusBar().showMessage(f"Не удалось загрузить «{track.name}»: {error}", 6000)
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
            self.statusBar().showMessage("Несколько треков подряд не загрузились. Проверьте интернет.", 10000)
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
            rows = self.table.selectionModel().selectedRows()
            if self.model.tracks:
                self.play_from_view(rows[0].row() if rows else 0)
        else:
            self.player.play()

    def cycle_repeat(self) -> None:
        self.repeat = (self.repeat + 1) % 3
        self.update_repeat_button()
        self.save_settings()

    def update_repeat_button(self) -> None:
        text, tip = {
            REPEAT_OFF: ("➡", "Повтор выключен"),
            REPEAT_ALL: ("🔁", "Повтор списка"),
            REPEAT_ONE: ("🔂", "Повтор трека"),
        }[self.repeat]
        self.repeat_btn.setText(text)
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

    def on_media_status(self, status) -> None:
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self.next_track(auto=True)

    def on_state(self, state) -> None:
        if state == QMediaPlayer.PlaybackState.PlayingState:
            self.failures = 0
        playing = state == QMediaPlayer.PlaybackState.PlayingState
        self.play_btn.setIcon(media_icon("pause" if playing else "play", "#ffffff"))

    def on_player_error(self, error, message: str) -> None:
        if error == QMediaPlayer.Error.NoError:
            return
        self.statusBar().showMessage(f"Ошибка воспроизведения: {message}", 6000)
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
        self.statusBar().showMessage("Кэш очищен", 3000)

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


DARK_STYLE = """
QWidget { background: #19191b; color: #e1e3e6; font-size: 13px; }
QLineEdit { background: #232325; border: 1px solid #363738; border-radius: 6px; padding: 6px; }
QListWidget, QTableView { background: #19191b; border: none; outline: 0; }
QTableView { alternate-background-color: #1e1e20; selection-background-color: #2b3a4f; }
QListWidget::item { padding: 6px; border-radius: 6px; }
QListWidget::item:selected { background: #2b3a4f; color: #fff; }
QHeaderView::section { background: #19191b; color: #939393; border: none; padding: 4px; }
QToolButton { border-radius: 18px; font-size: 16px; }
QToolButton:hover { background: #2a2a2c; }
QToolButton:checked { background: #2b3a4f; }
QToolButton#play { background: #447bba; border-radius: 22px; }
QToolButton#play:hover { background: #5181b8; }
QSlider::groove:horizontal { height: 4px; background: #363738; border-radius: 2px; }
QSlider::sub-page:horizontal { background: #71aaeb; border-radius: 2px; }
QSlider::handle:horizontal { background: #fff; width: 12px; margin: -4px 0; border-radius: 6px; }
QPushButton { background: #447bba; color: white; border: none; border-radius: 6px; padding: 6px 14px; }
QPushButton:hover { background: #5181b8; }
QPushButton:disabled { background: #363738; color: #777; }
QTabBar::tab { background: #232325; padding: 8px 14px; border-radius: 6px; margin: 2px; }
QTabBar::tab:selected { background: #2b3a4f; }
QTabWidget::pane { border: none; }
QMenuBar { background: #19191b; }
QMenuBar::item:selected, QMenu::item:selected { background: #2b3a4f; }
QStatusBar { color: #939393; }
"""

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
    app.setStyleSheet(DARK_STYLE)
    icon_path = Path(__file__).with_name("icon.png")
    if icon_path.exists():
        app.setWindowIcon(QIcon(str(icon_path)))
    start_app_window()
    if _window is None:
        return 0
    return app.exec()
