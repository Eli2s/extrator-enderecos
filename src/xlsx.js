import writeXlsxFile from "write-excel-file/node";

export async function generateXlsxBuffer(addresses) {
  const schema = [
    { column: "ENDERECO", type: String, value: (item) => item.endereco || "" },
    { column: "CEP", type: String, value: (item) => item.cep || "" },
    { column: "BAIRRO", type: String, value: (item) => item.bairro || "" }
  ];

  return writeXlsxFile(addresses, {
    schema,
    buffer: true,
    sheet: "Enderecos",
    fontFamily: "Calibri"
  });
}
