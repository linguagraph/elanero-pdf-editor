"""Encrypt small secrets (API keys) for the current Windows user, with DPAPI. Qt-free.

DPAPI ties the ciphertext to the Windows account, so a copied settings file is useless on
another PC or for another user. Elsewhere there is no such store: callers must keep secrets in
memory only, which :func:`can_encrypt` tells them. Nothing here logs the data it handles.

The backend is injectable (:func:`set_secret_store`) so a host without DPAPI, the web, can
supply its own. The module-level functions delegate to it, so callers never change. ``ctypes``
is imported only inside the DPAPI calls, never at import: the module must import on any
platform, the web's included.
"""

from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DESCRIPTION = "Elanero"


class SecretError(Exception):
    """The secret couldn't be encrypted or decrypted (wrong user, or damaged data)."""


class SecretStore(Protocol):
    """Encrypts bytes for storage. The module-level functions are the same operations."""

    def can_encrypt(self) -> bool: ...

    def encrypt(self, data: bytes) -> bytes:
        """Raises :class:`SecretError` when encryption isn't possible or fails."""
        ...

    def decrypt(self, data: bytes) -> bytes:
        """Raises :class:`SecretError` when the data can't be read back."""
        ...


# -- DPAPI (Windows) ----------------------------------------------------------------------------


def _dpapi_encrypt(data: bytes) -> bytes:
    if sys.platform != "win32":  # the WinDLL calls below exist only on Windows
        raise SecretError("Secrets are encrypted only on Windows; keep them in memory instead")
    import ctypes
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = (("cbData", wintypes.DWORD), ("pbData", ctypes.c_void_p))

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_Blob),
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_Blob),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL

    # The input buffer must stay referenced while the blob is in use.
    buffer = ctypes.create_string_buffer(data, max(len(data), 1))
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.c_void_p))
    result = _Blob()
    if not crypt32.CryptProtectData(
        ctypes.byref(source), DESCRIPTION, None, None, None, 0, ctypes.byref(result)
    ):
        raise SecretError(f"Windows couldn't protect the data (error {ctypes.get_last_error()})")
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree(result.pbData)


def _dpapi_decrypt(data: bytes) -> bytes:
    if sys.platform != "win32":  # the WinDLL calls below exist only on Windows
        raise SecretError("Secrets are encrypted only on Windows; keep them in memory instead")
    import ctypes
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = (("cbData", wintypes.DWORD), ("pbData", ctypes.c_void_p))

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_Blob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_Blob),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL

    buffer = ctypes.create_string_buffer(data, max(len(data), 1))
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.c_void_p))
    result = _Blob()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(result)
    ):
        raise SecretError("The stored secret can't be read by this Windows account")
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree(result.pbData)


class DpapiSecretStore:
    """Windows DPAPI: the default store. Off Windows it can't encrypt, and says so."""

    def can_encrypt(self) -> bool:
        return sys.platform == "win32"

    def encrypt(self, data: bytes) -> bytes:
        if not self.can_encrypt():
            raise SecretError("Secrets are encrypted only on Windows; keep them in memory instead")
        return _dpapi_encrypt(data)

    def decrypt(self, data: bytes) -> bytes:
        if not self.can_encrypt():
            raise SecretError("Secrets are encrypted only on Windows; keep them in memory instead")
        return _dpapi_decrypt(data)


# -- in memory ------------------------------------------------------------------------------------

_NONCE_BYTES = 12
_TAG_BYTES = 16


def _aesgcm() -> type[AESGCM] | None:
    """The AES-GCM class from ``cryptography``, or None when it isn't installed. Imported here,
    not at module level, because signing libraries load lazily (AGENTS.md)."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        return None
    return AESGCM


class MemorySecretStore:
    """Encrypts with a random key held in memory only, for tests and for hosts with no store.

    The key is made when the store is created and lives only as long as this object: data it
    encrypted can't be read by another store or after the process ends. If ``cryptography``
    isn't installed the store can't encrypt, and :meth:`can_encrypt` says so.
    """

    def __init__(self) -> None:
        aesgcm = _aesgcm()
        self._cipher: AESGCM | None = aesgcm(os.urandom(32)) if aesgcm is not None else None

    def can_encrypt(self) -> bool:
        return self._cipher is not None

    def encrypt(self, data: bytes) -> bytes:
        if self._cipher is None:
            raise SecretError("Encryption needs the cryptography package, which is not installed")
        nonce = os.urandom(_NONCE_BYTES)
        return nonce + self._cipher.encrypt(nonce, data, None)

    def decrypt(self, data: bytes) -> bytes:
        if self._cipher is None:
            raise SecretError("Encryption needs the cryptography package, which is not installed")
        if len(data) < _NONCE_BYTES + _TAG_BYTES:
            raise SecretError("The stored secret is damaged")
        try:
            plain: bytes = self._cipher.decrypt(data[:_NONCE_BYTES], data[_NONCE_BYTES:], None)
            return plain
        except Exception as exc:  # cryptography's InvalidTag; not a value to log
            raise SecretError("The stored secret can't be read by this store") from exc


# -- injection ------------------------------------------------------------------------------------

_store: SecretStore | None = None


def set_secret_store(store: SecretStore | None) -> None:
    """Use ``store`` for every encrypt/decrypt, or ``None`` to go back to the DPAPI default."""
    global _store
    _store = store


def get_secret_store() -> SecretStore:
    global _store
    if _store is None:
        _store = DpapiSecretStore()
    return _store


def can_encrypt() -> bool:
    return get_secret_store().can_encrypt()


def encrypt(data: bytes) -> bytes:
    return get_secret_store().encrypt(data)


def decrypt(data: bytes) -> bytes:
    return get_secret_store().decrypt(data)
