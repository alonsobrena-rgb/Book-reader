#!/usr/bin/env python3
"""Genera un PDF de prueba largo (varias páginas, muchos párrafos)."""
import sys

def esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

def page_content(page_num):
    parts = ["BT", "/F1 13 Tf", "54 760 Td", "15 TL"]
    for i in range(12):  # 12 párrafos por página
        n = page_num * 100 + i
        parts.append(f"(Parrafo {n}: primera frase de prueba para el lector.) Tj")
        parts.append("T*")
        parts.append(f"(Segunda linea del parrafo {n} con mas contenido. "
                     f"Y una frase adicional aqui.) Tj")
        parts.append("T*")
        parts.append("T*")  # hueco entre párrafos
    parts.append("ET")
    return "\n".join(parts).encode("latin-1")

def make_pdf(path, pages=3):
    objs = []  # cada elemento es bytes del cuerpo del objeto
    # 1 Catalog, 2 Pages, 3 Font, luego por cada página: Page + Contents
    kids_ids = []
    page_objs = []
    content_objs = []
    next_id = 4
    for pg in range(pages):
        page_id = next_id; content_id = next_id + 1; next_id += 2
        kids_ids.append(page_id)
        content = page_content(pg)
        page_objs.append((page_id,
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents "
            + str(content_id).encode() + b" 0 R >>"))
        content_objs.append((content_id,
            b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"))

    # Ensambla en orden de id
    bodies = {}
    bodies[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = b"[" + b" ".join(str(k).encode() + b" 0 R" for k in kids_ids) + b"]"
    bodies[2] = b"<< /Type /Pages /Kids " + kids + b" /Count " + str(pages).encode() + b" >>"
    bodies[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    for pid, body in page_objs: bodies[pid] = body
    for cid, body in content_objs: bodies[cid] = body

    total = max(bodies.keys())
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for i in range(1, total + 1):
        offsets[i] = len(out)
        out += str(i).encode() + b" 0 obj\n" + bodies[i] + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 " + str(total + 1).encode() + b"\n0000000000 65535 f \n"
    for i in range(1, total + 1):
        out += ("%010d 00000 n \n" % offsets[i]).encode()
    out += (b"trailer\n<< /Size " + str(total + 1).encode() + b" /Root 1 0 R >>\n"
            b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF")
    with open(path, "wb") as f:
        f.write(out)
    print("PDF escrito:", path, len(out), "bytes,", pages, "paginas")

if __name__ == "__main__":
    make_pdf(sys.argv[1] if len(sys.argv) > 1 else "test.pdf",
             int(sys.argv[2]) if len(sys.argv) > 2 else 3)
