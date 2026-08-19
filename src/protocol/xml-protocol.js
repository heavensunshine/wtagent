import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ProtocolError } from "../shared/errors.js";
import {
  truncateUtf8HeadTail,
  utf8ByteLength,
} from "../shared/text-budget.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

function stripSingleCodeFence(text) {
  const trimmed = String(text ?? "").trim();
  const match = trimmed.match(/^```(?:xml)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

// Matches the ampersand of a well-formed XML entity: named (&amp;), decimal
// (&#38;), or hex (&#x26;). Anything else is a bare ampersand the model forgot
// to escape or wrap in CDATA.
const VALID_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/y;

// Escapes bare ampersands to &amp; while leaving valid entities and everything
// inside CDATA sections untouched. Unescaped `&` (e.g. "Tom & Jerry", query
// strings like "a=1&b=2", "R&D") is the most common reason ChatGPT Web's XML
// fails strict parsing, and repairing it is always safe: a bare `&` is never
// legal XML, so this cannot change the meaning of otherwise-valid markup.
function escapeBareAmpersands(text) {
  let out = "";
  let index = 0;
  const cdataOpen = "<![CDATA[";
  const cdataClose = "]]>";

  while (index < text.length) {
    const char = text[index];
    if (char === "<" && text.startsWith(cdataOpen, index)) {
      const close = text.indexOf(cdataClose, index + cdataOpen.length);
      const end = close < 0 ? text.length : close + cdataClose.length;
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "&") {
      VALID_ENTITY.lastIndex = index;
      if (VALID_ENTITY.test(text)) {
        out += text.slice(index, VALID_ENTITY.lastIndex);
        index = VALID_ENTITY.lastIndex;
      } else {
        out += "&amp;";
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function extractEnvelope(text) {
  const cleaned = stripSingleCodeFence(text);
  const start = cleaned.indexOf("<agent_response");
  const endTag = "</agent_response>";
  const end = cleaned.lastIndexOf(endTag);

  if (start < 0 || end < 0 || end < start) {
    throw new ProtocolError(
      "Response must contain one complete <agent_response> envelope.",
      { details: { raw: cleaned } },
    );
  }

  // ChatGPT Web may prepend a preamble (e.g. "Sure, here is the response:")
  // or append trailing text / render rich cards around the XML. We only care
  // about the envelope itself, so surrounding text is stripped instead of
  // being treated as a protocol violation.
  return cleaned.slice(start, end + endTag.length);
}

function normalizeXmlValue(value) {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(normalizeXmlValue);
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const keys = Object.keys(value);
  const textKeys = keys.filter((key) => key === "#text" || key === "#cdata");
  const contentKeys = keys.filter(
    (key) => key !== "#text" && key !== "#cdata",
  );
  if (textKeys.length === keys.length) {
    return textKeys.map((key) => String(value[key] ?? "")).join("");
  }

  if (
    contentKeys.length === 1
    && ["item", "string", "arg"].includes(contentKeys[0])
  ) {
    const listValue = value[contentKeys[0]];
    const items = Array.isArray(listValue) ? listValue : [listValue];
    return items.map(normalizeXmlValue);
  }

  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "#text" || key === "#cdata") {
      continue;
    }
    normalized[key] = normalizeXmlValue(child);
  }
  return normalized;
}

function scalarText(value) {
  const normalized = normalizeXmlValue(value);
  if (typeof normalized === "string") {
    return normalized.trim();
  }
  return "";
}

function parseDone(value) {
  const text = scalarText(value).toLowerCase();
  if (text !== "true" && text !== "false") {
    throw new ProtocolError("<done> must be true or false.");
  }
  return text === "true";
}

// Reads a single element's inner text by regex, tolerating attributes on the
// tag and CDATA inside it. Used only by the recovery path below.
function looseTagText(xml, tag) {
  const match = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,
    "i",
  ).exec(xml);
  if (!match) {
    return null;
  }
  let inner = match[1];
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner);
  if (cdata) {
    return cdata[1].trim();
  }
  // Strip any stray tags the model may have left inside the message, then
  // decode the handful of entities that matter for display.
  return inner
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();
}

// Last-resort recovery when strict parsing fails. It ONLY salvages a
// conversational, message-only answer — a response that carries <done> and
// <message> but no tool request. Tool calls are never recovered this way:
// guessing the arguments of a side-effecting operation from broken XML is
// unsafe, so those still fall through to a format retry.
function recoverMessageOnlyResponse(envelope) {
  if (/<tool_call[s]?[\s>]/i.test(envelope)) {
    return null;
  }
  const doneText = looseTagText(envelope, "done");
  const message = looseTagText(envelope, "message");
  if (doneText == null || message == null) {
    return null;
  }
  const done = doneText.trim().toLowerCase();
  if (done !== "true" && done !== "false") {
    return null;
  }
  if (done === "true" && !message.trim()) {
    return null;
  }
  return {
    done: done === "true",
    message,
    toolCall: null,
    toolCalls: [],
    raw: envelope,
    recovered: true,
  };
}

function parseToolCall(rawToolCall) {
  if (typeof rawToolCall !== "object" || Array.isArray(rawToolCall)) {
    throw new ProtocolError("<tool_call> must contain a name and args.");
  }

  const name = String(rawToolCall.name ?? "").trim();
  if (!name) {
    throw new ProtocolError("<tool_call> is missing the name attribute.");
  }

  const normalizedArgs = normalizeXmlValue(
    rawToolCall.args ?? rawToolCall.arguments ?? {},
  );
  return {
    id: String(rawToolCall.id ?? "").trim() || null,
    name,
    args: typeof normalizedArgs === "string" && !normalizedArgs.trim()
      ? {}
      : normalizedArgs,
  };
}

function parseToolCalls(response) {
  const direct = response.tool_call == null || response.tool_call === ""
    ? []
    : Array.isArray(response.tool_call)
      ? response.tool_call
      : [response.tool_call];

  let wrapped = [];
  if (response.tool_calls != null && response.tool_calls !== "") {
    if (
      typeof response.tool_calls !== "object"
      || Array.isArray(response.tool_calls)
    ) {
      throw new ProtocolError("<tool_calls> must contain <tool_call> elements.");
    }
    const rawWrapped = response.tool_calls.tool_call;
    if (rawWrapped != null && rawWrapped !== "") {
      wrapped = Array.isArray(rawWrapped) ? rawWrapped : [rawWrapped];
    }
  }

  if (direct.length > 0 && wrapped.length > 0) {
    throw new ProtocolError(
      "Use either direct <tool_call> elements or one <tool_calls> wrapper, not both.",
    );
  }

  const toolCalls = (wrapped.length > 0 ? wrapped : direct).map(parseToolCall);
  const explicitIds = toolCalls
    .map((toolCall) => toolCall.id)
    .filter(Boolean);
  if (new Set(explicitIds).size !== explicitIds.length) {
    throw new ProtocolError("Explicit tool call ids must be unique within a turn.");
  }
  return toolCalls;
}

export function parseAgentResponse(rawText) {
  const rawEnvelope = extractEnvelope(rawText);

  const structuralXml = rawEnvelope.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>/g,
    "<![CDATA[]]>",
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(structuralXml)) {
    throw new ProtocolError("DTD and XML entities are not allowed.");
  }

  // Repair the single most common corruption first: bare ampersands the model
  // wrote outside CDATA. This is done before validation so an otherwise
  // well-formed envelope with a stray "&" parses instead of triggering a retry.
  const envelope = escapeBareAmpersands(rawEnvelope);

  const validation = XMLValidator.validate(envelope);
  if (validation !== true) {
    const recovered = recoverMessageOnlyResponse(envelope);
    if (recovered) {
      return recovered;
    }
    throw new ProtocolError(
      `Invalid XML: ${validation.err?.msg ?? "unknown XML error"}`,
      { details: validation },
    );
  }

  let parsed;
  try {
    parsed = parser.parse(envelope);
  } catch (error) {
    const recovered = recoverMessageOnlyResponse(envelope);
    if (recovered) {
      return recovered;
    }
    throw new ProtocolError(`Invalid XML: ${error.message}`, { cause: error });
  }

  const response = parsed.agent_response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new ProtocolError("Missing <agent_response> root.");
  }

  const done = parseDone(response.done);
  const message = scalarText(response.message);
  const toolCalls = parseToolCalls(response);
  const toolCall = toolCalls.length === 1 ? toolCalls[0] : null;

  if (done && toolCalls.length > 0) {
    throw new ProtocolError(
      "A completed response cannot also request a tool. Use done=false.",
    );
  }

  return {
    done,
    message,
    toolCall,
    toolCalls,
    raw: envelope,
  };
}

export function escapeXmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeXmlAttribute(value) {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function cdata(value) {
  const safe = String(value ?? "").replaceAll("]]>", "]]]]><![CDATA[>");
  return `<![CDATA[${safe}]]>`;
}

function optionalResultField(tag, field) {
  if (field == null || (field.text === "" && !field.truncated)) {
    return "";
  }
  const attributes = field.truncated
    ? ` truncated="true" original_bytes="${field.originalBytes}" included_bytes="${field.includedBytes}"`
    : "";
  return `\n  <${tag}${attributes}>${cdata(field.text)}</${tag}>`;
}

function normalizeResultFields(result) {
  const data = result.data == null
    ? ""
    : typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data);
  const field = (value) => {
    const text = String(value ?? "");
    const bytes = utf8ByteLength(text);
    return {
      text,
      truncated: false,
      originalBytes: bytes,
      includedBytes: bytes,
    };
  };
  return {
    message: field(result.message),
    stdout: field(result.stdout),
    stderr: field(result.stderr),
    data: field(data),
  };
}

function serializeResultFields(
  result,
  fields,
  { originalBytes = null, includeId = false } = {},
) {
  const status = result.ok ? "ok" : "error";
  const wasTruncated = Object.values(fields).some((field) => field.truncated);
  const truncationAttributes = wasTruncated
    ? ` truncated="true" original_bytes="${originalBytes}"`
    : "";
  const id = result.requestId ?? result.callId;
  const idAttribute = includeId && id
    ? ` id="${escapeXmlAttribute(id)}"`
    : "";

  return [
    `<tool_result${idAttribute} name="${escapeXmlAttribute(result.name)}"`,
    ` status="${status}"${truncationAttributes}>`,
    `\n  <message>${cdata(fields.message.text)}</message>`,
    optionalResultField("stdout", fields.stdout),
    optionalResultField("stderr", fields.stderr),
    optionalResultField("data", fields.data),
    "\n</tool_result>",
  ].join("");
}

function serializeToolResultInternal(
  result,
  { maxBytes = Infinity, includeId = false } = {},
) {
  const fields = normalizeResultFields(result);
  let xml = serializeResultFields(result, fields, { includeId });
  if (!Number.isFinite(maxBytes) || utf8ByteLength(xml) <= maxBytes) {
    return xml;
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) {
    throw new RangeError("Tool result XML budget must be at least 512 bytes.");
  }

  const originalBytes = utf8ByteLength(xml);
  let remaining = Math.max(0, maxBytes - 1024);
  for (const [name, fieldLimit] of [
    ["message", 2 * 1024],
    ["stderr", 4 * 1024],
    ["stdout", 4 * 1024],
    ["data", Infinity],
  ]) {
    const field = fields[name];
    const budget = Math.min(field.originalBytes, fieldLimit, remaining);
    fields[name] = truncateUtf8HeadTail(field.text, budget);
    remaining -= fields[name].includedBytes;
  }

  xml = serializeResultFields(result, fields, { originalBytes, includeId });
  for (let pass = 0; pass < 8 && utf8ByteLength(xml) > maxBytes; pass += 1) {
    const excess = utf8ByteLength(xml) - maxBytes;
    const candidate = Object.entries(fields)
      .filter(([, field]) => field.includedBytes > 0)
      .sort((left, right) => right[1].includedBytes - left[1].includedBytes)[0];
    if (!candidate) break;
    const [name, field] = candidate;
    const nextBudget = Math.max(0, field.includedBytes - excess - 64);
    fields[name] = truncateUtf8HeadTail(
      normalizeResultFields(result)[name].text,
      nextBudget,
    );
    xml = serializeResultFields(result, fields, { originalBytes, includeId });
  }

  if (utf8ByteLength(xml) > maxBytes) {
    throw new RangeError(`Unable to fit tool result within ${maxBytes} bytes.`);
  }
  return xml;
}

export function serializeToolResult(result, { maxBytes = Infinity } = {}) {
  return serializeToolResultInternal(result, { maxBytes, includeId: false });
}

export function serializeToolResults(results, { maxBytes = Infinity } = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new TypeError("serializeToolResults requires at least one result.");
  }

  const wrap = (children) => `<tool_results>\n${children.join("\n")}\n</tool_results>`;
  let xml = wrap(results.map((result) => serializeToolResultInternal(
    result,
    { includeId: true },
  )));
  if (!Number.isFinite(maxBytes) || utf8ByteLength(xml) <= maxBytes) {
    return xml;
  }

  const emptyWrapperBytes = utf8ByteLength(wrap(Array(results.length).fill("")));
  const available = maxBytes - emptyWrapperBytes;
  const perResultBudget = Math.floor(available / results.length);
  if (perResultBudget < 512) {
    throw new RangeError(
      `Tool results XML budget must allow at least 512 bytes per result; received ${maxBytes} bytes for ${results.length} results.`,
    );
  }

  xml = wrap(results.map((result) => serializeToolResultInternal(
    result,
    { maxBytes: perResultBudget, includeId: true },
  )));
  if (utf8ByteLength(xml) > maxBytes) {
    throw new RangeError(`Unable to fit tool results within ${maxBytes} bytes.`);
  }
  return xml;
}

export function serializeProtocolError(error) {
  return [
    "<protocol_error>",
    cdata(error.message),
    "</protocol_error>",
  ].join("");
}
