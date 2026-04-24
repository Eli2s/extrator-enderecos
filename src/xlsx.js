import writeXlsxFile from "write-excel-file/node";

export async function generateXlsxBuffer(colunas, linhas) {
  const header = colunas.map(col => ({ value: col, fontWeight: "bold" }));
  const rows = [
    header,
    ...linhas.map(row => row.map(cell => ({ value: String(cell ?? "") })))
  ];

  const result = writeXlsxFile(rows, { sheet: "Enderecos", fontFamily: "Calibri" });
  return result.toBuffer ? result.toBuffer() : result;
}
