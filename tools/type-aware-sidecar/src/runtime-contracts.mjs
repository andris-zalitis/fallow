import { createHash } from "node:crypto";

export const runtimeEntryWire = ({ symbol, origin }) => ({
  symbol: {
    path: symbol.path,
    namespace: symbol.namespace,
    declaration_kind: symbol.declarationKind,
    exported_name: symbol.exportedName,
    local_name: symbol.localName,
    ...(symbol.owner === null ? {} : { owner: symbol.owner }),
    line: symbol.line,
    col: symbol.col,
  },
  origin,
});

export const runtimeEntryKey = ({ symbol, origin }) =>
  JSON.stringify([
    symbol.path,
    symbol.namespace,
    symbol.declarationKind,
    symbol.exportedName,
    symbol.localName,
    symbol.owner,
    symbol.line,
    symbol.col,
    origin,
  ]);

export const runtimeEntryDigest = (entries) => {
  const identities = [...new Set(entries.map(runtimeEntryKey))].toSorted((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
};
