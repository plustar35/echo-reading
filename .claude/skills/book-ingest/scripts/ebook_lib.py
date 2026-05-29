"""电子书归一化层 —— 把任意 epub / mobi 解成同一个内部模型。

这是 book-ingest skill 里**确定性的脏活**:解包、抽纯文本、读 TOC。
它故意不做任何"怎么切章"的判断 —— 那是每本书不同、要当场决定的事,
由一次性脚本调用本模块后自己实现。

内部模型:
    title          str          元数据里的书名(常常不可靠,仅供参考)
    docs           [(id, html)] 按 spine / 阅读顺序排列的文档,每个是一段 HTML
    toc            [(label, doc, anchor)]
                                扁平化后的目录;anchor 可能为 None

两个入口:
    load(path) -> (title, docs, toc)
    plain(html) -> [str]   把一段 HTML 抽成去空行的纯文本行
"""
import os
import sys


def _need(mod, hint):
    try:
        return __import__(mod)
    except ImportError:
        sys.exit(f"缺依赖 {mod}。安装:{hint}")


def plain(html):
    """HTML -> 去空行的纯文本行列表。"""
    from bs4 import BeautifulSoup
    text = BeautifulSoup(html, "html.parser").get_text("\n")
    return [ln.strip() for ln in text.split("\n") if ln.strip()]


def _load_epub(path):
    _need("ebooklib", "pip install EbookLib beautifulsoup4")
    import ebooklib
    from ebooklib import epub

    book = epub.read_epub(path)

    title = ""
    md = book.get_metadata("DC", "title")
    if md:
        title = md[0][0]

    # 按 spine 顺序取文档;spine 缺失时退回所有文档项
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
                sec, children = t
                walk(children)
            else:
                href = t.href or ""
                doc = href.split("#")[0]
                anchor = href.split("#")[1] if "#" in href else None
                toc.append((t.title, doc, anchor))

    walk(book.toc)
    return title, docs, toc


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
                if f == "book.html" or html_path is None:
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

    return title, docs, toc


def load(path):
    """epub / mobi -> (title, docs, toc)。"""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".epub":
        return _load_epub(path)
    if ext in (".mobi", ".azw", ".azw3", ".prc"):
        return _load_mobi(path)
    sys.exit(f"不支持的格式 {ext}(目前支持 .epub / .mobi/.azw/.azw3/.prc)")
