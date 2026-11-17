"""The injectable secret store (W2.3). The module-level functions keep their contract (bytes in,
bytes out, SecretError on failure), so existing callers and their monkeypatches are unaffected."""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Iterator

import pytest

from pdfeditor.core import secrets
from pdfeditor.core.secrets import (
    DpapiSecretStore,
    MemorySecretStore,
    SecretError,
    get_secret_store,
    set_secret_store,
)


@pytest.fixture(autouse=True)
def _restore_default_store() -> Iterator[None]:
    yield
    set_secret_store(None)


def test_default_store_is_dpapi() -> None:
    set_secret_store(None)
    assert isinstance(get_secret_store(), DpapiSecretStore)


def test_dpapi_refuses_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    store = DpapiSecretStore()
    assert store.can_encrypt() is False
    with pytest.raises(SecretError):
        store.encrypt(b"x")
    with pytest.raises(SecretError):
        store.decrypt(b"x")


@pytest.mark.skipif(sys.platform != "win32", reason="DPAPI is Windows only")
def test_dpapi_round_trip_on_windows() -> None:
    store = DpapiSecretStore()
    sealed = store.encrypt(b"api key")
    assert sealed != b"api key"
    assert store.decrypt(sealed) == b"api key"


def test_memory_store_round_trip() -> None:
    store = MemorySecretStore()
    if not store.can_encrypt():
        pytest.skip("cryptography is not installed")
    sealed = store.encrypt(b"api key")
    assert sealed != b"api key"
    assert store.decrypt(sealed) == b"api key"


def test_memory_store_keys_differ_between_stores() -> None:
    first = MemorySecretStore()
    if not first.can_encrypt():
        pytest.skip("cryptography is not installed")
    sealed = first.encrypt(b"secret")
    with pytest.raises(SecretError):
        MemorySecretStore().decrypt(sealed)


def test_memory_store_rejects_damaged_data() -> None:
    store = MemorySecretStore()
    if not store.can_encrypt():
        pytest.skip("cryptography is not installed")
    sealed = bytearray(store.encrypt(b"secret"))
    sealed[-1] ^= 0x01
    with pytest.raises(SecretError):
        store.decrypt(bytes(sealed))
    with pytest.raises(SecretError):
        store.decrypt(b"short")


def test_memory_store_reports_no_encryption_without_cryptography(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "cryptography.hazmat.primitives.ciphers.aead", None)
    store = MemorySecretStore()
    assert store.can_encrypt() is False
    with pytest.raises(SecretError):
        store.encrypt(b"x")


def test_injected_store_is_used_by_the_module_functions() -> None:
    store = MemorySecretStore()
    if not store.can_encrypt():
        pytest.skip("cryptography is not installed")
    set_secret_store(store)
    assert get_secret_store() is store
    assert secrets.can_encrypt() is True
    sealed = secrets.encrypt(b"via module")
    assert store.decrypt(sealed) == b"via module"
    assert secrets.decrypt(sealed) == b"via module"


def test_module_functions_keep_the_monkeypatch_points(monkeypatch: pytest.MonkeyPatch) -> None:
    # ui/settings.py and the tests replace these names; they must still be the call points.
    monkeypatch.setattr(secrets, "encrypt", lambda data: b"sealed:" + data)
    assert secrets.encrypt(b"k") == b"sealed:k"


def test_module_imports_without_ctypes_windll() -> None:
    """Importing the module must not touch ctypes.windll: the web has none. Checked in a fresh
    interpreter that pretends to be Windows and has no windll, so the import can't be cached."""
    code = (
        "import ctypes, sys\n"
        "sys.platform = 'win32'\n"
        "if hasattr(ctypes, 'windll'): del ctypes.windll\n"
        "import pdfeditor.core.secrets as s\n"
        "assert s.DpapiSecretStore().can_encrypt() is True\n"
        "print('ok')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"
