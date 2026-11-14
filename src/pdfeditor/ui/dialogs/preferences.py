"""Preferences dialog: a sidebar of categories, each a form."""

from __future__ import annotations

import urllib.parse

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QColor, QDesktopServices, QIcon, QPixmap, QShowEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from pdfeditor.core.secrets import SecretError
from pdfeditor.services import file_association
from pdfeditor.services.translation import (
    PRIVACY_NOTICE_URL,
    SERVICES,
    TranslationConfig,
    configuration_problem,
    make_translator,
)
from pdfeditor.services.translation.base import COMMON_LANGUAGES, TranslationError
from pdfeditor.services.translation.libretranslate import LibreTranslateTranslator, ServerLanguage
from pdfeditor.ui.color_picker import pick_color
from pdfeditor.ui.dialogs.base import FormDialog, add_row, caption, form_layout
from pdfeditor.ui.i18n import available_languages
from pdfeditor.ui.jobs import Job
from pdfeditor.ui.settings import AppSettings
from pdfeditor.ui.style.tokens import ACCENT_PRESETS, METRICS
from pdfeditor.ui.theme import theme_manager

CUSTOM = "custom"
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")  # plain http is fine only on this PC
CATEGORIES = ("General", "Appearance", "Tools", "Translation", "Performance", "Shortcuts")


def _sentence(text: str) -> str:
    """Capitalize the first letter only: brand names keep their case."""
    return text[:1].upper() + text[1:]


def _swatch(color: str) -> QIcon:
    pix = QPixmap(14, 14)
    pix.fill(QColor(color))
    return QIcon(pix)


class PreferencesDialog(FormDialog):
    def __init__(self, settings: AppSettings, parent: QWidget | None = None) -> None:
        super().__init__("Preferences", parent=parent)
        self.header_title.hide()  # the sidebar and page headings say where you are
        self.settings = settings
        self.pages = QStackedWidget(self)
        self.sidebar = QListWidget(self)
        self.sidebar.setProperty("role", "sidebar")
        self.sidebar.setAccessibleName("Preference categories")
        self.sidebar.setFixedWidth(150)
        self.page_forms: dict[str, QFormLayout] = {}
        for name in CATEGORIES:
            self.sidebar.addItem(name)
            self._add_page(name)

        # -- General
        form = self.page_forms["General"]
        self.author = QLineEdit(settings.author)
        add_row(form, "Author name:", self.author, "Shown on the comments you add.")
        self.language = QComboBox()
        self.language.addItem("System default", "")
        for code, name in available_languages().items():
            self.language.addItem(name, code)
        self.language.setCurrentIndex(max(0, self.language.findData(settings.language)))
        add_row(form, "Language:", self.language, "Takes effect after a restart.")
        self.autosave = QSpinBox()
        self.autosave.setRange(0, 60)
        self.autosave.setSuffix(" min")
        self.autosave.setSpecialValueText("Off")
        self.autosave.setValue(settings.autosave_minutes)
        add_row(
            form,
            "Save recovery copies every:",
            self.autosave,
            "Unsaved changes can be recovered if the app closes unexpectedly.",
        )
        self.single_window = QCheckBox("Open files in the window that's already running")
        self.single_window.setChecked(settings.single_window)
        add_row(
            form,
            "Windows:",
            self.single_window,
            "Off: every file you open from Explorer gets its own window. Applies to windows "
            "opened after the change.",
        )

        # PDF file association (Windows): applied at once, like the shortcut editor
        self.pdf_status = caption("")
        self.register_button = QPushButton()
        self.register_button.clicked.connect(self.toggle_registration)
        self.default_button = QPushButton("Choose Default App…")
        self.default_button.setToolTip("Opens Windows Settings ▸ Default apps")
        self.default_button.clicked.connect(self.open_default_apps)
        row = QHBoxLayout()
        row.addWidget(self.register_button)
        row.addWidget(self.default_button)
        row.addStretch()
        self.association_row = QWidget()
        column = QVBoxLayout(self.association_row)
        column.setContentsMargins(0, 0, 0, 0)
        column.addLayout(row)
        column.addWidget(self.pdf_status)
        add_row(form, "PDF files:", self.association_row)
        if file_association.is_supported():
            self._sync_association()
        else:
            form.setRowVisible(self.association_row, False)

        # -- Appearance
        form = self.page_forms["Appearance"]
        self.theme = QComboBox()
        for key, text in (("system", "Same as Windows"), ("light", "Light"), ("dark", "Dark")):
            self.theme.addItem(text, key)
        self.theme.setCurrentIndex(max(0, self.theme.findData(settings.theme)))
        add_row(form, "Theme:", self.theme)
        self.accent = QComboBox()
        self.accent.addItem(_swatch(theme_manager().system_accent), "Windows accent color", "")
        for name, color in ACCENT_PRESETS:
            self.accent.addItem(_swatch(color), name, color)
        self.accent.addItem("Custom…", CUSTOM)
        self._select_accent(settings.accent)
        self._previous_accent = self.accent.currentIndex()
        self.accent.activated.connect(self._accent_activated)
        add_row(form, "Accent color:", self.accent)
        self.menu_bar = QCheckBox("Always show the menu bar")
        self.menu_bar.setToolTip("Off: the menus are behind the ☰ button; tap Alt to open them")
        self.menu_bar.setChecked(settings.show_menu_bar)
        add_row(form, "", self.menu_bar)
        self.zoom = QComboBox()
        for key, text in (("fit_width", "Fit Width"), ("fit_page", "Fit Page"), ("100", "100%")):
            self.zoom.addItem(text, key)
        self.zoom.setCurrentIndex(max(0, self.zoom.findData(settings.default_zoom)))
        add_row(form, "Default zoom:", self.zoom, "Used when a document is opened.")

        # -- Tools
        form = self.page_forms["Tools"]
        self.tool = QComboBox()
        self.tool.addItem("Select", "select")
        self.tool.addItem("Hand", "hand")
        self.tool.setCurrentIndex(max(0, self.tool.findData(settings.default_tool)))
        add_row(form, "Default tool:", self.tool)
        self.keep_tools = QCheckBox("Keep tools selected after use")
        self.keep_tools.setToolTip("Off: comment and drawing tools go back to Select after one use")
        self.keep_tools.setChecked(settings.keep_tools)
        add_row(
            form,
            "",
            self.keep_tools,
            "Off: comment and drawing tools go back to Select after one use.",
        )
        self.mini_toolbars = QCheckBox("Show mini toolbars")
        self.mini_toolbars.setChecked(settings.show_mini_toolbars)
        add_row(
            form,
            "",
            self.mini_toolbars,
            "Small floating toolbars next to selected text, comments and pages. Their "
            "commands are also in the ribbon and the menus.",
        )
        self.ocr_when_editing = QCheckBox("Recognize text when editing scanned pages")
        self.ocr_when_editing.setChecked(settings.ocr_when_editing)
        add_row(
            form,
            "",
            self.ocr_when_editing,
            "Edit Text & Images runs OCR on scanned pages and replaces the scanned text with "
            "real text, so you can double-click a paragraph to edit it.",
        )

        # -- Translation (TR4): the same settings as the first-use notice, plus the keys
        self._build_translation(settings)

        # -- Performance
        form = self.page_forms["Performance"]
        self.cache = QSpinBox()
        self.cache.setRange(64, 4096)
        self.cache.setSingleStep(64)
        self.cache.setSuffix(" MB")
        self.cache.setValue(settings.cache_mb)
        add_row(
            form,
            "Page image cache:",
            self.cache,
            "Memory for rendered pages. Takes effect after a restart.",
        )
        self.undo_disk = QSpinBox()
        self.undo_disk.setRange(64, 65536)
        self.undo_disk.setSingleStep(256)
        self.undo_disk.setSuffix(" MB")
        self.undo_disk.setValue(settings.undo_disk_mb)
        add_row(
            form,
            "Undo history disk space:",
            self.undo_disk,
            "Snapshots that let large edits (redaction, OCR, text editing) be undone.",
        )

        # -- Shortcuts: the full editor is its own dialog (it applies changes immediately)
        form = self.page_forms["Shortcuts"]
        self.shortcuts_button = QPushButton("Customize Keyboard Shortcuts…")
        self.shortcuts_button.clicked.connect(self.open_shortcuts)
        self.shortcuts_button.setEnabled(self._shortcut_manager() is not None)
        row = QHBoxLayout()
        row.addWidget(self.shortcuts_button)
        row.addStretch()
        add_row(
            form,
            "",
            row,
            "Assign, remove or reset the keys for any command. Changes apply at once.",
        )

        body = QHBoxLayout()
        body.setSpacing(METRICS.space(5))
        body.addWidget(self.sidebar)
        body.addWidget(self.pages, 1)
        self.content.addLayout(body)
        self.sidebar.currentRowChanged.connect(self.pages.setCurrentIndex)
        self.sidebar.setCurrentRow(0)
        self.resize(640, 400)

    def _add_page(self, name: str) -> None:
        page = QWidget(self.pages)
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(METRICS.space(3))
        heading = QLabel(name, page)
        font = heading.font()
        font.setPointSizeF(font.pointSizeF() * 1.25)
        font.setBold(True)
        heading.setFont(font)
        layout.addWidget(heading)
        form = form_layout()
        layout.addLayout(form)
        layout.addStretch(1)
        self.pages.addWidget(page)
        self.page_forms[name] = form

    def show_category(self, name: str) -> None:
        self.sidebar.setCurrentRow(CATEGORIES.index(name))

    def current_category(self) -> str:
        return CATEGORIES[self.pages.currentIndex()]

    def _shortcut_manager(self) -> object | None:
        return getattr(self.parent(), "shortcuts", None)

    def open_shortcuts(self) -> None:
        from pdfeditor.ui.shortcuts import ShortcutManager, ShortcutsDialog

        manager = self._shortcut_manager()
        if isinstance(manager, ShortcutManager):
            ShortcutsDialog(manager, self).exec()

    def _sync_association(self) -> None:
        if not file_association.can_register():  # the Store package registers itself
            self.register_button.hide()
            self.default_button.setEnabled(True)
            text = (
                "Elanero is in Explorer's “Open with” list. To open PDF files with it by "
                "default, choose it as the default app in Windows Settings."
            )
        else:
            registered = file_association.is_registered()
            self.register_button.setText(
                "Remove PDF Registration" if registered else "Register as PDF Editor"
            )
            self.default_button.setEnabled(registered)
            if not registered:
                text = (
                    "Add Elanero to Explorer's “Open with” list and to Windows' default apps "
                    "for PDF files."
                )
            elif file_association.is_default():
                text = "Elanero opens PDF files, and Explorer shows them with its icon."
            else:
                text = (
                    "Registered. To open PDF files with Elanero (and show them with its "
                    "icon), choose it as the default app in Windows Settings."
                )
        for button in (self.register_button, self.default_button):
            # The style sheet's min-width would otherwise let the layout clip the text.
            button.ensurePolished()
            button.setMinimumWidth(button.sizeHint().width())
        self._fit_width()
        self.pdf_status.setText(text)

    def _fit_width(self) -> None:
        """Widen the dialog to its fields' minimum (the PDF file buttons need the most).

        FormDialog sets an explicit minimum width, so Qt won't grow the window by itself. A
        button's new minimum (a longer label) only reaches the dialog's layout level by level
        through queued layout events, and measuring before then let the buttons overlap; so
        bring every layout from the buttons' row up to the dialog up to date first."""
        widget: QWidget | None = self.association_row
        while widget is not None:
            # activate() recomputes nested layouts too (invalidate() alone doesn't reach them);
            # updateGeometry() drops the parent layout's cached copy of this widget's size.
            if (layout := widget.layout()) is not None:
                layout.invalidate()
                layout.activate()
            if widget is self:
                break
            widget.updateGeometry()
            widget = widget.parentWidget()
        needed = self.minimumSizeHint().width()
        if self.width() < needed:
            self.resize(needed, self.height())

    def showEvent(self, event: QShowEvent) -> None:
        super().showEvent(event)
        self._fit_width()  # now that the style sheet's metrics apply

    def toggle_registration(self) -> None:
        try:
            if file_association.is_registered():
                file_association.unregister()
            else:
                file_association.register()
        except OSError as exc:
            QMessageBox.warning(self, "PDF Files", f"Couldn't change the registration: {exc}")
        self._sync_association()

    def open_default_apps(self) -> None:
        QDesktopServices.openUrl(QUrl(file_association.default_apps_uri()))

    def _select_accent(self, color: str) -> None:
        index = self.accent.findData(color)
        if index < 0:  # a custom color: show it just above "Custom…"
            index = self.accent.count() - 1
            self.accent.insertItem(index, _swatch(color), color, color)
        self.accent.setCurrentIndex(index)

    def _accent_activated(self, index: int) -> None:
        if self.accent.itemData(index) == CUSTOM:
            color = pick_color(theme_manager().colors.accent, self, "Accent Color")
            if color is None:
                self.accent.setCurrentIndex(self._previous_accent)
                return
            self._select_accent(color.to_hex())
        self._previous_accent = self.accent.currentIndex()

    # -- translation -----------------------------------------------------------------------
    def _build_translation(self, settings: AppSettings) -> None:
        form = self.page_forms["Translation"]
        self.translation_enabled = QCheckBox("Translate selected text online")
        self.translation_enabled.setChecked(settings.translation_enabled)
        add_row(
            form,
            "",
            self.translation_enabled,
            "Off until you agree. Only the text you select is sent, and only when you choose "
            "Translate.",
        )
        self.translation_service = QComboBox()
        self.translation_service.setAccessibleName("Translation service")
        for service_id, name in SERVICES.items():
            self.translation_service.addItem(name, service_id)
        self.translation_service.setCurrentIndex(
            max(0, self.translation_service.findData(settings.translation_service))
        )
        self.translation_service.currentIndexChanged.connect(self._service_changed)
        add_row(form, "Service:", self.translation_service)

        # Each service's own fields sit in one group, shown only for the chosen service.
        self._service_groups: dict[str, QWidget] = {}
        self._service_forms: dict[str, QFormLayout] = {}
        self.email = QLineEdit(settings.translation_email)
        self.email.setPlaceholderText("Optional")
        self._service_group(
            "mymemory",
            "Email:",
            self.email,
            "Optional. MyMemory allows more translations a day for a registered email, which "
            "it receives with each request.",
        )
        self.deepl_key = QLineEdit(settings.translation_key("deepl"))
        self.deepl_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.deepl_key.setAccessibleName("DeepL API key")
        self._service_group(
            "deepl",
            "API key:",
            self.deepl_key,
            "Your DeepL API key. Free keys end in “:fx”. It's stored encrypted for your Windows "
            "account.",
        )
        self.libre_url = QLineEdit(settings.libretranslate_url)
        self.libre_url.setPlaceholderText("https://")
        self.libre_url.setAccessibleName("LibreTranslate server address")
        self._service_group(
            "libretranslate",
            "Server:",
            self.libre_url,
            "The address of a LibreTranslate server, yours or a public one. Only http and "
            "https work.",
        )
        self.libre_key = QLineEdit(settings.translation_key("libretranslate"))
        self.libre_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.libre_key.setAccessibleName("LibreTranslate API key")
        self._service_group(
            "libretranslate",
            "API key:",
            self.libre_key,
            "Only if the server asks for one. Stored encrypted for your Windows account.",
        )
        self.libre_warning = caption(
            "Text and key are sent unencrypted over http://. Use https:// unless the server "
            "runs on this computer."
        )
        self.libre_warning.setVisible(False)
        self._service_forms["libretranslate"].addRow(self.libre_warning)
        self.libre_url.textChanged.connect(self._update_libre_warning)
        self._update_libre_warning()
        self.azure_key = QLineEdit(settings.translation_key("azure"))
        self.azure_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.azure_key.setAccessibleName("Azure key")
        self._service_group(
            "azure",
            "Key:",
            self.azure_key,
            "Your Azure AI Translator key. Stored encrypted for your Windows account.",
        )
        self.azure_region = QLineEdit(settings.azure_region)
        self.azure_region.setPlaceholderText("e.g. westeurope; leave empty for a global resource")
        self.azure_region.setAccessibleName("Azure region")
        self._service_group(
            "azure",
            "Region:",
            self.azure_region,
            "The region of your Azure resource, if it has one.",
        )
        self._show_service_groups()

        self.target = QComboBox()
        self.target.setAccessibleName("Default target language")
        self._fill_target(str(self.translation_service.currentData()), settings.translation_target)
        add_row(
            form,
            "Default language:",
            self.target,
            "The language selected text is translated into. The bubble remembers the last one "
            "you chose.",
        )

        self.test_button = QPushButton("Test Connection")
        self.test_button.clicked.connect(self.test_connection)
        self.test_status = caption("")
        self.test_status.setAccessibleName("Connection test result")
        test_line = QHBoxLayout()
        test_line.setSpacing(METRICS.space(2))
        test_line.addWidget(self.test_button)
        test_line.addWidget(caption("Sends a short test text to the service."), 1)
        test_column = QVBoxLayout()
        test_column.setContentsMargins(0, 0, 0, 0)
        test_column.addLayout(test_line)
        test_column.addWidget(self.test_status)
        test_row = QWidget()
        test_row.setLayout(test_column)
        add_row(form, "", test_row)
        self._test_job: Job | None = None

        privacy = caption(
            "Only the selected text is sent, to the service you choose, and only when you "
            "translate. The service sees the text and your IP address. "
            f'<a href="{PRIVACY_NOTICE_URL}">What Elanero sends, and to whom</a>'
        )
        privacy.setTextFormat(Qt.TextFormat.RichText)
        privacy.setOpenExternalLinks(True)
        form.addRow("", privacy)

    def _service_group(self, service: str, label: str, field: QWidget, help_text: str) -> None:
        """Add one field of ``service`` to its group (the group is made on first use)."""
        if service not in self._service_groups:
            group = QWidget()
            group_form = form_layout(group)
            group_form.setContentsMargins(0, 0, 0, 0)
            self._service_groups[service] = group
            self._service_forms[service] = group_form
            self.page_forms["Translation"].addRow(group)
        add_row(self._service_forms[service], label, field, help_text)

    def _update_libre_warning(self, *_args: object) -> None:
        parts = urllib.parse.urlsplit(self.libre_url.text().strip())
        plain_remote = parts.scheme == "http" and parts.hostname not in LOCAL_HOSTS
        self.libre_warning.setVisible(plain_remote)

    def _show_service_groups(self) -> None:
        chosen = str(self.translation_service.currentData())
        form = self.page_forms["Translation"]
        for service, group in self._service_groups.items():
            form.setRowVisible(group, service == chosen)

    def _service_changed(self, _index: int) -> None:
        self._show_service_groups()
        self.test_status.setText("")
        # The target list belongs to the service; the current choice survives if it's offered.
        self._fill_target(
            str(self.translation_service.currentData()), str(self.target.currentData() or "")
        )

    def _fill_target(self, service_id: str, keep: str) -> None:
        """Rebuild the default-target combo for ``service_id``, selecting ``keep``. A code the
        service doesn't offer is still listed, under its own code, so it isn't silently lost."""
        offered = self._offered_languages(service_id)
        self.target.clear()
        self.target.addItem("Same as the app", "")
        for code, name in sorted(offered.items(), key=lambda item: item[1]):
            self.target.addItem(name, code)
        if keep and keep not in offered:
            self.target.addItem(keep, keep)
        self.target.setCurrentIndex(max(0, self.target.findData(keep)))

    def _offered_languages(self, service_id: str) -> dict[str, str]:
        """The languages ``service_id`` offers: a LibreTranslate server's own list (once Test
        connection has stored it for the saved address), else the service's built-in list."""
        settings = self.settings
        try:
            if service_id == "libretranslate":
                url = settings.libretranslate_url
                stored = settings.libretranslate_language_list(url)
                return LibreTranslateTranslator(url, languages=stored).languages()
            return make_translator(service_id, TranslationConfig()).languages()
        except TranslationError:
            return dict(COMMON_LANGUAGES)

    def _config_from_fields(self) -> TranslationConfig:
        url = self.libre_url.text().strip()
        return TranslationConfig(
            mymemory_email=self.email.text().strip(),
            deepl_key=self.deepl_key.text().strip(),
            libretranslate_url=url,
            libretranslate_key=self.libre_key.text().strip(),
            libretranslate_languages=self.settings.libretranslate_language_list(url),
            azure_key=self.azure_key.text().strip(),
            azure_region=self.azure_region.text().strip(),
        )

    def test_connection(self) -> None:
        """Try the chosen service with the values on this page (not the saved ones)."""
        if self._test_job is not None:
            return
        try:
            translator = make_translator(
                str(self.translation_service.currentData()), self._config_from_fields()
            )
        except TranslationError as exc:
            self.test_status.setText(exc.message)
            return

        def work(job: Job) -> tuple[bool, str, list[ServerLanguage] | None, str]:
            try:
                translator.test_connection(job.token)
            except TranslationError as exc:
                return False, exc.message, None, ""
            if not isinstance(translator, LibreTranslateTranslator):
                return True, "Connected. The service answered.", None, ""
            # The server's language list is a bonus: if it can't be read, the test still passes.
            try:
                languages: list[ServerLanguage] | None = translator.fetch_languages(job.token)
            except TranslationError:
                languages = None
            return True, "Connected. The service answered.", languages, translator.base_url

        job = Job(work, label="Test translation service")
        job.finished.connect(self._on_test_done)  # bound methods: dropped with the dialog
        job.failed.connect(self._on_test_failed)
        self._test_job = job
        self.test_button.setEnabled(False)
        self.test_status.setText("Testing…")
        job.start()

    def _on_test_done(self, outcome: object) -> None:
        if self._test_job is None:
            return  # cancelled when the dialog closed
        self._test_job = None
        self.test_button.setEnabled(True)
        if not isinstance(outcome, tuple) or len(outcome) != 4:
            self.test_status.setText("The test failed. Try again.")
            return
        ok, message, languages, address = outcome
        if ok and languages and address:
            # Kept with the address it came from; a failed fetch never reaches here.
            self.settings.store_libretranslate_languages(str(address), list(languages))
        self.test_status.setText(str(message))

    def _on_test_failed(self, _message: str) -> None:
        self._on_test_done(None)

    def done(self, result: int) -> None:
        if self._test_job is not None:
            self._test_job.cancel()
            self._test_job = None
        super().done(result)

    def accept(self) -> None:
        """Save every setting. A translation problem never blocks the rest: translation is
        left off, the reason is said once, and the other preferences are saved all the same."""
        service = str(self.translation_service.currentData())
        config = self._config_from_fields()
        problems: list[str] = []  # why translation is left off
        notes: list[str] = []  # a key that couldn't be saved (its old value is kept)
        identity = ""
        if self.translation_enabled.isChecked():
            problem = configuration_problem(service, config)
            if problem:
                problems.append(problem)
            else:
                identity = make_translator(service, config).cache_id
        keys = {
            "deepl": ("DeepL", self.deepl_key.text().strip()),
            "libretranslate": ("LibreTranslate", self.libre_key.text().strip()),
            "azure": ("Azure", self.azure_key.text().strip()),
        }
        # Each key is encrypted once, here, so a failure can only happen before anything is saved.
        to_save: dict[str, str] = {}  # name -> the stored form
        for name, (label, value) in keys.items():
            try:
                sealed = self.settings.sealed_translation_key(value)
            except SecretError:
                notes.append(f"the {label} key couldn't be saved, so the old key is kept")
                if name == service and identity:
                    problems.append(f"the {label} key couldn't be saved")
                    identity = ""
                continue
            to_save[name] = sealed
        translation_on = bool(identity) and not problems

        s = self.settings
        s.author = self.author.text().strip()
        s.default_zoom = str(self.zoom.currentData())
        s.default_tool = str(self.tool.currentData())
        s.keep_tools = self.keep_tools.isChecked()
        s.show_mini_toolbars = self.mini_toolbars.isChecked()
        s.ocr_when_editing = self.ocr_when_editing.isChecked()
        s.language = str(self.language.currentData())
        s.theme = str(self.theme.currentData())
        s.show_menu_bar = self.menu_bar.isChecked()
        accent = self.accent.currentData()
        s.accent = accent if isinstance(accent, str) and accent != CUSTOM else ""
        s.autosave_minutes = self.autosave.value()
        s.single_window = self.single_window.isChecked()
        s.undo_disk_mb = self.undo_disk.value()
        s.cache_mb = self.cache.value()
        # The translation settings that are valid are saved; the switch only goes on when the
        # configuration is complete, and switching on is the consent for this service.
        s.translation_enabled = translation_on
        if translation_on:
            s.translation_consented = identity
        s.translation_service = service
        s.translation_email = self.email.text()
        s.libretranslate_url = self.libre_url.text()
        s.azure_region = self.azure_region.text()
        s.translation_target = str(self.target.currentData() or "")
        for name, sealed in to_save.items():
            s.store_sealed_translation_key(name, sealed)  # cannot fail: nothing to encrypt
        if problems:
            QMessageBox.information(
                self,
                "Translation",
                f"Translation was left off: {'; '.join(problems)}. "
                "Your other preferences were saved.",
            )
        elif notes:
            QMessageBox.information(
                self,
                "Translation",
                f"{_sentence('; '.join(notes))}. Your other preferences were saved.",
            )
        super().accept()
