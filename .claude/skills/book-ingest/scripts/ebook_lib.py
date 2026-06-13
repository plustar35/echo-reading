"""Compatibility shim.

Older one-off split scripts import ebook_lib.load/plain. Keep that API while
the real multi-format implementation lives in source_lib.py.
"""
from source_lib import compact_text, load, load_with_info, plain, source_text
