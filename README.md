# Solicitador de Saques

Extensão Chrome (Manifest V3) para extrair registros das tabelas de poker (cash e torneio), incluindo o campo **Obs** (olhinho), em qualquer site.

## Escopo de permissões

A extensão roda em todas as páginas (`http://*/*`, `https://*/*`), mas só extrai e exibe dados quando encontra uma tabela com a estrutura esperada (colunas de Cash ou de Torneio reconhecidas). Em qualquer outra página, ela fica em segundo plano sem coletar nem mostrar nada. Isso significa que o Chrome vai pedir a permissão "Ler e alterar seus dados em todos os sites" ao instalar/carregar a extensão — é esperado, dado o objetivo de funcionar em qualquer site compatível sem precisar reconfigurar o domínio a cada vez.

## Como carregar no Chrome

1. Abra `chrome://extensions`
2. Ative **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação**
4. Selecione a pasta da extensão

## Como usar

1. Entre no site de poker (já autenticado).
2. Abra uma página com tabela de registros.
3. Clique no ícone da extensão.
4. A extensão já tenta coletar automaticamente.
5. Use os filtros (cada um é uma "caixinha" clicável: verde = ativo, vermelho = inativo):
   - 🟢 **Abertos** / 🔴 **Fechados** — só aparece quando há registros de **Cash** na página (Torneio não tem essa distinção, aparece tudo junto em "🏆 Registros")
   - **Ocultar sem Obs** / **Mostrar sem Obs** (oculta por padrão — o texto do botão já indica a ação do próximo clique)
6. Quando há registros de **Cash**, também aparece um campo **Data** ao lado do filtro de Obs. Clique nele para abrir o calendário e escolher o dia que deve aparecer no texto copiado (por padrão é a data de hoje). Essa data fica salva por site — ao voltar no mesmo site ela continua com o valor escolhido, mesmo depois de fechar o popup ou trocar de aba.
7. Clique em qualquer parte da linha (nome, saldo ou obs) para marcar/desmarcar o registro como ignorado — fica riscado e o botão **Copiar** dessa linha é desabilitado. A caixinha também funciona normalmente.
8. Clique em **Copiar** na linha desejada para copiar o texto pronto de solicitação de saque.
9. Se necessário, clique em **Coletar** para forçar nova coleta.

Se os dois filtros estiverem marcados, o popup mostra as duas tabelas separadas por divisão visual.

O valor de **Saldo Final** aparece colorido conforme o sinal: azul quando positivo, branco quando igual a 0,00, e vermelho quando negativo.

## O que a extensão coleta

Colunas exibidas no popup (somente as necessárias para o saque):

- **Nome**
- **Saldo Final**
- **Obs** (inclusive conteúdo oculto no DOM)

Internamente, cada linha também guarda `TipoRegistro` (`Cash` ou `Torneio`) e `StatusRegistro` (`Aberto` ou `Fechado`), usados para os filtros e para o texto copiado.

## Detecção de Cash x Torneio

- Por padrão, o tipo é inferido pelas colunas da tabela (ex.: presença de `BI`, `ST`, `RC`, `TC`, `JP`, `Compras`, `Saldo/Torneio` indica Torneio).
- Além disso, a extensão procura na página um texto no formato `Torneio - "Nome do Torneio"` (em títulos, `strong`, `div`, `span`, etc., ou no título da aba). Se encontrar, **todas** as tabelas suportadas daquela página passam a ser tratadas como Torneio, e o nome capturado é usado no texto copiado.

## Detecção de Aberto x Fechado

- A extensão procura, perto de cada tabela (ou dentro dela, em linhas divisórias), textos como "registros com participação encerrada"/"encerrado" (→ Fechado) ou "aberto"/"aberta" (→ Aberto).
- Também suporta tabelas únicas que misturam registros abertos e fechados separados por uma linha de rótulo dentro do próprio `<table>`.
- **Se mesmo assim o status aparecer invertido no seu site específico**, abra `content.js` e mude a constante no topo do arquivo:
  ```js
  const INVERT_STATUS_DETECTION = false; // mude para true se precisar inverter
  ```

## Texto copiado (botão "Copiar")

Ao clicar em **Copiar** em uma linha, o seguinte texto é colocado na área de transferência (sem espaços dentro do PIX). A formatação usa a sintaxe de negrito/itálico do WhatsApp (`*negrito*`, `_itálico_`).

Para Cash:
```
_*Solicitação de Saque*_
*Cash* *_DD/MM/AAAA_* 

_*Nome*_: <Nome>

_*Valor*_: <Saldo Final>

_*PIX*_: <Obs sem espaços>
```

Para Torneio:
```
_*Solicitação de Saque*_ 
*TORNEIO* 
*<Nome do Torneio>*

*_Nome:_* <Nome>

*_Valor:_* <Saldo Final>

*_PIX:_* <Obs sem espaços>
```

A data usada no Cash é a selecionada no campo **Data** do popup (por padrão, a data do dia em que o popup é aberto — veja "Persistência das preferências do popup"). O nome do jogador tem sufixos do tipo "- 1270" removidos automaticamente, e o nome do torneio é limpo de ruídos de UI do próprio site (ex.: "Cancelar", "Salvar") e de aspas sobrando.

## Estratégia para capturar Obs

1. Tenta ler diretamente do DOM (atributos como `title`, `data-*`, conteúdo oculto).
2. Se não existir no DOM, captura respostas JSON de requisições `fetch`/`XMLHttpRequest` da página e procura campos equivalentes a observação/telefone/contato para preencher o cache.

## Persistência das preferências do popup

Para não perder o que você já organizou ao trocar de aba ou fechar o popup, a extensão salva localmente (via `chrome.storage.local`, restrito à extensão):

- O estado dos filtros **Abertos**, **Fechados** e **Ocultar sem Obs**.
- Quais jogadores foram marcados como ignorados (linha riscada), identificados por Nome + Tipo de registro (+ nome do torneio, quando aplicável) — não pelo índice da linha, que muda a cada coleta.
- A **Data** usada no texto do Cash, salva por site (host da aba). Assim, se você mudar a data em um site específico, ela continua selecionada só para aquele site da próxima vez.

Isso significa que, ao reabrir o popup ou coletar novamente, os filtros e os jogadores ignorados continuam como você deixou. Nenhum dado de Saldo/PIX/Obs é salvo — apenas essas preferências de interface.

## Segurança e escopo

- Sem bypass de autenticação.
- Sem armazenamento persistente dos dados coletados (Saldo, Obs/PIX) — apenas preferências de interface (filtros e jogadores ignorados), como descrito acima.
- Permissões mínimas para o domínio configurado (`tabs`, `storage`).
