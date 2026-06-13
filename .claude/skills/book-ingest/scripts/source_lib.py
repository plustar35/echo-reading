"""Source normalization for book-ingest.

The loader turns supported source files into one internal model:

    load(path) -> (title, docs, toc)
    load_with_info(path) -> (title, docs, toc, info)
    plain(content) -> [str]
    source_text(path) -> str

Supported sources:
    epub, mobi/azw/azw3/prc, markdown, and text-based PDF.

PDF support is intentionally text-only. Scanned/image-only PDFs are detected
by low extracted-text coverage and should stop the ingest workflow.
"""
import os
import re
import sys


MARKDOWN_EXTS = (".md", ".markdown")
TEXT_EXTS = MARKDOWN_EXTS + (".txt",)
PDF_TEXT_PAGE_MIN_CHARS = 20
PDF_TEXT_TOTAL_MIN_CHARS = 200


def _need(mod, hint):
    try:
        return __import__(mod)
    except ImportError:
        sys.exit(f"缺依赖 {mod}。安装:{hint}")


def _need_any(mods, hint):
    for mod in mods:
        try:
            return __import__(mod)
        except ImportError:
            continue
    sys.exit(f"缺依赖 {' 或 '.join(mods)}。安装:{hint}")


def _read_text(path):
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            with open(path, encoding=enc) as fh:
                return fh.read()
        except UnicodeDecodeError:
            continue
    with open(path, encoding="utf-8", errors="ignore") as fh:
        return fh.read()


def _looks_html(text):
    head = text[:4000]
    return bool(re.search(r"<\s*(html|body|p|div|h[1-6]|span|a|section|article)\b", head, re.I))


def plain(content):
    """Return non-empty plain-text lines from HTML, Markdown, PDF text, or text."""
    text = content or ""
    if _looks_html(text):
        _need("bs4", "pip install beautifulsoup4")
        from bs4 import BeautifulSoup

        text = BeautifulSoup(text, "html.parser").get_text("\n")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return [ln.strip() for ln in text.split("\n") if ln.strip()]


def compact_text(text):
    """Normalize for coverage checks: remove whitespace and invisible noise."""
    text = text or ""
    text = text.replace("\ufeff", "").replace("\u200b", "")
    text = text.replace("\xa0", " ")
    text = re.sub(r"(?m)^#{1,6}\s*", "", text)
    text = re.sub(r"\s+", "", text)
    return text


def _load_epub(path):
    _need("ebooklib", "pip install EbookLib beautifulsoup4")
    import ebooklib
    from ebooklib import epub

    book = epub.read_epub(path)

    title = ""
    md = book.get_metadata("DC", "title")
    if md:
        title = md[0][0]

    docs = []
    for idref, _ in book.spine:
        item = book.get_item_with_id(idref)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        docs.append((item.get_name(), item.get_content().decode("utf-8", "ignore")))
    if not docs:
        for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
            docs.append((item.get_name(), item.get_content().decode("utf-8", "ignore")))

    toc = []

    def walk(items):
        for t in items:
            if isinstance(t, tuple):
                _, children = t
                walk(children)
            else:
                href = t.href or ""
                doc = href.split("#")[0]
                anchor = href.split("#")[1] if "#" in href else None
                toc.append((t.title, doc, anchor))

    walk(book.toc)
    info = {"format": "epub", "supported": True}
    return title, docs, toc, info


def _load_mobi(path):
    _need("mobi", "pip install mobi beautifulsoup4")
    import mobi
    from bs4 import BeautifulSoup

    tmpdir, _ = mobi.extract(path)

    html_path = ncx_path = opf_path = None
    for root, _, files in os.walk(tmpdir):
        for f in files:
            p = os.path.join(root, f)
            if f == "book.html" or (f.endswith(".html") and html_path is None):
                html_path = p
            if f.endswith(".ncx"):
                ncx_path = p
            if f.endswith(".opf"):
                opf_path = p

    html = ""
    if html_path:
        with open(html_path, encoding="utf-8", errors="ignore") as fh:
            html = fh.read()

    title = ""
    if opf_path:
        with open(opf_path, encoding="utf-8", errors="ignore") as fh:
            opf = BeautifulSoup(fh.read(), "xml")
        t = opf.find("title")
        if t:
            title = t.get_text().strip()

    docs = [("book.html", html)]
    toc = []
    if ncx_path:
        with open(ncx_path, encoding="utf-8", errors="ignore") as fh:
            ncx = BeautifulSoup(fh.read(), "xml")
        for n in ncx.find_all("navPoint"):
            src = n.content.get("src") if n.content else ""
            doc = src.split("#")[0]
            anchor = src.split("#")[1] if "#" in src else None
            label = n.navLabel.text.strip() if n.navLabel else ""
            toc.append((label, doc, anchor))

    info = {"format": "mobi", "supported": True}
    return title, docs, toc, info


def _load_text_source(path):
    text = _read_text(path)
    basename = os.path.basename(path)
    ext = os.path.splitext(path)[1].lower()
    fmt = "markdown" if ext in MARKDOWN_EXTS else "text"
    title = os.path.splitext(basename)[0]
    toc = []
    heading_counts = {}

    if fmt == "markdown":
        for i, line in enumerate(text.splitlines(), 1):
            m = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
            if not m:
                continue
            level = len(m.group(1))
            label = m.group(2).strip()
            if level == 1 and title == os.path.splitext(basename)[0]:
                title = label
            heading_counts[level] = heading_counts.get(level, 0) + 1
            toc.append((label, basename, f"L{i}"))

    info = {
        "format": fmt,
        "supported": True,
        "line_count": len(text.splitlines()),
        "heading_counts": heading_counts,
    }
    return title, [(basename, text)], toc, info


def _pdf_outline(reader):
    toc = []
    outlines = getattr(reader, "outline", None)
    if outlines is None:
        outlines = getattr(reader, "outlines", None)
    if not outlines:
        return toc

    def walk(items):
        for item in items:
            if isinstance(item, list):
                walk(item)
                continue
            title = getattr(item, "title", "") or str(item)
            try:
                page_no = reader.get_destination_page_number(item) + 1
                toc.append((title, f"page-{page_no:04d}", None))
            except Exception:
                toc.append((title, "", None))

    try:
        walk(outlines)
    except Exception:
        return []
    return toc


def _load_pdf(path):
    pdfmod = _need_any(["pypdf", "PyPDF2"], "pip install pypdf")
    reader = pdfmod.PdfReader(path)
    docs = []
    text_pages = 0
    text_chars = 0

    for i, page in enumerate(reader.pages, 1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        chars = len(compact_text(text))
        if chars >= PDF_TEXT_PAGE_MIN_CHARS:
            text_pages += 1
        text_chars += chars
        docs.append((f"page-{i:04d}", text))

    page_count = len(reader.pages)
    scanned = text_chars < max(PDF_TEXT_TOTAL_MIN_CHARS, page_count * PDF_TEXT_PAGE_MIN_CHARS)
    info = {
        "format": "pdf",
        "supported": not scanned,
        "page_count": page_count,
        "text_pages": text_pages,
        "text_chars": text_chars,
        "scanned": scanned,
    }
    title = os.path.splitext(os.path.basename(path))[0]
    metadata = getattr(reader, "metadata", None)
    if metadata:
        title = getattr(metadata, "title", None) or metadata.get("/Title") or title
    return title, docs, _pdf_outline(reader), info


def load_with_info(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".epub":
        return _load_epub(path)
    if ext in (".mobi", ".azw", ".azw3", ".prc"):
        return _load_mobi(path)
    if ext in TEXT_EXTS:
        return _load_text_source(path)
    if ext == ".pdf":
        return _load_pdf(path)
    sys.exit(
        f"不支持的格式 {ext}"
        "(目前支持 .epub / .mobi/.azw/.azw3/.prc / .md/.markdown / 文字型 .pdf)"
    )


def load(path):
    """Return (title, docs, toc). Exit for scanned/image-only PDFs."""
    title, docs, toc, info = load_with_info(path)
    if info.get("format") == "pdf" and info.get("scanned"):
        sys.exit("这个 PDF 基本没有可抽取文字,疑似扫描型/图片型 PDF;当前 book-ingest 暂不支持。")
    return title, docs, toc


def source_text(path):
    """Extract the source's readable text for verification."""
    _, docs, _, info = load_with_info(path)
    if info.get("format") == "pdf" and info.get("scanned"):
        return ""
    return "\n\n".join("\n".join(plain(doc)) for _, doc in docs)


def pdf_page_texts(path):
    """Return {1-based page number: plain text} for a text-based PDF."""
    _, docs, _, info = load_with_info(path)
    if info.get("format") != "pdf":
        sys.exit("pdf_page_texts 只支持 PDF")
    if info.get("scanned"):
        sys.exit("这个 PDF 基本没有可抽取文字,疑似扫描型/图片型 PDF;当前 book-ingest 暂不支持。")
    pages = {}
    for did, doc in docs:
        m = re.match(r"page-(\d+)$", did)
        if not m:
            continue
        pages[int(m.group(1))] = "\n\n".join(plain(doc))
    return pages
