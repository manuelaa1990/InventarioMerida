"""
Genera db/seed.sql a partir de la hoja INFRA del presupuesto de Excel.

Uso:
    python scripts/import-excel.py "C:\\ruta\\Presupuesto 28OCT26.xlsx"

No requiere dependencias: lee el .xlsx con la librería estándar.
"""
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
DEFAULT_XLSX = Path.home() / "Desktop" / "Presupuesto 28OCT26.xlsx"

CATEGORIAS = {
    "TER": "Terminales",
    "VAR": "Varillas",
    "ROL": "Rolineras",
    "CAP": "Capacitores",
    "BIM": "Bimetales",
    "REL": "Relojes y timers",
    "RES": "Resistencias",
    "VAL": "Válvulas",
    "FIL": "Filtros",
    "STA": "Starkit",
    "TUB": "Tubería",
    "PRO": "Protectores",
    "TEI": "Cintas",
    "JUE": "Herramientas",
    "EXT": "Herramientas",
    "PEG": "Químicos",
    "ENC": "Eléctrico",
    "ORI": "Orings",
}


def q(value: str) -> str:
    """Escapa una cadena para SQL."""
    return "'" + value.replace("'", "''") + "'"


def read_sheet(path: Path, sheet_file: str = "xl/worksheets/sheet1.xml"):
    z = zipfile.ZipFile(path)
    shared = []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    for si in root.findall(NS + "si"):
        shared.append("".join(t.text or "" for t in si.iter(NS + "t")))

    rows = []
    sheet = ET.fromstring(z.read(sheet_file))
    for row in sheet.iter(NS + "row"):
        cells = {}
        for c in row.findall(NS + "c"):
            ref = c.get("r")
            col = "".join(ch for ch in ref if ch.isalpha())
            t = c.get("t")
            v = c.find(NS + "v")
            isel = c.find(NS + "is")
            if t == "s" and v is not None:
                value = shared[int(v.text)]
            elif t == "inlineStr" and isel is not None:
                value = "".join(x.text or "" for x in isel.iter(NS + "t"))
            elif v is not None:
                value = v.text
            else:
                value = ""
            cells[col] = (value or "").strip()
        rows.append((int(row.get("r")), cells))
    return rows


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not source.exists():
        sys.exit(f"No se encontró el archivo: {source}")

    rows = read_sheet(source)
    productos = []

    for row_number, cells in rows:
        if row_number < 8:
            continue
        codigo = cells.get("B", "")
        nombre_corto = cells.get("C", "")
        descripcion = cells.get("D", "")
        presentacion = cells.get("E", "")
        stock = cells.get("F", "")
        costo = cells.get("G", "")

        if not codigo:
            continue

        nombre = nombre_corto or descripcion
        desc_extra = descripcion if nombre_corto else ""
        if not nombre:
            continue

        try:
            stock_num = float(stock) if stock else 0
        except ValueError:
            stock_num = 0
        try:
            costo_num = float(costo) if costo else 0
        except ValueError:
            costo_num = 0

        prefijo = "".join(ch for ch in codigo[:3] if ch.isalpha()).upper()
        categoria = CATEGORIAS.get(prefijo, "General")

        productos.append(
            {
                "codigo": codigo,
                "nombre": nombre,
                "descripcion": desc_extra,
                "presentacion": presentacion,
                "categoria": categoria,
                "costo": costo_num,
                "stock": stock_num,
            }
        )

    out = Path(__file__).resolve().parent.parent / "db" / "seed.sql"
    with out.open("w", encoding="utf-8", newline="\n") as f:
        f.write("-- Datos iniciales generados desde la hoja INFRA del Excel.\n")
        f.write(f"-- Archivo origen: {source.name}\n")
        f.write(f"-- Productos: {len(productos)}\n\n")
        f.write("insert into productos\n")
        f.write("  (codigo, nombre, descripcion, presentacion, categoria, costo_usd, stock, stock_minimo)\n")
        f.write("values\n")
        values = []
        for p in productos:
            values.append(
                "  ("
                + ", ".join(
                    [
                        q(p["codigo"]),
                        q(p["nombre"]),
                        q(p["descripcion"]),
                        q(p["presentacion"]),
                        q(p["categoria"]),
                        f"{p['costo']:.4f}",
                        f"{p['stock']:.3f}",
                        "3.000",
                    ]
                )
                + ")"
            )
        f.write(",\n".join(values))
        f.write("\non conflict (codigo) do nothing;\n\n")
        f.write("-- Movimiento de carga inicial para los productos con existencia.\n")
        f.write("insert into movimientos (producto_id, tipo, cantidad, motivo, referencia)\n")
        f.write("select p.id, 'inicial', p.stock, 'Carga inicial desde Excel', 'seed'\n")
        f.write("  from productos p\n where p.stock <> 0\n")
        f.write("   and not exists (select 1 from movimientos m where m.producto_id = p.id and m.referencia = 'seed')\n")
        f.write("   and p.codigo in (\n")
        codigos = ", ".join(q(p["codigo"]) for p in productos)
        f.write("  " + codigos + "\n")
        f.write(");\n")

    print(f"OK -> {out} ({len(productos)} productos)")

    # Reconstruye el archivo único para el SQL Editor de Neon.
    schema = Path(__file__).resolve().parent.parent / "db" / "schema.sql"
    setup = schema.parent / "setup.sql"
    cabecera = (
        "-- ============================================================\n"
        "--  Inventario HVAC - instalacion completa para Neon\n"
        "--  Pega TODO este archivo en el SQL Editor de Neon y ejecutalo.\n"
        f"--  Incluye: tablas, funciones, configuracion y {len(productos)} productos.\n"
        "--  Se puede ejecutar mas de una vez sin duplicar datos.\n"
        "-- ============================================================\n\n"
    )
    cuerpo = schema.read_text(encoding="utf-8")
    datos = out.read_text(encoding="utf-8")
    with setup.open("w", encoding="utf-8", newline="\n") as f:
        f.write(cabecera + cuerpo)
        f.write("\n\n-- ============================================================\n")
        f.write("--  Datos iniciales\n")
        f.write("-- ============================================================\n\n")
        f.write(datos)

    print(f"OK -> {setup} (esquema + datos en un archivo)")


if __name__ == "__main__":
    main()
