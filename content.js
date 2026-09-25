const TABLE_SELECTOR = "#table_cash_registros";
const OBS_CACHE = new Map();
const OBS_CACHE_MAX_SIZE = 4000; // evita crescimento ilimitado em sessões longas
const DEBUG = false;
let observer = null;
let latestRows = [];
let collectDebounceTimer = null;
const COLLECT_DEBOUNCE_MS = 350; // evita reprocessar a página inteira a cada micro-mutação do DOM
const SECOND_TABLE_SECTION_LABEL = "registros com participacao encerrada";

// Se no SEU site os status "Aberto"/"Fechado" aparecerem trocados mesmo depois
// desta correção, mude esta constante para `true` para inverter o resultado final.
const INVERT_STATUS_DETECTION = true;

function log(...args) {
  if (DEBUG) console.log("[PokerExtractor]", ...args);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatMoney(value) {
  const text = cleanText(value);
  if (!text) return "";
  const only = text.replace(/[^\d,.\-]/g, "");
  const num = Number(only.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(num)
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(num)
    : text;
}

function hasPhoneLike(value) {
  return /\d{2}\s?\d{4,5}-?\d{4}/.test(String(value || ""));
}

function isMeaningfulObs(value) {
  const text = cleanText(value);
  if (!text) return false;
  const normalized = normalize(text);
  return !["...", "-", "obs", "observacao", "observações", "observacoes"].includes(normalized);
}

function parseObsPayload(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const keyPriority = ["obs", "observacao", "observação", "telefone", "phone", "celular", "contato", "acao", "ação"];
    const normalizedMap = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [normalize(k), cleanText(v)]));

    for (const key of keyPriority) {
      const candidate = normalizedMap[normalize(key)];
      if (isMeaningfulObs(candidate)) return candidate;
    }

    for (const candidate of Object.values(normalizedMap)) {
      if (hasPhoneLike(candidate)) return candidate;
    }
  } catch (_) {}
  return "";
}

function getCandidateKeysFromElement(element) {
  if (!element) return [];
  const keys = [];
  const attrs = element.getAttributeNames ? element.getAttributeNames() : [];
  const allowedAttrs = new Set(["id", "data-id", "data-jogadorid", "data-playerid", "data-registroid", "data-gameid", "data-nome", "data-name"]);
  for (const attr of attrs) {
    if (!allowedAttrs.has(attr)) continue;
    const v = cleanText(element.getAttribute(attr));
    if (v) keys.push(v);
  }
  if (element.dataset) {
    for (const [datasetKey, datasetValue] of Object.entries(element.dataset)) {
      const normalizedKey = normalize(datasetKey);
      if (!["id", "jogadorid", "playerid", "registroid", "gameid", "nome", "name"].some((key) => normalizedKey.includes(key))) {
        continue;
      }
      const text = cleanText(datasetValue);
      if (text) keys.push(text);
    }
  }
  return [...new Set(keys)];
}

function buildObsLookupKeys({ elementKeys = [], registro = "", name = "", gameID = "" }) {
  const base = [...new Set(elementKeys.map(cleanText).filter(Boolean))];
  const keys = [];
  const normalizedGameID = cleanText(gameID);
  const normalizedRegistro = cleanText(registro);
  const normalizedName = cleanText(name);

  if (normalizedGameID) keys.push(`gameid:${normalizedGameID}`);
  if (normalizedName && normalizedGameID) keys.push(`nome_gameid:${normalizedName}|${normalizedGameID}`);
  if (normalizedRegistro && normalizedGameID) keys.push(`registro_gameid:${normalizedRegistro}|${normalizedGameID}`);

  for (const item of base) {
    if (normalizedGameID) keys.push(`item_gameid:${item}|${normalizedGameID}`);
  }

  for (let i = 0; i < base.length; i += 1) {
    for (let j = i + 1; j < base.length; j += 1) {
      keys.push(`pair:${base[i]}|${base[j]}`);
    }
  }

  return [...new Set(keys)];
}

function extractObsFromDomCell(cell) {
  if (!cell) return "";
  const attrCandidates = ["data-json", "title", "data-bs-original-title", "data-original-title", "data-content", "aria-label", "data-obs"];

  for (const attr of attrCandidates) {
    const value = attr === "data-json" ? parseObsPayload(cell.getAttribute(attr)) : cleanText(cell.getAttribute(attr));
    if (isMeaningfulObs(value)) return value;
  }

  const inner = cell.querySelector("[data-json],[title],[data-bs-original-title],[data-original-title],[data-content],[aria-label],[data-obs]");
  if (inner) {
    for (const attr of attrCandidates) {
      const value = attr === "data-json" ? parseObsPayload(inner.getAttribute(attr)) : cleanText(inner.getAttribute(attr));
      if (isMeaningfulObs(value)) return value;
    }
  }

  const hiddenNodes = cell.querySelectorAll(
    ".xls_show, [class*='xls_show'], [hidden], .sr-only, .visually-hidden, [style*='display:none'], [style*='visibility:hidden']"
  );
  for (const hiddenNode of hiddenNodes) {
    const hiddenText = cleanText(hiddenNode.textContent);
    if (isMeaningfulObs(hiddenText)) return hiddenText;
  }

  const text = cleanText(cell.textContent);
  return isMeaningfulObs(text) ? text : "";
}

function rememberObs(keys, obs) {
  const value = cleanText(obs);
  if (!value) return;
  for (const key of keys) {
    const normalized = normalize(key);
    if (normalized) OBS_CACHE.set(normalized, value);
  }
  // Map preserva ordem de inserção: remove as entradas mais antigas quando
  // o cache cresce demais, para não vazar memória em sessões longas.
  if (OBS_CACHE.size > OBS_CACHE_MAX_SIZE) {
    const excess = OBS_CACHE.size - OBS_CACHE_MAX_SIZE;
    const iterator = OBS_CACHE.keys();
    for (let i = 0; i < excess; i += 1) {
      const oldestKey = iterator.next().value;
      if (oldestKey === undefined) break;
      OBS_CACHE.delete(oldestKey);
    }
  }
}

function readObsFromCache(keys) {
  for (const key of keys) {
    const found = OBS_CACHE.get(normalize(key));
    if (found) return found;
  }
  return "";
}

function splitName(registro) {
  const text = cleanText(registro);
  if (!text) return "";
  return text.split(" - ")[0].trim();
}

// Remove sufixos do tipo " - 1270" que às vezes aparecem no final do nome
function stripTrailingIdSuffix(value) {
  return cleanText(String(value || "").replace(/\s*-\s*\d+\s*$/, ""));
}

function normalizeHeader(value) {
  return normalize(value).replace(/[^a-z0-9]/g, "");
}

function getHeaderInfo(table) {
  if (!table) return null;
  const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
  if (!headerRow) return null;
  const headerCells = Array.from(headerRow.querySelectorAll("th,td"));
  if (!headerCells.length) return null;

  const indexMap = {};
  headerCells.forEach((cell, index) => {
    const key = normalizeHeader(cell.textContent);
    if (!key || indexMap[key] !== undefined) return;
    indexMap[key] = index;
  });

  return { headerRow, headerCells, indexMap };
}

function findIndex(indexMap, aliases) {
  for (const alias of aliases) {
    const key = normalizeHeader(alias);
    if (indexMap[key] !== undefined) return indexMap[key];
  }
  return -1;
}

function isCashTable(indexMap) {
  const gameIDIndex = findIndex(indexMap, ["GameID"]);
  const nameIndex = findIndex(indexMap, ["Registro", "Nome"]);
  const cIndex = findIndex(indexMap, ["C"]);
  const dIndex = findIndex(indexMap, ["D"]);
  const sIndex = findIndex(indexMap, ["S"]);
  const saldoFinalIndex = findIndex(indexMap, ["Saldo/Final", "SaldoFinal", "Saldo Final"]);
  return [gameIDIndex, nameIndex, cIndex, dIndex, sIndex, saldoFinalIndex].every((idx) => idx >= 0);
}

function isTournamentTable(indexMap) {
  const nameIndex = findIndex(indexMap, ["Nome", "Registro"]);
  const saldoFinalIndex = findIndex(indexMap, ["Saldo/Final", "SaldoFinal", "Saldo Final", "Saldo/Torneio"]);
  const indicators = ["BI", "ST", "RC", "TC", "JP", "Compras", "Saldo/Torneio"];
  const hasIndicator = indicators.some((header) => findIndex(indexMap, [header]) >= 0);
  return nameIndex >= 0 && saldoFinalIndex >= 0 && hasIndicator;
}

function isSupportedTable(indexMap) {
  return isCashTable(indexMap) || isTournamentTable(indexMap);
}

function detectTableType(indexMap) {
  if (isTournamentTable(indexMap)) return "Torneio";
  if (isCashTable(indexMap)) return "Cash";
  return "Desconhecido";
}

// Remove ruídos de UI (botões de edição do próprio site, tipo "Cancelar"/"Salvar")
// que às vezes ficam colados no início do nome do torneio, e também aspas sobrando.
function cleanTournamentName(raw) {
  let name = cleanText(raw);
  const noiseWords = ["cancelar", "salvar", "editar", "excluir", "remover", "confirmar", "fechar"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of noiseWords) {
      const re = new RegExp(`^${word}\\s*`, "i");
      if (re.test(name)) {
        name = name.replace(re, "");
        changed = true;
      }
    }
  }
  name = name.replace(/^["'“”\-–—:\s]+/, "").replace(/["'“”\s]+$/, "");
  return name.trim();
}

// Procura no cabeçalho da página um texto do tipo: Torneio - "Nome do Torneio"
// Se encontrado, TODAS as tabelas suportadas nessa página são tratadas como Torneio,
// e o nome capturado fica disponível em cada linha (campo TorneioNome).
function detectPageTournamentName() {
  const regex = /torneio\s*[-–—:]\s*["'“]?([^"'”\n]{2,80})/i;
  const candidates = document.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,strong,b,legend,label,span,div,p,caption"
  );

  for (const el of candidates) {
    if (el.children && el.children.length > 3) continue; // evita containers grandes
    const text = cleanText(el.textContent);
    if (!text || text.length > 200) continue;
    const match = text.match(regex);
    if (match) {
      const name = cleanTournamentName(match[1]);
      if (name) return name;
    }
  }

  const titleMatch = cleanText(document.title).match(regex);
  if (titleMatch) {
    const name = cleanTournamentName(titleMatch[1]);
    if (name) return name;
  }

  return "";
}

function applyStatusInversionIfNeeded(status) {
  if (!INVERT_STATUS_DETECTION) return status;
  return status === "Fechado" ? "Aberto" : "Fechado";
}

function detectStatusFromContext(table) {
  const candidates = [
    table.previousElementSibling,
    table.parentElement?.previousElementSibling,
    table.closest("section,article,fieldset,div")?.previousElementSibling,
    table.closest("section,article,fieldset,div")?.parentElement?.previousElementSibling
  ];
  for (const node of candidates) {
    const text = normalize(node?.textContent || "");
    if (!text) continue;
    if (text.includes(SECOND_TABLE_SECTION_LABEL) || text.includes("encerrad")) return "Fechado";
    if (text.includes("abert")) return "Aberto";
  }
  return "Aberto";
}

// Deteta se uma linha da tabela é, na verdade, um divisor/rótulo de seção
// (ex.: "Registros com participação encerrada") em vez de um registro real.
// Isso permite lidar com tabelas onde Abertos e Fechados estão no mesmo <table>.
function detectRowSectionStatus(row) {
  const text = normalize(row.textContent || "");
  if (!text) return null;
  if (text.includes(SECOND_TABLE_SECTION_LABEL) || text.includes("encerrad")) return "Fechado";
  if (/\baberto|\babertos|\baberta|\babertas\b/.test(text) && row.querySelectorAll("td,th").length <= 2) {
    return "Aberto";
  }
  return null;
}

function getCandidateTables() {
  // priority: 3 = detecção explícita por rótulo de seção, 2 = seletor principal,
  // 1 = varredura genérica (não deve sobrescrever uma detecção mais específica).
  const tableMap = new Map();

  function setTable(table, status, priority) {
    if (!table) return;
    const previous = tableMap.get(table);
    if (!previous || priority > previous.priority) {
      tableMap.set(table, { status, priority });
    }
  }

  const primaryTable = document.querySelector(TABLE_SELECTOR);
  if (primaryTable) {
    setTable(primaryTable, detectStatusFromContext(primaryTable), 2);
  }

  const labels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,strong,b,legend,label,span,div"));
  for (const label of labels) {
    if (!normalize(label.textContent).includes(SECOND_TABLE_SECTION_LABEL)) continue;
    const container = label.closest("section,article,fieldset,div") || label.parentElement;
    const inContainer = container?.querySelector("table");
    if (inContainer) setTable(inContainer, "Fechado", 3);

    let sibling = label.nextElementSibling;
    while (sibling) {
      if (sibling.tagName === "TABLE") {
        setTable(sibling, "Fechado", 3);
        break;
      }
      const nested = sibling.querySelector?.("table");
      if (nested) {
        setTable(nested, "Fechado", 3);
        break;
      }
      sibling = sibling.nextElementSibling;
    }
  }

  for (const table of document.querySelectorAll("table")) {
    const headerInfo = getHeaderInfo(table);
    if (headerInfo && isSupportedTable(headerInfo.indexMap)) {
      setTable(table, detectStatusFromContext(table), 1);
    }
  }

  return Array.from(tableMap.entries()).map(([table, info]) => ({ table, status: info.status }));
}

function shouldFormatAsMoney(headerName) {
  const key = normalizeHeader(headerName);
  return key.includes("saldo") || key.includes("compra") || key.includes("compras");
}

function parseTableRows(table, initialStatus, pageTournamentName) {
  const headerInfo = getHeaderInfo(table);
  if (!headerInfo || !isSupportedTable(headerInfo.indexMap)) return [];

  const { headerRow, indexMap } = headerInfo;
  const columnTableType = detectTableType(indexMap);
  const tableType = pageTournamentName ? "Torneio" : columnTableType;

  const registroIndex = findIndex(indexMap, ["Registro"]);
  const nomeIndex = findIndex(indexMap, ["Nome"]);
  const gameIDIndex = findIndex(indexMap, ["GameID"]);
  const obsIndex = findIndex(indexMap, ["Obs", "Observacao", "Observação"]);
  const saldoFinalIndex = findIndex(indexMap, ["Saldo/Final", "SaldoFinal", "Saldo Final", "Saldo/Torneio"]);

  let rows = Array.from(table.querySelectorAll("tbody tr"));
  if (!rows.length) rows = Array.from(table.querySelectorAll("tr")).filter((row) => row !== headerRow);

  const results = [];
  let currentStatus = initialStatus;

  for (const row of rows) {
    const sectionStatus = detectRowSectionStatus(row);
    if (sectionStatus) {
      currentStatus = sectionStatus;
      continue; // linha divisória/rótulo, não é um registro
    }

    const cells = Array.from(row.querySelectorAll("td"));
    if (!cells.length) continue;

    const registro = registroIndex >= 0 ? cleanText(cells[registroIndex]?.textContent) : "";
    const nome = nomeIndex >= 0 ? cleanText(cells[nomeIndex]?.textContent) : "";
    const gameID = gameIDIndex >= 0 ? cleanText(cells[gameIDIndex]?.textContent) : "";
    const finalName = stripTrailingIdSuffix(nome || splitName(registro) || registro);
    const saldoFinalRaw = saldoFinalIndex >= 0 ? cleanText(cells[saldoFinalIndex]?.textContent) : "";
    const saldoFinal = formatMoney(saldoFinalRaw);
    const obsCell = obsIndex >= 0 ? cells[obsIndex] : cells[cells.length - 1];

    const trKeys = getCandidateKeysFromElement(row);
    const obsKeys = getCandidateKeysFromElement(obsCell);
    const lookupKeys = buildObsLookupKeys({
      elementKeys: [...trKeys, ...obsKeys],
      registro,
      name: finalName,
      gameID
    });

    const directObs = extractObsFromDomCell(obsCell);
    if (directObs) rememberObs(lookupKeys, directObs);
    const cachedObs = readObsFromCache(lookupKeys);
    const obs = cleanText(directObs || cachedObs);

    const parsedRow = {
      Nome: finalName,
      SaldoFinal: saldoFinal,
      Obs: obs,
      StatusRegistro: applyStatusInversionIfNeeded(currentStatus),
      TipoRegistro: tableType,
      TorneioNome: pageTournamentName || ""
    };

    const hasData = Boolean(parsedRow.Nome || parsedRow.SaldoFinal || parsedRow.Obs);
    if (hasData) results.push(parsedRow);
  }

  return results;
}

function getRows() {
  const pageTournamentName = detectPageTournamentName();
  return getCandidateTables().flatMap(({ table, status }) => parseTableRows(table, status, pageTournamentName));
}

function collectNow() {
  try {
    const rows = getRows();
    latestRows = rows;
  } catch (error) {
    // Nunca deixa uma exceção de parsing (ex.: mudança pontual na estrutura
    // da página) derrubar a coleta silenciosamente nem apagar os dados já
    // coletados anteriormente — mantém latestRows como estava.
    log("Erro ao coletar:", error);
  }
}

function injectPageHook() {
  if (document.getElementById("__pokerExtractorHook")) return;
  const script = document.createElement("script");
  script.id = "__pokerExtractorHook";
  script.src = chrome.runtime.getURL("page-hook.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function handlePageMessages(event) {
  if (event.source !== window) return;
  if (event.data?.type !== "POKER_OBS_DISCOVERED") return;
  const entries = event.data.entries || [];
  for (const entry of entries) {
    if (!entry?.obs) continue;
    const keys = Array.isArray(entry.keys) ? entry.keys : [];
    const lookupKeys = buildObsLookupKeys({ elementKeys: keys });
    rememberObs(lookupKeys, entry.obs);
  }
  collectNow();
  log("Obs cache updated from network:", entries.length);
}

function scheduleCollect() {
  if (collectDebounceTimer) clearTimeout(collectDebounceTimer);
  collectDebounceTimer = setTimeout(() => {
    collectDebounceTimer = null;
    collectNow();
  }, COLLECT_DEBOUNCE_MS);
}

function setupObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => {
    // Página de poker atualiza saldo/status com frequência (polling, timers);
    // sem debounce, cada mutação disparava uma varredura completa do
    // documento (detectPageTournamentName + todas as tabelas), sobrecarregando
    // a aba até a coleta parecer travada.
    scheduleCollect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COLLECT_NOW") return false;
  try {
    collectNow();
    sendResponse({ ok: true, rows: latestRows });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
  return true;
});

window.addEventListener("message", handlePageMessages);
injectPageHook();
collectNow();
setupObserver();
