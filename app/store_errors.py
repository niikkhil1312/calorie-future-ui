"""Storage-agnostic errors shared by the store backends."""


class DuplicateEmail(Exception):
    """An account with this email already exists."""


class StorageError(Exception):
    """The storage backend failed or returned an unexpected response."""
