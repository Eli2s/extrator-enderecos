# Extrator de Endereços — Listas GAN

Fiz esse projeto porque preciso extrair endereços de listas de entrega em PDF toda semana. Em vez de ficar copiando linha por linha, subi um painel web onde é só arrastar o PDF e já vem o arquivo pronto pra usar.

Funciona com as listas no formato GAN (Franquia), mas o parser de colunas se adapta automaticamente ao layout de cada arquivo.

---

## O que faz

- Lê o PDF da lista de entregas
- Extrai as colunas **Endereço**, **CEP** e **Bairro** automaticamente
- Exibe tudo em tabela na tela
- Deixa baixar em **Excel (.xlsx)** ou **Texto (.txt)**

---

## Como rodar localmente

Instala as dependências:

```bash
pip install -r requirements.txt
```

Roda:

```bash
python app.py
```

O navegador abre sozinho em `http://localhost:5001`.

---

## Como funciona por dentro

O PDF das listas GAN não tem tabelas reais — é texto posicional. O script usa o `pdfplumber` para extrair cada palavra com sua posição X na página, detecta onde ficam os headers "Endereço", "Bairro" e "Cep", e usa essas posições para separar as colunas linha a linha.

O truque foi perceber que os labels do cabeçalho ficam levemente deslocados para a direita em relação ao início real dos dados de cada coluna, então ajustamos as bordas com offsets medidos nos PDFs reais.

---

## Estrutura

```
app.py            — servidor Flask + lógica de extração + frontend embutido
requirements.txt  — dependências Python
```
