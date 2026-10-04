"""Setzt eine Versionskennung an alle lokalen Verweise (?v=...), damit Browser nach einem Update
nicht alte Skripte mit neuen Seiten mischen. Vor jedem Veröffentlichen ausführen.

    python pipeline/bump_version.py            # Kennung aus Datum und Uhrzeit
    python pipeline/bump_version.py 20261004a  # feste Kennung
"""
import re
import sys
from datetime import datetime
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
PAT = re.compile(r"""(["'])((?:\./|js/|css/|data/)[\w./-]+\.(?:js|css|json))(?:\?v=[\w-]+)?\1""")


def main():
    v = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime("%Y%m%d%H%M")
    n = 0
    for f in list(WEB.glob("*.html")) + list(WEB.glob("js/*.js")):
        s = f.read_text(encoding="utf-8")
        t, k = PAT.subn(lambda m: f"{m.group(1)}{m.group(2)}?v={v}{m.group(1)}", s)
        if k:
            f.write_text(t, encoding="utf-8")
            n += k
    print(f"Version {v}: {n} Verweise")


if __name__ == "__main__":
    main()
