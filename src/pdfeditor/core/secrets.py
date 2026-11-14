"""Encrypt small secrets (API keys) for the current Windows user, with DPAPI. Qt-free.

DPAPI ties the ciphertext to the Windows account, so a copied settings file is useless on
another PC or for another user. Elsewhere there is no such store: callers must keep secrets in
memory only, which :func:`can_encrypt` tells them. Nothing here logs the data it handles.
"""

from __future__ import annotations

import sys

DESCRIPTION = "Elanero"


class SecretError(Exception):
    """The secret couldn't be encrypted or decrypted (wrong user, or damaged data)."""


def can_encrypt() -> bool:
    return sys.platform == "win32"


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = (("cbData", wintypes.DWORD), ("pbData", ctypes.c_void_p))

    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_Blob),
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_Blob),
    ]
    _crypt32.CryptProtectData.restype = wintypes.BOOL
    _crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_Blob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_Blob),
    ]
    _crypt32.CryptUnprotectData.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel32.LocalFree.restype = ctypes.c_void_p

    def _input(data: bytes) -> tuple[_Blob, ctypes.Array[ctypes.c_char]]:
        # The returned buffer must stay referenced while the blob is in use.
        buffer = ctypes.create_string_buffer(data, max(len(data), 1))
        return _Blob(len(data), ctypes.cast(buffer, ctypes.c_void_p)), buffer

    def _output(blob: _Blob) -> bytes:
        """Copy a DPAPI result out, then free the buffer Windows allocated for it."""
        try:
            return ctypes.string_at(blob.pbData, blob.cbData)
        finally:
            _kernel32.LocalFree(blob.pbData)

    def encrypt(data: bytes) -> bytes:
        source, _keep = _input(data)
        result = _Blob()
        if not _crypt32.CryptProtectData(
            ctypes.byref(source), DESCRIPTION, None, None, None, 0, ctypes.byref(result)
        ):
            raise SecretError(
                f"Windows couldn't protect the data (error {ctypes.get_last_error()})"
            )
        return _output(result)

    def decrypt(data: bytes) -> bytes:
        source, _keep = _input(data)
        result = _Blob()
        if not _crypt32.CryptUnprotectData(
            ctypes.byref(source), None, None, None, None, 0, ctypes.byref(result)
        ):
            raise SecretError("The stored secret can't be read by this Windows account")
        return _output(result)

else:

    def encrypt(data: bytes) -> bytes:
        raise SecretError("Secrets are encrypted only on Windows; keep them in memory instead")

    def decrypt(data: bytes) -> bytes:
        raise SecretError("Secrets are encrypted only on Windows; keep them in memory instead")
