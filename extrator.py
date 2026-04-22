"""
Extrai endereços de listas de entrega em PDF.
Uso: python extrator.py <arquivo.pdf>
Gera: <arquivo>.txt e <arquivo>.xlsx
"""

import sys
import re
from pathlib import Path

import pdfplumber
import openpyxl


def limpar_cep(cep: str) -> str:
    return re.sub(r"\D", "", str(cep))


def extrair_enderecos(pdf_path: str) -> list[str]:
    enderecos = []

    with pdfplumber.open(pdf_path) as pdf:
        for pagina in pdf.pages:
            tabelas = pagina.extract_tables()
            for tabela in tabelas:
                for linha in tabela:
                    if not linha:
                        continue

                    # Ignora cabeçalhos
                    linha_str = " ".join(str(c) for c in linha if c).upper()
                    if "ENDEREÇO" in linha_str or "DESTINATÁRIO" in linha_str or "SEQ" in linha_str:
                        continue

                    # Tenta identificar colunas pelo conteúdo:
                    # layout esperado: SEQ | Código | Destinatário | Endereço | Bairro | CEP
                    endereco = bairro = cep = None

                    colunas = [str(c).strip() if c else "" for c in linha]

                    # Busca CEP (8 dígitos) em qualquer coluna
                    for i, col in enumerate(colunas):
                        digitos = re.sub(r"\D", "", col)
                        if len(digitos) == 8:
                            cep = digitos
                            # Endereço costuma estar 2 colunas antes do CEP,
                            # bairro 1 coluna antes
                            if i >= 2:
                                endereco = colunas[i - 2].strip()
                                bairro   = colunas[i - 1].strip()
                            break

                    if endereco and cep and bairro:
                        enderecos.append(f"{endereco}, {cep}, {bairro}")

    return enderecos


def salvar_txt(enderecos: list[str], caminho: Path) -> None:
    caminho.write_text("\n".join(enderecos), encoding="utf-8")


def salvar_xlsx(enderecos: list[str], caminho: Path) -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Endereços"
    ws.append(["ENDEREÇO", "CEP", "BAIRRO"])
    for linha in enderecos:
        partes = [p.strip() for p in linha.split(",", 2)]
        ws.append(partes if len(partes) == 3 else [linha, "", ""])
    wb.save(caminho)


def main() -> None:
    if len(sys.argv) < 2:
        print("Uso: python extrator.py <arquivo.pdf>")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"Arquivo não encontrado: {pdf_path}")
        sys.exit(1)

    print(f"Lendo {pdf_path.name}...")
    enderecos = extrair_enderecos(str(pdf_path))

    if not enderecos:
        print("Nenhum endereço encontrado. Verifique se o PDF tem tabelas com as colunas: Endereço, Bairro, CEP.")
        sys.exit(1)

    base = pdf_path.with_suffix("")
    txt_path  = base.with_suffix(".txt")
    xlsx_path = base.with_suffix(".xlsx")

    salvar_txt(enderecos, txt_path)
    salvar_xlsx(enderecos, xlsx_path)

    print(f"{len(enderecos)} endereços extraídos.")
    print(f"  → {txt_path}")
    print(f"  → {xlsx_path}")

    print("\nPrimeiros 5:")
    for e in enderecos[:5]:
        print(f"  {e}")


if __name__ == "__main__":
    main()
