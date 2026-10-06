"""Оформление: цвета, нарисованные иконки, обложки-заглушки, отрисовка строк треков."""

from __future__ import annotations

import zlib

from PySide6.QtCore import QModelIndex, QPointF, QRectF, QSize, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontMetrics,
    QIcon,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)
from PySide6.QtWidgets import QLabel, QStyle, QStyledItemDelegate, QStyleOptionViewItem

BG = "#141414"
SIDEBAR = "#1b1b1c"
SURFACE = "#222223"
HOVER = "#262628"
SELECTED = "#2c3542"
BORDER = "#2e2e30"
TEXT = "#e1e3e6"
MUTED = "#8c8f94"
ACCENT = "#5b9cf0"
ACCENT_HOVER = "#71aaf3"

# Пары цветов для обложек-заглушек: у каждого исполнителя свой градиент
COVER_GRADIENTS = [
    ("#ff6b6b", "#c44569"),
    ("#4facfe", "#2b6cd4"),
    ("#43e97b", "#1f9d6a"),
    ("#fa709a", "#c7477e"),
    ("#f6a04d", "#d9603b"),
    ("#a18cd1", "#6a5acd"),
    ("#30cfd0", "#2a7f9e"),
    ("#f093fb", "#b450c8"),
    ("#ffd86f", "#e09b3d"),
    ("#5ee7df", "#3a9bb5"),
]


def fmt_time(seconds: int) -> str:
    seconds = max(0, int(seconds))
    if seconds >= 3600:
        return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
    return f"{seconds // 60}:{seconds % 60:02d}"


# --- Иконки -------------------------------------------------------------------------------


def icon(name: str, color: str = TEXT, size: int = 24) -> QIcon:
    return QIcon(icon_pixmap(name, color, size))


def icon_pixmap(name: str, color: str = TEXT, size: int = 24) -> QPixmap:
    """Векторные иконки в сетке 24×24, рисуются под нужный размер (чётко на любом DPI)."""
    scale = 3  # рисуем крупнее и помечаем devicePixelRatio — так иконка не мылится
    pixmap = QPixmap(size * scale, size * scale)
    pixmap.fill(Qt.GlobalColor.transparent)
    p = QPainter(pixmap)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.scale(size * scale / 24, size * scale / 24)
    c = QColor(color)
    pen = QPen(c, 2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin)
    fill = QBrush(c)

    def poly(*pts):
        path = QPainterPath(QPointF(*pts[0]))
        for pt in pts[1:]:
            path.lineTo(QPointF(*pt))
        path.closeSubpath()
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(fill)
        p.drawPath(path)

    def stroke(path: QPainterPath):
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawPath(path)

    def lines(*pts):
        path = QPainterPath(QPointF(*pts[0]))
        for pt in pts[1:]:
            path.lineTo(QPointF(*pt))
        stroke(path)

    def rrect(x, y, w, h, r=1.2):
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(fill)
        p.drawRoundedRect(QRectF(x, y, w, h), r, r)

    if name == "play":
        poly((7.5, 4.5), (19.5, 12), (7.5, 19.5))
    elif name == "pause":
        rrect(6, 4.5, 4, 15)
        rrect(14, 4.5, 4, 15)
    elif name == "next":
        poly((5, 5), (15.5, 12), (5, 19))
        rrect(16.5, 5, 2.6, 14)
    elif name == "prev":
        poly((19, 5), (8.5, 12), (19, 19))
        rrect(4.9, 5, 2.6, 14)
    elif name == "shuffle":
        a = QPainterPath(QPointF(3, 17))
        a.lineTo(6, 17)
        a.cubicTo(11, 17, 12, 7, 17, 7)
        a.lineTo(20.5, 7)
        stroke(a)
        b = QPainterPath(QPointF(3, 7))
        b.lineTo(6, 7)
        b.cubicTo(11, 7, 12, 17, 17, 17)
        b.lineTo(20.5, 17)
        stroke(b)
        lines((18, 4.5), (20.5, 7), (18, 9.5))
        lines((18, 14.5), (20.5, 17), (18, 19.5))
    elif name in ("repeat", "repeat_one"):
        a = QPainterPath(QPointF(4, 12))
        a.lineTo(4, 10.5)
        a.quadTo(4, 7, 7.5, 7)
        a.lineTo(19.5, 7)
        stroke(a)
        lines((17, 4.5), (19.5, 7), (17, 9.5))
        b = QPainterPath(QPointF(20, 12))
        b.lineTo(20, 13.5)
        b.quadTo(20, 17, 16.5, 17)
        b.lineTo(4.5, 17)
        stroke(b)
        lines((7, 14.5), (4.5, 17), (7, 19.5))
        if name == "repeat_one":
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(fill)
            p.drawEllipse(QPointF(12, 12), 3.2, 3.2)
            font = QFont()
            font.setPixelSize(5)
            font.setBold(True)
            p.setFont(font)
            p.setPen(QColor(BG))
            p.drawText(QRectF(8.8, 8.8, 6.4, 6.4), Qt.AlignmentFlag.AlignCenter, "1")
    elif name in ("volume", "volume_low", "mute"):
        poly((3.5, 9), (7.5, 9), (12.5, 4.5), (12.5, 19.5), (7.5, 15), (3.5, 15))
        if name == "mute":
            lines((16, 9.5), (21, 14.5))
            lines((21, 9.5), (16, 14.5))
        else:
            arc = QPainterPath()
            arc.arcMoveTo(QRectF(10, 8.5, 7, 7), 50)
            arc.arcTo(QRectF(10, 8.5, 7, 7), 50, -100)
            stroke(arc)
            if name == "volume":
                arc2 = QPainterPath()
                arc2.arcMoveTo(QRectF(9, 5, 12.5, 14), 55)
                arc2.arcTo(QRectF(9, 5, 12.5, 14), 55, -110)
                stroke(arc2)
    elif name == "search":
        circle = QPainterPath()
        circle.addEllipse(QPointF(10.5, 10.5), 6, 6)
        stroke(circle)
        lines((15, 15), (20, 20))
    elif name == "music":
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(fill)
        p.drawEllipse(QPointF(7, 17.5), 3, 2.6)
        p.drawEllipse(QPointF(17, 15.5), 3, 2.6)
        lines((9.8, 17.5), (9.8, 6), (19.8, 4), (19.8, 15.5))
        lines((9.8, 9.5), (19.8, 7.5))
    elif name == "sparkle":
        path = QPainterPath(QPointF(11, 3))
        path.quadTo(12, 10, 19, 11)
        path.quadTo(12, 12, 11, 19)
        path.quadTo(10, 12, 3, 11)
        path.quadTo(10, 10, 11, 3)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(fill)
        p.drawPath(path)
        small = QPainterPath(QPointF(18.5, 14.5))
        small.quadTo(19, 17, 21.5, 17.5)
        small.quadTo(19, 18, 18.5, 20.5)
        small.quadTo(18, 18, 15.5, 17.5)
        small.quadTo(18, 17, 18.5, 14.5)
        p.drawPath(small)
    elif name == "playlist":
        lines((4, 6), (16, 6))
        lines((4, 11), (16, 11))
        lines((4, 16), (11, 16))
        poly((14.5, 13.5), (20.5, 17), (14.5, 20.5))
    elif name == "more":
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(fill)
        for x in (6, 12, 18):
            p.drawEllipse(QPointF(x, 12), 1.8, 1.8)
    elif name == "logo":
        p.setPen(Qt.PenStyle.NoPen)
        gradient = QLinearGradient(0, 0, 24, 24)
        gradient.setColorAt(0, QColor("#6aa8ff"))
        gradient.setColorAt(1, QColor("#3d6fd6"))
        p.setBrush(gradient)
        p.drawRoundedRect(QRectF(0, 0, 24, 24), 7, 7)
        p.setBrush(QColor("#ffffff"))
        p.drawEllipse(QPointF(8.5, 16.5), 2.6, 2.3)
        p.drawEllipse(QPointF(16.5, 14.8), 2.6, 2.3)
        w = QPen(QColor("#ffffff"), 1.8, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin)
        p.setPen(w)
        p.setBrush(Qt.BrushStyle.NoBrush)
        path = QPainterPath(QPointF(11, 16.5))
        path.lineTo(11, 7.5)
        path.lineTo(19, 6)
        path.lineTo(19, 14.8)
        p.drawPath(path)
    p.end()
    pixmap.setDevicePixelRatio(scale)
    return pixmap


# --- Обложки-заглушки ---------------------------------------------------------------------


def initials(text: str) -> str:
    words = [w for w in text.replace("—", " ").split() if w[:1].isalnum()]
    if not words:
        return "♪"
    if len(words) == 1:
        return words[0][:1].upper()
    return (words[0][:1] + words[1][:1]).upper()


def cover_colors(seed: str) -> tuple[str, str]:
    return COVER_GRADIENTS[zlib.crc32(seed.lower().encode("utf-8")) % len(COVER_GRADIENTS)]


def paint_cover(p: QPainter, rect: QRectF, seed: str, radius: float = 6) -> None:
    top, bottom = cover_colors(seed)
    gradient = QLinearGradient(rect.topLeft(), rect.bottomRight())
    gradient.setColorAt(0, QColor(top))
    gradient.setColorAt(1, QColor(bottom))
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(gradient)
    p.drawRoundedRect(rect, radius, radius)
    font = QFont(p.font())
    font.setPixelSize(max(9, int(rect.height() * 0.36)))
    font.setBold(True)
    p.setFont(font)
    p.setPen(QColor(255, 255, 255, 235))
    p.drawText(rect, Qt.AlignmentFlag.AlignCenter, initials(seed))


def cover_pixmap(seed: str, size: int) -> QPixmap:
    scale = 2
    pixmap = QPixmap(size * scale, size * scale)
    pixmap.fill(Qt.GlobalColor.transparent)
    p = QPainter(pixmap)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.scale(scale, scale)
    if seed:
        paint_cover(p, QRectF(0, 0, size, size), seed, radius=size / 7)
    else:
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(SURFACE))
        p.drawRoundedRect(QRectF(0, 0, size, size), size / 7, size / 7)
        p.drawPixmap(QRectF(size * 0.25, size * 0.25, size * 0.5, size * 0.5), icon_pixmap("music", MUTED, size), QRectF())
    p.end()
    pixmap.setDevicePixelRatio(scale)
    return pixmap


def avatar_pixmap(name: str, size: int) -> QPixmap:
    scale = 2
    pixmap = QPixmap(size * scale, size * scale)
    pixmap.fill(Qt.GlobalColor.transparent)
    p = QPainter(pixmap)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.scale(scale, scale)
    paint_cover(p, QRectF(0, 0, size, size), name or "?", radius=size / 2)
    p.end()
    pixmap.setDevicePixelRatio(scale)
    return pixmap


# --- Подпись с многоточием ----------------------------------------------------------------


class ElidedLabel(QLabel):
    """QLabel, который обрезает длинный текст многоточием вместо растягивания окна."""

    def __init__(self, text: str = "", parent=None):
        super().__init__(parent)
        self._full = text
        self.setMinimumWidth(10)
        self.setText(text)

    def setText(self, text: str) -> None:
        self._full = text
        self.setToolTip(text)
        self._update()

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._update()

    def _update(self) -> None:
        elided = QFontMetrics(self.font()).elidedText(self._full, Qt.TextElideMode.ElideRight, max(10, self.width()))
        super().setText(elided)

    def sizeHint(self) -> QSize:
        hint = super().sizeHint()
        return QSize(min(hint.width(), 400), hint.height())


# --- Строка трека -------------------------------------------------------------------------

TRACK_ROLE = Qt.ItemDataRole.UserRole + 10


class TrackDelegate(QStyledItemDelegate):
    ROW_HEIGHT = 56

    def __init__(self, window, parent=None):
        super().__init__(parent)
        self.window = window  # нужен, чтобы знать, какой трек играет и стоит ли он на паузе

    def sizeHint(self, option, index) -> QSize:
        return QSize(200, self.ROW_HEIGHT)

    def paint(self, p: QPainter, option: QStyleOptionViewItem, index: QModelIndex) -> None:
        track = index.data(TRACK_ROLE)
        if track is None:
            return
        p.save()
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = QRectF(option.rect).adjusted(6, 2, -10, -2)
        playing = self.window.current is not None and track.key == self.window.current.key
        selected = bool(option.state & QStyle.StateFlag.State_Selected)
        hovered = bool(option.state & QStyle.StateFlag.State_MouseOver)

        if selected or hovered or playing:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(SELECTED if selected else HOVER))
            p.drawRoundedRect(rect, 8, 8)

        if not track.url:
            p.setOpacity(0.4)

        # Обложка, на играющем треке — затемнение со значком
        cover = QRectF(rect.left() + 8, rect.top() + 6, 40, 40)
        paint_cover(p, cover, track.artist or track.title, radius=6)
        if playing or hovered:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(0, 0, 0, 120))
            p.drawRoundedRect(cover, 6, 6)
            is_playing = playing and self.window.is_playing()
            name = "pause" if is_playing else "play"
            p.drawPixmap(cover.adjusted(10, 10, -10, -10), icon_pixmap(name, "#ffffff", 20), QRectF())

        # Длительность
        font = QFont(option.font)
        small = QFont(font)
        small.setPointSizeF(font.pointSizeF() * 0.92)
        p.setFont(small)
        p.setPen(QColor(MUTED))
        duration_rect = QRectF(rect.right() - 70, rect.top(), 60, rect.height())
        p.drawText(duration_rect, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, fmt_time(track.duration))

        # Название и исполнитель
        text_left = cover.right() + 14
        text_width = duration_rect.left() - text_left - 12
        title_font = QFont(font)
        title_font.setWeight(QFont.Weight.DemiBold)
        p.setFont(title_font)
        p.setPen(QColor(ACCENT if playing else TEXT))
        title = QFontMetrics(title_font).elidedText(track.title, Qt.TextElideMode.ElideRight, int(text_width))
        p.drawText(QRectF(text_left, rect.top() + 8, text_width, 20), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, title)
        p.setFont(small)
        p.setPen(QColor(MUTED))
        artist = QFontMetrics(small).elidedText(track.artist, Qt.TextElideMode.ElideRight, int(text_width))
        p.drawText(QRectF(text_left, rect.top() + 28, text_width, 18), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, artist)
        p.restore()


# --- Таблица стилей -----------------------------------------------------------------------

STYLE = f"""
* {{ outline: 0; }}
QWidget {{ background: {BG}; color: {TEXT}; }}
QToolTip {{ background: {SURFACE}; color: {TEXT}; border: 1px solid {BORDER}; padding: 4px 6px; }}

#sidebar, #sidebar QWidget {{ background: {SIDEBAR}; }}
#logo {{ font-size: 17px; font-weight: 700; }}
#caption {{ color: {MUTED}; font-size: 11px; font-weight: 600; letter-spacing: 1px; padding: 14px 12px 4px 12px; }}
#userName {{ font-weight: 600; }}
#userHint {{ color: {MUTED}; font-size: 11px; }}

QLineEdit {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 8px; padding: 7px 10px; selection-background-color: {ACCENT}; }}
QLineEdit:focus {{ border-color: {ACCENT}; }}
#sidebar QLineEdit {{ background: {SURFACE}; }}

QListWidget#nav {{ border: none; background: transparent; }}
QListWidget#nav::item {{ padding: 8px 8px; border-radius: 8px; margin: 1px 0; color: {TEXT}; }}
QListWidget#nav::item:hover {{ background: {HOVER}; }}
QListWidget#nav::item:selected {{ background: {SELECTED}; color: #ffffff; }}

QListView#tracks {{ border: none; background: {BG}; }}
#pageTitle {{ font-size: 26px; font-weight: 700; }}
#pageInfo {{ color: {MUTED}; }}
#status {{ color: {MUTED}; }}
#empty {{ color: {MUTED}; font-size: 15px; }}

#playerBar, #playerBar QWidget {{ background: {SIDEBAR}; }}
#playerBar {{ border-top: 1px solid {BORDER}; }}
#trackTitle {{ font-weight: 600; }}
#trackArtist, #time {{ color: {MUTED}; }}

QPushButton {{ background: {ACCENT}; color: #ffffff; border: none; border-radius: 10px; padding: 9px 18px; font-weight: 600; }}
QPushButton:hover {{ background: {ACCENT_HOVER}; }}
QPushButton:disabled {{ background: {SURFACE}; color: {MUTED}; }}
QPushButton#secondary {{ background: {SURFACE}; color: {TEXT}; }}
QPushButton#secondary:hover {{ background: {HOVER}; }}

QToolButton {{ border: none; border-radius: 16px; padding: 4px; background: transparent; }}
QToolButton:hover {{ background: {HOVER}; }}
QToolButton#play {{ background: #ffffff; border-radius: 20px; }}
QToolButton#play:hover {{ background: #dfe3e8; }}
QToolButton::menu-indicator {{ image: none; }}

QSlider {{ background: transparent; }}
QSlider::groove:horizontal {{ height: 4px; background: #3a3a3d; border-radius: 2px; }}
QSlider::sub-page:horizontal {{ background: {ACCENT}; border-radius: 2px; }}
QSlider::handle:horizontal {{ background: #ffffff; width: 12px; height: 12px; margin: -4px 0; border-radius: 6px; }}

QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: #3a3a3d; border-radius: 3px; min-height: 30px; }}
QScrollBar::handle:vertical:hover {{ background: #4a4a4e; }}
QScrollBar::add-line, QScrollBar::sub-line, QScrollBar::add-page, QScrollBar::sub-page {{ height: 0; background: none; }}

QMenu {{ background: {SURFACE}; border: 1px solid {BORDER}; border-radius: 8px; padding: 4px; }}
QMenu::item {{ padding: 7px 18px; border-radius: 6px; background: transparent; }}
QMenu::item:selected {{ background: {SELECTED}; }}
QMenu::separator {{ height: 1px; background: {BORDER}; margin: 4px 6px; }}

QDialog {{ background: {BG}; }}
QTabWidget::pane {{ border: none; }}
QTabBar::tab {{ background: {SURFACE}; color: {MUTED}; padding: 8px 14px; border-radius: 8px; margin: 2px; }}
QTabBar::tab:selected {{ background: {SELECTED}; color: #ffffff; }}
QMessageBox QPushButton, QDialogButtonBox QPushButton {{ min-width: 70px; border-radius: 8px; }}
"""
