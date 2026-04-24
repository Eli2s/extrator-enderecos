import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

function cleanDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeTextItems(items, viewportHeight) {
  const words = [];

  for (const item of items) {
    if (!("str" in item)) {
      continue;
    }

    const text = String(item.str ?? "").trim();
    if (!text) {
      continue;
    }

    const x0 = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    const top = viewportHeight - y;
    words.push({ text, x0, top });
  }

  return words;
}

function groupWordsByLine(words) {
  const lines = new Map();

  for (const word of words) {
    const y = Math.round(word.top / 3) * 3;
    if (!lines.has(y)) {
      lines.set(y, []);
    }
    lines.get(y).push(word);
  }

  return lines;
}

function detectColumns(lines) {
  let endHeader = null;
  let bairroHeader = null;
  let cepHeader = null;

  for (const y of [...lines.keys()].sort((a, b) => a - b)) {
    const words = [...lines.get(y)].sort((a, b) => a.x0 - b.x0);
    for (const word of words) {
      const text = word.text.toLowerCase();
      if (/^endere/.test(text) && endHeader === null) {
        endHeader = word.x0;
      }
      if (text === "bairro" && bairroHeader === null) {
        bairroHeader = word.x0;
      }
      if (text === "cep" && cepHeader === null) {
        cepHeader = word.x0;
      }
    }
  }

  if (bairroHeader === null || cepHeader === null) {
    return { endereco: 250, bairro: 440, cep: 530 };
  }

  const cepXs = [];
  for (const y of [...lines.keys()].sort((a, b) => a - b)) {
    const words = [...lines.get(y)].sort((a, b) => a.x0 - b.x0);
    for (const word of words) {
      const digits = cleanDigits(word.text);
      if (digits.length === 8 && Math.abs(word.x0 - cepHeader) < 60) {
        cepXs.push(word.x0);
      }
    }
  }

  const xCep = cepXs.length ? Math.min(...cepXs) - 5 : cepHeader - 15;
  const xBairro = bairroHeader - 35;
  const xEndereco = endHeader !== null ? endHeader - 78 : xBairro * 0.6;

  return { endereco: xEndereco, bairro: xBairro, cep: xCep };
}

export async function extractAddressesFromPdfBuffer(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;
  const addresses = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const words = normalizeTextItems(textContent.items, viewport.height);
    const lines = groupWordsByLine(words);
    const columns = detectColumns(lines);

    const sortedYs = [...lines.keys()].sort((a, b) => a - b);

    for (let idx = 0; idx < sortedYs.length; idx++) {
      const y = sortedYs[idx];
      const rowWords = [...lines.get(y)].sort((a, b) => a.x0 - b.x0);

      const enderecoWords = rowWords
        .filter((word) => columns.endereco <= word.x0 && word.x0 < columns.bairro)
        .map((word) => word.text);
      let bairroWords = rowWords
        .filter((word) => columns.bairro <= word.x0 && word.x0 < columns.cep)
        .map((word) => word.text);
      let cepWords = rowWords
        .filter((word) => word.x0 >= columns.cep)
        .map((word) => word.text);

      // Endereço na linha atual mas CEP/bairro na linha seguinte (texto quebrado no PDF)
      if (cepWords.length === 0 && enderecoWords.length > 0 && idx + 1 < sortedYs.length) {
        const nextY = sortedYs[idx + 1];
        if (nextY - y <= 9) {
          const nextRow = [...lines.get(nextY)].sort((a, b) => a.x0 - b.x0);
          const nextCep = nextRow.filter((w) => w.x0 >= columns.cep).map((w) => w.text);
          if (nextCep.length > 0) {
            bairroWords = nextRow.filter((w) => columns.bairro <= w.x0 && w.x0 < columns.cep).map((w) => w.text);
            cepWords = nextCep;
            idx++;
          }
        }
      }

      // Bairro na linha adjacente (anterior ou posterior) mas CEP na linha atual
      if (cepWords.length > 0 && bairroWords.length === 0) {
        const prevY = idx > 0 ? sortedYs[idx - 1] : null;
        const nextY = idx + 1 < sortedYs.length ? sortedYs[idx + 1] : null;
        if (prevY !== null && y - prevY <= 9) {
          const prevRow = [...lines.get(prevY)].sort((a, b) => a.x0 - b.x0);
          const prevBairro = prevRow.filter((w) => columns.bairro <= w.x0 && w.x0 < columns.cep).map((w) => w.text);
          if (prevBairro.length > 0) bairroWords = prevBairro;
        }
        if (bairroWords.length === 0 && nextY !== null && nextY - y <= 9) {
          const nextRow = [...lines.get(nextY)].sort((a, b) => a.x0 - b.x0);
          const nextBairro = nextRow.filter((w) => columns.bairro <= w.x0 && w.x0 < columns.cep).map((w) => w.text);
          if (nextBairro.length > 0) bairroWords = nextBairro;
        }
      }

      const cep = cepWords.map(cleanDigits).join("");
      if (cep.length !== 8 || !/^\d{8}$/.test(cep) || enderecoWords.length === 0) {
        continue;
      }

      const endereco = enderecoWords.join(" ").trim();
      const bairro = bairroWords.join(" ").trim();
      if (endereco.toLowerCase().includes("endere") || bairro.toLowerCase().includes("bairro")) {
        continue;
      }

      addresses.push({ endereco, cep, bairro });
    }
  }

  return addresses;
}

export function generateTxtBuffer(colunas, linhas) {
  const header = colunas.join("\t");
  const rows   = linhas.map(row => row.map(c => String(c ?? "")).join("\t"));
  return Buffer.from([header, ...rows].join("\n"), "utf8");
}
