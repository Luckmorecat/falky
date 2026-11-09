"""Export the migrated database structure for PR evidence using Go and Python."""

import argparse
from collections import defaultdict
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile


def export_schema(db):
    objects = db.execute(
        "SELECT sql FROM sqlite_schema "
        "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 "
        "WHEN 'index' THEN 2 ELSE 3 END, name"
    )
    return "\n\n".join(row[0].rstrip(";") + ";" for row in objects) + "\n"


def mermaid(db):
    lines = ["erDiagram", "    %% Only declared foreign keys are shown."]
    tables = db.execute(
        "SELECT name FROM sqlite_schema "
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    for (table,) in tables:
        columns = list(db.execute("SELECT * FROM pragma_table_info(?)", (table,)))
        primary = frozenset(col["name"] for col in columns if col["pk"])
        required_columns = {col["name"] for col in columns if col["notnull"]}
        unique = [primary] if primary else []
        indexes = list(db.execute("SELECT * FROM pragma_index_list(?)", (table,)))
        # An INTEGER PRIMARY KEY aliases rowid but table_info reports notnull=0.
        if len(primary) == 1 and not any(index["origin"] == "pk" for index in indexes):
            required_columns.update(primary)
        for index in indexes:
            if index["unique"] and not index["partial"]:
                names = frozenset(
                    row["name"]
                    for row in db.execute("SELECT * FROM pragma_index_info(?)", (index["name"],))
                )
                if names and None not in names:
                    unique.append(names)

        foreign = defaultdict(list)
        for key in db.execute("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq", (table,)):
            foreign[key["id"]].append(key)
        foreign_columns = {key["from"] for keys in foreign.values() for key in keys}

        lines.append(f"    {table} {{")
        for col in columns:
            name = col["name"]
            keys = []
            if col["pk"]:
                keys.append("PK")
            if name in foreign_columns:
                keys.append("FK")
            if frozenset([name]) in unique and not col["pk"]:
                keys.append("UK")
            kind = col["type"].replace(" ", "_") or "BLOB"
            annotation = " " + ",".join(keys) if keys else ""
            nullable = ' "nullable"' if name not in required_columns else ""
            lines.append(f"        {kind} {name}{annotation}{nullable}")
        lines.append("    }")

        for keys in foreign.values():
            names = frozenset(key["from"] for key in keys)
            required = names <= required_columns
            parent = "||" if required else "|o"
            child = "o|" if any(key <= names for key in unique) else "o{"
            relation = "--" if names <= primary else ".."
            label = ", ".join(key["from"] for key in keys)
            lines.append(f'    {keys[0]["table"]} {parent}{relation}{child} {table} : "{label}"')

    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/schema"))
    args = parser.parse_args()
    server = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="falky-schema-") as temporary:
        database = Path(temporary) / "schema.db"
        environment = {key: value for key, value in os.environ.items() if not key.startswith("FALKY_")}
        environment["FALKY_DB_PATH"] = str(database)
        subprocess.run(["go", "run", "./cmd/falky", "migrate"], cwd=server, env=environment, check=True)
        with sqlite3.connect(database) as db:
            db.row_factory = sqlite3.Row
            sql = export_schema(db)
            diagram = mermaid(db)
        args.output.mkdir(parents=True, exist_ok=True)
        for name, content in [("schema.sql", sql), ("schema.mmd", diagram)]:
            path = args.output / name
            path.write_text(content, encoding="utf-8")
            print(path.resolve())


if __name__ == "__main__":
    main()
