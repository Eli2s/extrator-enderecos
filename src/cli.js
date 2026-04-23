import fs from "node:fs/promises";
import path from "node:path";

import { extractAddressesFromPdfBuffer } from "./extractor.js";

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error("Uso: npm run extract -- caminho/do/arquivo.pdf");
    process.exit(1);
  }

  const absolutePath = path.resolve(pdfPath);
  const pdfBuffer = await fs.readFile(absolutePath);
  const addresses = await extractAddressesFromPdfBuffer(pdfBuffer);

  if (addresses.length === 0) {
    console.error("Nenhum endereco encontrado.");
    process.exit(1);
  }

  console.log(`Encontrados ${addresses.length} enderecos em ${path.basename(absolutePath)}.`);
  for (const item of addresses.slice(0, 5)) {
    console.log(`${item.endereco}, ${item.cep}, ${item.bairro}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
