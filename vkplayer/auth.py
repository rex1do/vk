"""Окно входа во ВКонтакте."""

from __future__ import annotations

from typing import Optional

import shiboken6
from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QDesktopServices, QGuiApplication, QPixmap
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from . import vk

try:
    from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineScript
    from PySide6.QtWebEngineWidgets import QWebEngineView

    HAS_WEBENGINE = True
except ImportError:  # pragma: no cover
    HAS_WEBENGINE = False


# Перехватываем ответ captchaNotRobot.check, в нём лежит success_token
_CAPTCHA_HOOK = """
(function () {
  const grab = (d) => { try { if (d && d.response && d.response.success_token)
      window.__vkSuccessToken = d.response.success_token; } catch (e) {} };
  const f = window.fetch;
  window.fetch = async function (...a) {
    const r = await f.apply(this, a);
    r.clone().json().then(grab).catch(() => {});
    return r;
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () { try { grab(JSON.parse(this.responseText)); } catch (e) {} });
    return send.apply(this, a);
  };
})();
"""


class WebDialog(QDialog):
    """Встроенное окно со страницей ВК (без внешнего браузера)."""

    def __init__(self, url: str, title: str, parent=None, inject: Optional[str] = None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(520, 680)
        self.result_value: Optional[dict] = None

        self.profile = QWebEngineProfile(self)  # без имени = не сохраняет cookies на диск
        if inject:
            script = QWebEngineScript()
            script.setSourceCode(inject)
            script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
            script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            script.setRunsOnSubFrames(True)
            self.profile.scripts().insert(script)
        self.view = QWebEngineView(self)
        self.page = QWebEnginePage(self.profile, self.view)
        self.view.setPage(self.page)
        self.view.urlChanged.connect(self.on_url)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.view)
        self.view.load(QUrl(url))

    def on_url(self, url: QUrl) -> None:
        pass

    def finish_later(self, accepted: bool) -> None:
        # Закрываем не изнутри сигнала самой страницы
        QTimer.singleShot(0, self.accept if accepted else self.reject)

    def done(self, code: int) -> None:
        # Страница должна быть удалена раньше профиля, иначе WebEngine ругается при выходе
        if self.view is not None:
            view, self.view, self.page = self.view, None, None
            shiboken6.delete(view)  # вместе с ней удаляется и дочерняя страница
        super().done(code)


class OAuthDialog(WebDialog):
    def __init__(self, parent=None):
        super().__init__(vk.oauth_url(vk.KATE), "Вход во ВКонтакте", parent)

    def on_url(self, url: QUrl) -> None:
        if self.result_value is not None:
            return
        text = url.toString()
        if not text.startswith(vk.OAUTH_REDIRECT):
            return
        values = vk.parse_token_url(text)
        if values:
            self.result_value = values
            self.finish_later(True)
        elif "error=" in text:
            self.result_value = {}
            QMessageBox.warning(self, "Вход", "ВК отказал во входе:\n" + text.split("#", 1)[-1])
            self.finish_later(False)


class CaptchaDialog(WebDialog):
    def __init__(self, url: str, parent=None):
        super().__init__(url, "Подтвердите, что вы не робот", parent, inject=_CAPTCHA_HOOK)
        self.timer = QTimer(self, interval=500, timeout=self.poll)
        self.timer.start()

    def poll(self) -> None:
        if self.page is not None:
            self.page.runJavaScript("window.__vkSuccessToken || null", 0, self.got)

    def got(self, token) -> None:
        if token and self.result_value is None:
            self.result_value = {"success_token": token}
            self.timer.stop()
            self.finish_later(True)


class LoginDialog(QDialog):
    """После accept() в self.session лежит {token, client, user_id}."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("VK Player — вход")
        self.setMinimumSize(500, 420)
        self.session: Optional[dict] = None

        from . import ui  # здесь, чтобы auth не зависел от ui при импорте

        logo = QLabel()
        logo.setPixmap(ui.icon_pixmap("logo", size=56))
        logo.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title = QLabel("VK Player")
        title.setStyleSheet("font-size: 22px; font-weight: 700;")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        subtitle = QLabel("Войдите во ВКонтакте, чтобы слушать свою музыку")
        subtitle.setStyleSheet(f"color: {ui.MUTED};")
        subtitle.setAlignment(Qt.AlignmentFlag.AlignCenter)

        tabs = self.tabs = QTabWidget(self)
        tabs.addTab(self._tab_browser(), "Окно ВК")
        tabs.addTab(self._tab_password(), "Логин и пароль")
        tabs.addTab(self._tab_token(), "Через браузер")
        tabs.tabBar().setExpanding(True)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(6)
        layout.addWidget(logo)
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addSpacing(14)
        layout.addWidget(tabs, 1)

    # --- вкладки ---

    def _tab_browser(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)
        info = QLabel(
            "Откроется официальная страница входа ВКонтакте прямо в программе.\n"
            "Там же работают коды подтверждения и капча."
        )
        info.setWordWrap(True)
        button = QPushButton("Войти через ВКонтакте")
        button.setMinimumHeight(40)
        button.clicked.connect(self.login_oauth)
        button.setEnabled(HAS_WEBENGINE)
        layout.addWidget(info)
        layout.addStretch()
        layout.addWidget(button)
        if not HAS_WEBENGINE:
            layout.addWidget(QLabel("Модуль QtWebEngine не установлен — используйте другие вкладки."))
        return w

    def _tab_password(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        self.login_edit = QLineEdit(placeholderText="телефон или e-mail")
        self.password_edit = QLineEdit(echoMode=QLineEdit.EchoMode.Password)
        self.password_edit.returnPressed.connect(self.login_password)
        button = QPushButton("Войти")
        button.setMinimumHeight(36)
        button.clicked.connect(self.login_password)
        form.addRow("Логин:", self.login_edit)
        form.addRow("Пароль:", self.password_edit)
        form.addRow(button)
        note = QLabel("Пароль отправляется только на oauth.vk.com и нигде не сохраняется.")
        note.setWordWrap(True)
        form.addRow(note)
        return w

    def _tab_token(self) -> QWidget:
        w = QWidget()
        layout = QVBoxLayout(w)
        info = QLabel(
            "Вход без пароля — через браузер, где вы уже вошли во ВК:\n"
            "1. Нажмите кнопку ниже и в браузере нажмите «Разрешить».\n"
            "2. Скопируйте адрес открывшейся страницы целиком\n"
            "    (https://oauth.vk.com/blank.html#access_token=…).\n"
            "3. Вставьте его в поле и нажмите OK."
        )
        info.setWordWrap(True)
        open_button = QPushButton("Открыть страницу ВК в браузере")
        open_button.setMinimumHeight(36)
        open_button.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(vk.oauth_url(vk.KATE))))
        self.token_edit = QLineEdit(placeholderText="адрес из браузера или access_token")
        self.token_edit.returnPressed.connect(self.login_token)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok)
        buttons.accepted.connect(self.login_token)
        layout.addWidget(info)
        layout.addWidget(open_button)
        layout.addWidget(self.token_edit)
        layout.addStretch()
        layout.addWidget(buttons)
        return w

    # --- способы входа ---

    def login_oauth(self) -> None:
        dialog = OAuthDialog(self)
        if dialog.exec() and dialog.result_value:
            v = dialog.result_value
            self.finish(v["access_token"], vk.KATE, v.get("user_id"))

    def login_token(self) -> None:
        text = self.token_edit.text().strip()
        values = vk.parse_token_url(text)
        token = values["access_token"] if values else text
        if not token:
            return
        self.finish(token, vk.KATE, values.get("user_id") if values else None)

    def login_password(self) -> None:
        login = self.login_edit.text().strip()
        password = self.password_edit.text()
        if not login or not password:
            return
        client = vk.VK_ANDROID
        extra: dict = {}
        code_requested = False

        for _ in range(10):
            data = self._busy(vk.direct_auth, login, password, client, **extra)
            if "access_token" in data:
                self.finish(data["access_token"], client, data.get("user_id"))
                return

            error = data.get("error")
            description = data.get("error_description", "")
            if error == "need_validation" and (data.get("validation_sid") or data.get("validation_type")):
                if not code_requested and data.get("validation_sid"):
                    vk.request_sms_code(str(data["validation_sid"]), client)
                    code_requested = True
                hint = {
                    "2fa_app": "Код из приложения-генератора кодов:",
                    "2fa_callreset": "Последние 4 цифры номера входящего звонка:",
                }.get(data.get("validation_type"), "Код из SMS / уведомления ВК:")
                code = self._ask("Двухфакторная аутентификация", hint)
                if code is None:
                    return
                extra = {"code": code}
            elif error == "need_validation":
                QMessageBox.warning(
                    self, "Вход", "ВК требует подтверждения входа. Попробуйте вкладку «Через браузер».\n\n" + description
                )
                return
            elif error == "need_captcha":
                answer = self._captcha(data)
                if answer is None:
                    return
                extra = {**{k: v for k, v in extra.items() if k == "code"}, **answer}
            elif error == "invalid_request" and "code" in extra:
                code = self._ask("Двухфакторная аутентификация", "Неверный код. Введите ещё раз:")
                if code is None:
                    return
                extra["code"] = code
            elif error == "9;Flood control" or data.get("error_type") == "password_bruteforce_attempt":
                QMessageBox.information(
                    self,
                    "Вход",
                    "ВК временно запретил вход по паролю для этого аккаунта (защита от подбора, "
                    "снимается через несколько часов). Сам аккаунт не заблокирован.\n\n"
                    "Можно войти без пароля через браузер — откройте вкладку «Через браузер».",
                )
                self.tabs.setCurrentIndex(2)
                return
            elif error == "invalid_client":
                QMessageBox.warning(self, "Вход", "Неверный логин или пароль.")
                return
            else:
                QMessageBox.warning(self, "Вход", f"Не удалось войти: {error}\n{description}")
                return
        QMessageBox.warning(self, "Вход", "Слишком много попыток.")

    # --- помощники ---

    def _busy(self, fn, *args, **kwargs):
        QGuiApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # сеть и т.п.
            return {"error": "network", "error_description": str(e)}
        finally:
            QGuiApplication.restoreOverrideCursor()

    def _ask(self, title: str, label: str) -> Optional[str]:
        text, ok = QInputDialog.getText(self, title, label)
        return text.strip() if ok and text.strip() else None

    def _captcha(self, data: dict) -> Optional[dict]:
        if data.get("redirect_uri") and HAS_WEBENGINE:
            dialog = CaptchaDialog(data["redirect_uri"], self)
            return dialog.result_value if dialog.exec() else None
        if data.get("captcha_img"):
            dialog = QDialog(self)
            dialog.setWindowTitle("Капча")
            layout = QVBoxLayout(dialog)
            image = QLabel()
            try:
                pixmap = QPixmap()
                pixmap.loadFromData(vk.http_get(data["captcha_img"]).content)
                image.setPixmap(pixmap.scaled(260, 100, Qt.AspectRatioMode.KeepAspectRatio))
            except Exception:
                image.setText(data["captcha_img"])
            edit = QLineEdit()
            buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
            buttons.accepted.connect(dialog.accept)
            buttons.rejected.connect(dialog.reject)
            layout.addWidget(image)
            layout.addWidget(edit)
            layout.addWidget(buttons)
            if dialog.exec() and edit.text().strip():
                return {"captcha_sid": data.get("captcha_sid"), "captcha_key": edit.text().strip()}
            return None
        QMessageBox.warning(self, "Капча", "ВК запросил капчу. Попробуйте вкладку «Через браузер».")
        return None

    def finish(self, token: str, client: vk.Client, user_id=None) -> None:
        api = vk.VKClient(token, client.name)
        try:
            QGuiApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
            me = api.me()
            api.call("audio.get", count=1)  # проверяем, что токен даёт доступ к музыке
        except vk.VKError as e:
            QGuiApplication.restoreOverrideCursor()
            QMessageBox.warning(self, "Вход", f"Токен не подходит для музыки:\n{e}")
            return
        except Exception as e:
            QGuiApplication.restoreOverrideCursor()
            QMessageBox.warning(self, "Вход", f"Ошибка сети:\n{e}")
            return
        QGuiApplication.restoreOverrideCursor()
        self.session = {
            "token": token,
            "client": client.name,
            "user_id": int(me["id"]),
            "name": f"{me.get('first_name', '')} {me.get('last_name', '')}".strip(),
        }
        self.accept()
