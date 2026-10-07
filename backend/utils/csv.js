/**
 * Export CSV compatible Excel (France) : separateur ";", BOM UTF-8 et
 * neutralisation des cellules interpretees comme formules (=, +, -, @),
 * le contenu exporte provenant en partie de saisies d'utilisateurs anonymes.
 */
function escapeCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  if (/[";\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function toCsv(columns, rows) {
  const header = columns.map((column) => escapeCell(column.label)).join(";");
  const lines = rows.map((row) =>
    columns
      .map((column) => escapeCell(typeof column.value === "function" ? column.value(row) : row[column.key]))
      .join(";")
  );

  return `﻿${[header, ...lines].join("\r\n")}\r\n`;
}

export function sendCsv(res, fileName, columns, rows) {
  const safeName = String(fileName || "export").replace(/[^a-zA-Z0-9._-]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(toCsv(columns, rows));
}
