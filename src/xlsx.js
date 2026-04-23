import writeXlsxFile from "write-excel-file/node";

export async function generateXlsxBuffer(addresses) {
  const header = [
    { value: "ENDERECO", fontWeight: "bold" },
    { value: "CEP",      fontWeight: "bold" },
    { value: "BAIRRO",   fontWeight: "bold" }
  ];

  const rows = [
    header,
    ...addresses.map((item) => [
      { value: item.endereco || "" },
      { value: item.cep      || "" },
      { value: item.bairro   || "" }
    ])
  ];

  const result = writeXlsxFile(rows, {
    sheet: "Enderecos",
    fontFamily: "Calibri"
  });
  return result.toBuffer ? result.toBuffer() : result;
}
